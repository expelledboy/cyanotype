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

/** Test-facing event bus. Typed against the Blueprint's catalog. */
export type EventBus<Cat extends EventCatalog> = {
  readonly waitFor: <K extends keyof Cat & string>(
    name: K,
    filter?: EventFilter<Cat, K>,
    timeoutMs?: number,
  ) => Promise<Event<Cat, K>>;

  readonly collect: <K extends keyof Cat & string>(
    name?: K,
  ) => readonly Event<Cat, K>[];

  /**
   * Wait for an ordered subsequence of events. Returns the matched events
   * in order. Used for cause→effect assertions.
   */
  readonly expectSequence: (
    names: readonly (keyof Cat & string)[],
    timeoutMs?: number,
  ) => Promise<readonly Event<Cat>[]>;
};

export type EventFilter<
  Cat extends EventCatalog,
  K extends keyof Cat & string,
> = {
  readonly attributes?: Partial<AttributesOf<Cat[K]>>;
  readonly instance?: string;
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
  const events: Event<Cat>[] = [];

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
    events.push(evt);
  };

  const clear = (): void => {
    events.length = 0;
  };

  const collect = <K extends keyof Cat & string>(
    name?: K,
  ): readonly Event<Cat, K>[] => {
    return events.filter((e) => !name || e.name === name) as unknown as readonly Event<Cat, K>[];
  };

  const waitFor = async <K extends keyof Cat & string>(
    name: K,
    filter?: EventFilter<Cat, K>,
    timeoutMs = 10_000,
  ): Promise<Event<Cat, K>> => {
    const start = Date.now();
    while (true) {
      const found = events.find((e) => eventMatches(e, name, filter));
      if (found) return found as Event<Cat, K>;
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        throw {
          kind: "wait_for_timeout",
          eventName: name,
          filter,
          elapsedMs,
          candidates: events.filter((e) => e.name === name).slice(-3),
        };
      }
      await sleep(100);
    }
  };

  const expectSequence = async (
    names: readonly (keyof Cat & string)[],
    timeoutMs = 10_000,
  ): Promise<readonly Event<Cat>[]> => {
    const start = Date.now();
    while (true) {
      const relevant = events.filter((e) => names.includes(e.name));
      let idx = 0;
      const matched: Event<Cat>[] = [];
      for (const e of relevant) {
        if (e.name === names[idx]) {
          matched.push(e);
          idx += 1;
          if (idx === names.length) return matched;
        }
      }
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        throw {
          kind: "sequence_timeout",
          names,
          elapsedMs,
          seen: relevant.map((e) => e.name),
        };
      }
      await sleep(100);
    }
  };

  return {
    bus: { waitFor, collect, expectSequence },
    ingest,
    clear,
  };
};
