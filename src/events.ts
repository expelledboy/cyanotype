/**
 * Events — typed log catalog and per-component event bus.
 *
 * Half of the Blueprint contract (the other half is the API schemas in
 * `protocol.ts`). The Blueprint declares an `events` catalog: a record of
 * event names to Zod schemas describing their attribute shapes. The
 * Binding's `logParser` turns raw stdout lines from that specific Binding
 * into events that must conform to the catalog — so a real Docker image
 * and an in-process simulator can emit different raw log formats but
 * produce the same typed events to the same bus.
 *
 * Tests use a per-component event bus — no global merged catalog. Each
 * component's `runtime.X.events.waitFor("EVENT_NAME", filter, timeoutMs)`
 * returns a typed Event whose attributes are inferred from the catalog
 * entry. Cross-component composition is `Promise.race(...)` over per-
 * component buses: verbose for the rare case, type-safe for the common
 * one (no silent name collisions across components).
 */

import type { z } from "zod";
import { invariant } from "./invariants.js";

/** A blueprint declares one of these per event it emits. */
export type EventSchema = z.ZodTypeAny;

/** Map of event name → attribute schema. */
export type EventCatalog = Record<string, EventSchema>;

/** Infer the runtime attribute shape from a catalog entry. */
export type AttributesOf<S extends EventSchema> = z.infer<S>;

/**
 * A typed runtime event. `K` is the event name (literal key of the catalog);
 * `attributes` is typed to that key's schema.
 */
export type Event<
  Cat extends EventCatalog = EventCatalog,
  K extends keyof Cat & string = keyof Cat & string,
> = {
  readonly name: K;
  readonly attributes: AttributesOf<Cat[K]>;
  readonly occurredAt: string; // ISO 8601
  readonly component: string;
  readonly instance?: string;
};

/**
 * A position in a component's event stream, from `bus.mark()`.
 *
 * Opaque on purpose: the only valid ways to obtain one are `mark()` and the
 * `FROM_START` constant. The sequence it wraps is monotonic for the life of
 * the bus and is NOT reset by `clear()`, so a checkpoint taken before a chaos
 * restart stays in the past afterwards rather than silently addressing a
 * different event.
 */
export type EventCheckpoint = { readonly seq: number };

/**
 * The beginning of the stream — the explicit opt-in to scanning everything
 * buffered so far. `waitFor` defaults to "from now", so reaching back over
 * history is something a test states rather than something it inherits.
 */
export const FROM_START: EventCheckpoint = Object.freeze({ seq: 0 });

/** Test-facing event bus. Typed against the Blueprint's catalog. */
export type EventBus<Cat extends EventCatalog> = {
  /** Current stream position, for `waitFor(..., { after })`. */
  readonly mark: () => EventCheckpoint;

  /**
   * Wait for a matching event.
   *
   * Waits from the CURRENT stream position by default: an event that arrived
   * before this call does not satisfy it. Pass `filter.after` (a `mark()`, or
   * `FROM_START`) to widen the window. The default exists because a shared
   * environment outlives a single test, and an implicit history scan lets an
   * earlier call's event satisfy a later assertion.
   */
  readonly waitFor: <K extends keyof Cat & string>(
    name: K,
    filter?: EventFilter<Cat, K>,
    timeoutMs?: number,
  ) => Promise<Event<Cat, K>>;

  /** Everything buffered, oldest first. Unlike `waitFor`, defaults to the whole buffer. */
  readonly collect: <K extends keyof Cat & string>(
    name?: K,
    window?: EventWindow,
  ) => readonly Event<Cat, K>[];

  /**
   * Wait for an ordered subsequence of events. Returns the matched events
   * in order. Used for cause→effect assertions. Same "from now" default as
   * `waitFor`; widen with `{ after }`, spelled the same way as on `waitFor`.
   */
  readonly expectSequence: (
    names: readonly (keyof Cat & string)[],
    timeoutMs?: number,
    window?: EventWindow,
  ) => Promise<readonly Event<Cat>[]>;
};

