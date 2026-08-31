/**
 * Probe — readiness / health check.
 *
 * Declared on the **Blueprint**, not the Binding. Readiness is part of the
 * contract a Binding must satisfy: the same probe runs against the real
 * Docker image and the in-process simulator. Both must come up cleanly
 * before tests proceed.
 *
 * Two cases:
 *   - HTTP: poll a path on a declared interface, expect a status range.
 *     The `interfaceName` is typed against the Blueprint's interface record,
 *     so typos error at compile time.
 *   - Custom: run an async predicate with access to the resolved interface
 *     record (so e.g. Redis can TCP-connect to verify readiness).
 *
 * HTTP probes cover the common case; custom probes cover protocols without
 * a status-code-shaped readiness signal.
 */

import type { InterfaceRecord } from "./interface.js";
import type { Emit } from "./observer.js";

export type Probe<I extends InterfaceRecord = InterfaceRecord> =
  | HttpProbe<I>
  | CustomProbe<I>;

export type HttpProbe<I extends InterfaceRecord = InterfaceRecord> = {
  readonly kind: "http";
  /** Which declared interface to probe. Typed against the service's interface keys. */
  readonly interfaceName: keyof I & string;
  readonly path: string;
  readonly statusMin?: number;
  readonly statusMax?: number;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
};

export type CustomProbe<I extends InterfaceRecord = InterfaceRecord> = {
  readonly kind: "custom";
  /**
   * Predicate. Receives the resolved interface record; the runtime polls
   * until this returns true or `timeoutMs` elapses.
   *
   * Returning `false` retries with a generic reason. To surface *which*
   * sub-check failed on the observer's `probe.attempt` event, `throw` a
   * tagged error instead — `throw { kind: "zero_ping_failed" }` — its `kind`
   * is carried through as the attempt's error.
   *
   * Method syntax (bivariant params) — see `Blueprint.interface` note for
   * why this matters for `Blueprint<..., SpecificIface, ...>` to fit into
   * the wider `Probe<InterfaceRecord>` constraint via Environment's slot.
   */
  check(iface: I): Promise<boolean>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
};

// ============================================================
// Runtime — fixed-interval polling. The timeout error carries the
// last underlying error from the failing attempt for diagnosis.
// ============================================================

export const runProbe = async <I extends InterfaceRecord>(
  probe: Probe<I>,
  iface: I,
  signal?: AbortSignal,
  emit?: Emit,
): Promise<void> => {
  const intervalMs = probe.intervalMs ?? 1000;
  const timeoutMs = probe.timeoutMs ?? 30_000;
  const start = Date.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let lastError: unknown;
  let attempts = 0;

  emit?.({ type: "probe.started", probeKind: probe.kind, timeoutMs, intervalMs });

  while (Date.now() - start < timeoutMs && !signal?.aborted) {
    attempts += 1;
    try {
      if (probe.kind === "http") {
        const target = iface[probe.interfaceName];
        if (!target) throw new Error(`probe interface not found: ${probe.interfaceName}`);
        const url = `${target.uri}${probe.path}`;
        const attemptMs = Math.min(intervalMs, 5000);
        const ac = new AbortController();
        const onParentAbort = () => ac.abort();
        if (signal) signal.addEventListener("abort", onParentAbort, { once: true });
        const timer = setTimeout(() => ac.abort(), attemptMs);
        try {
          const res = await fetch(url, { signal: ac.signal });
          const min = probe.statusMin ?? 200;
          const max = probe.statusMax ?? 499;
          if (res.status >= min && res.status <= max) {
            emit?.({ type: "probe.ready", attempts, elapsedMs: Date.now() - start });
            return;
          }
          throw new Error(`http probe status not acceptable: ${res.status}`);
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onParentAbort);
        }
      } else {
        const ok = await probe.check(iface);
        if (ok === true) {
          emit?.({ type: "probe.ready", attempts, elapsedMs: Date.now() - start });
          return;
        }
        throw new Error("custom probe returned false");
      }
    } catch (e) {
      lastError = e;
      emit?.({ type: "probe.attempt", attempt: attempts, elapsedMs: Date.now() - start, error: e });
      if (signal?.aborted) break;
      await sleep(intervalMs);
    }
  }

  if (signal?.aborted) {
    throw { kind: "probe_aborted", probe, elapsedMs: Date.now() - start, attempts };
  }
  emit?.({ type: "probe.timed_out", attempts, elapsedMs: Date.now() - start, error: lastError });
  throw { kind: "probe_timeout", probe, lastError, elapsedMs: Date.now() - start, attempts };
};