/**
 * Where in the stream to start looking. Not a predicate over events — it
 * bounds the search, it does not decide what matches. `waitFor` accepts it
 * inline on its filter; `expectSequence`, which has no filter, takes it as
 * its own argument.
 */
export type EventWindow = {
  readonly after?: EventCheckpoint;
};

export type EventFilter<
  Cat extends EventCatalog,
  K extends keyof Cat & string,
> = {
  readonly attributes?: Partial<AttributesOf<Cat[K]>>;
  readonly instance?: string;
  /**
   * Search window, not a match predicate — see `EventWindow`. Defaults to the
   * stream position at the `waitFor` call, so an event that arrived earlier
   * does not satisfy the wait.
   */
  readonly after?: EventCheckpoint;
};

/**
 * Log parser — provided per Binding.
 *
 * Reads one log line, returns one parsed event or null. The returned event's
 * `name` and `attributes` must conform to the Blueprint's event catalog; the
 * orchestrator validates against the catalog at ingest time and stamps
 * `component`/`instance`/`occurredAt` itself.
 */
export type LogParser = (line: string) => ParsedEvent | null;

export type ParsedEvent = {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly occurredAt?: string;
};

// ============================================================
// Runtime — per-component bus.
// ============================================================

export type EventBusInternals<Cat extends EventCatalog> = {
  readonly bus: EventBus<Cat>;
  /** Orchestrator calls this from log-parser output. Validates against catalog. */
  readonly ingest: (e: ParsedEvent, meta: { component: string; instance?: string }) => void;
  /** Clear all buffered events. Called by orchestrator on component restart. */
  readonly clear: () => void;
};

const attributeMatches = (filterVal: unknown, actual: unknown): boolean => {
  if (typeof filterVal === "function") {
    return Boolean((filterVal as (v: unknown) => unknown)(actual));
  }
  if (filterVal instanceof RegExp) {
    return filterVal.test(String(actual));
  }
  return filterVal === actual;
};

const eventMatches = <Cat extends EventCatalog, K extends keyof Cat & string>(
  evt: Event<Cat>,
  name: K,
  filter?: EventFilter<Cat, K>,
): boolean => {
  if (evt.name !== name) return false;
  if (!filter) return true;
  if (filter.instance !== undefined && evt.instance !== filter.instance) return false;
  if (filter.attributes) {
    const attrs = evt.attributes as Record<string, unknown>;
    for (const [k, v] of Object.entries(filter.attributes)) {
      if (!attributeMatches(v, attrs[k])) return false;
    }
  }
  return true;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const createEventBus = <Cat extends EventCatalog>(
  catalog: Cat,
): EventBusInternals<Cat> => {
  type Slot = { readonly seq: number; readonly evt: Event<Cat> };
  const events: Slot[] = [];
  // Monotonic for the life of the bus. Deliberately NOT reset by `clear()`:
  // an index into the array would make a checkpoint taken before a chaos
  // restart address an unrelated event afterwards.
  let lastSeq = 0;

  const mark = (): EventCheckpoint => ({ seq: lastSeq });

  const ingest = (
    parsed: ParsedEvent,
    meta: { component: string; instance?: string },
  ): void => {
    const schema = catalog[parsed.name];
    if (!schema) {
      console.error(`[events] dropping unknown event "${parsed.name}"`);
      return;
    }
    // schema is z.ZodTypeAny; safeParse on the union type is awkward to narrow.
    const result = (schema as z.ZodTypeAny).safeParse(parsed.attributes);
    if (!result.success) {
      console.error(
        `[events] dropping invalid event "${parsed.name}": ${result.error.message}`,
      );
      return;
    }
    const evt = {
      name: parsed.name as keyof Cat & string,
      attributes: result.data,
      occurredAt: parsed.occurredAt ?? new Date().toISOString(),
      component: meta.component,
      ...(meta.instance !== undefined ? { instance: meta.instance } : {}),
    } as Event<Cat>;
    const previous = lastSeq;
    lastSeq += 1;
    // I7: `clear()` empties the buffer but must NOT reset this counter. If it
    // did, a checkpoint taken before a chaos restart would silently address an
    // unrelated event afterwards — a wrong pass, not a failure.
    invariant( () => lastSeq > previous, "event sequence is strictly increasing",
      () => ({ previous, next: lastSeq, name: evt.name }));
    events.push({ seq: lastSeq, evt });
  };

  const clear = (): void => {
    events.length = 0;
  };

  const collect = <K extends keyof Cat & string>(
    name?: K,
    window?: EventWindow,
  ): readonly Event<Cat, K>[] => {
    const from = window?.after?.seq ?? 0;
    return events
      .filter((e) => e.seq > from && (!name || e.evt.name === name))
      .map((e) => e.evt) as unknown as readonly Event<Cat, K>[];
  };

  const waitFor = async <K extends keyof Cat & string>(
    name: K,
    filter?: EventFilter<Cat, K>,
    timeoutMs = 10_000,
  ): Promise<Event<Cat, K>> => {
    const start = Date.now();
    const from = filter?.after?.seq ?? lastSeq;
    while (true) {
      const found = events.find((e) => e.seq > from && eventMatches(e.evt, name, filter));
      if (found) return found.evt as Event<Cat, K>;
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        const sameName = events.filter((e) => e.evt.name === name);
        throw {
          kind: "wait_for_timeout",
          eventName: name,
          filter,
          elapsedMs,
          after: from,
          candidates: sameName.filter((e) => e.seq > from).slice(-3).map((e) => e.evt),
          // Distinguishes "never emitted" from "emitted before you waited" —
          // the failure mode the from-now default introduces.
          beforeCheckpoint: sameName.filter((e) => e.seq <= from).length,
          hint:
            sameName.length === 0
              ? `No "${name}" event was ingested at all. Either the component never emitted it, ` +
                `or the Binding's logParser did not map the log line onto that catalog name — ` +
                `check the parser against a raw line from this component.`
              : sameName.filter((e) => e.seq > from).length === 0
                ? `"${name}" WAS ingested, but only before this wait began. waitFor matches ` +
                  `events ingested after the call, so build the promise BEFORE the action that ` +
                  `triggers it, or pass { after: FROM_START } to scan buffered history.`
                : `"${name}" arrived but no event matched the filter. See candidates for the ` +
                  `most recent ones; compare their attributes against what you filtered on.`,
        };
      }
      await sleep(100);
    }
  };

  const expectSequence = async (
    names: readonly (keyof Cat & string)[],
    timeoutMs = 10_000,
    window?: EventWindow,
  ): Promise<readonly Event<Cat>[]> => {
    const start = Date.now();
    const from = window?.after?.seq ?? lastSeq;
    while (true) {
      const relevant = events.filter((e) => e.seq > from && names.includes(e.evt.name));
      let idx = 0;
      const matched: Event<Cat>[] = [];
      for (const e of relevant) {
        if (e.evt.name === names[idx]) {
          matched.push(e.evt);
          idx += 1;
          if (idx === names.length) return matched;
        }
      }
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        throw {
          kind: "sequence_timeout",
          hint:
            `expectSequence waits for the names in order, matching only events ingested after ` +
            `the call. Register it BEFORE the action that produces the sequence, or pass ` +
            `{ after: FROM_START } to include already-buffered events. "matched" shows how far ` +
            `it got — the name after that is the one that never arrived.`,
          names,
          elapsedMs,
          after: from,
          seen: relevant.map((e) => e.evt.name),
        };
      }
      await sleep(100);
    }
  };

  return {
    bus: { mark, waitFor, collect, expectSequence },
    ingest,
    clear,
  };
};
