/**
 * Observer — the framework lifecycle event stream.
 *
 * A second, separate event channel, distinct from `EventBus<Cat>` (`events.ts`):
 *
 *   - `EventBus<Cat>` is typed per Blueprint, owned by a component, and
 *     asserted on by tests. It only exists once a container is up and
 *     streaming logs. It models the *domain events of the system under test*.
 *
 *   - The observer stream is cross-cutting *framework telemetry* — substrate
 *     connection, image pull, container provisioning, readiness polling,
 *     teardown, chaos. It is owned by the orchestrator + adapters and consumed
 *     by a reporter (terminal progress, CI annotations, timing dumps). It
 *     answers "why is provisioning slow / where is the time going".
 *
 * Opt-in and additive: pass `observer` on `OrchestratorOptions`. With no
 * observer, `createEmitter` returns a no-op `Emit` and the cost is zero —
 * today's silent behaviour is preserved exactly.
 *
 * Emitters (orchestrator, adapters, `runProbe`) only produce the
 * discriminated `ObserverEventData`. The envelope (`seq`, `at`, `adapter`,
 * `component`, `instance`, `envKey`) is stamped centrally by `createEmitter`
 * so `seq` is a stable monotonic total order across every scoped emitter.
 */

/** Envelope stamped onto every event by `createEmitter`. */
export type ObserverEnvelope = {
  /** Monotonic counter — stable total order across all scoped emitters. */
  readonly seq: number;
  /** ISO 8601 timestamp. */
  readonly at: string;
  /** Adapter name (`"docker"`, `"memory"`, `"k8s"`). */
  readonly adapter: string;
  readonly envKey?: string;
  readonly component?: string;
  readonly instance?: string;
};

/**
 * The framework lifecycle event catalog. Discriminated on `type`. Six phases:
 * substrate connection, image acquisition, container provisioning, readiness,
 * environment rollup, and chaos.
 */
export type ObserverEventData =
  // ── Substrate connection ────────────────────────────────────────────
  | { readonly type: "substrate.connecting"; readonly target?: string }
  | { readonly type: "substrate.connected"; readonly latencyMs: number }
  | { readonly type: "substrate.connect_failed"; readonly error: unknown }
  // ── Image acquisition ───────────────────────────────────────────────
  | { readonly type: "image.resolving"; readonly image: string }
  | { readonly type: "image.cache_hit"; readonly image: string }
  | { readonly type: "image.pull_started"; readonly image: string }
  | {
      readonly type: "image.pull_progress";
      readonly image: string;
      readonly layerId?: string;
      readonly status: string;
      readonly current?: number;
      readonly total?: number;
      readonly percent?: number;
    }
  | { readonly type: "image.pulled"; readonly image: string; readonly durationMs: number }
  | { readonly type: "image.pull_failed"; readonly image: string; readonly error: unknown }
  // ── Container provisioning ──────────────────────────────────────────
  | { readonly type: "container.creating"; readonly image: string }
  | { readonly type: "container.created"; readonly containerId: string }
  | { readonly type: "container.starting"; readonly containerId: string }
  | {
      readonly type: "container.started";
      readonly containerId: string;
      readonly ports: Readonly<Record<string, number>>;
    }
  | { readonly type: "container.start_failed"; readonly image: string; readonly error: unknown }
  | { readonly type: "container.stopping"; readonly containerId: string }
  | { readonly type: "container.stopped"; readonly containerId: string }
  // ── Readiness ───────────────────────────────────────────────────────
  | {
      readonly type: "probe.started";
      readonly probeKind: "http" | "custom";
      readonly timeoutMs: number;
      readonly intervalMs: number;
    }
  | {
      readonly type: "probe.attempt";
      readonly attempt: number;
      readonly elapsedMs: number;
      readonly error: unknown;
    }
  | { readonly type: "probe.ready"; readonly attempts: number; readonly elapsedMs: number }
  | {
      readonly type: "probe.timed_out";
      readonly attempts: number;
      readonly elapsedMs: number;
      readonly error: unknown;
    }
  // ── Environment rollup ──────────────────────────────────────────────
  | { readonly type: "environment.starting"; readonly componentCount: number }
  | {
      readonly type: "environment.component_ready";
      readonly done: number;
      readonly total: number;
      readonly durationMs: number;
    }
  | { readonly type: "environment.ready"; readonly durationMs: number }
  | { readonly type: "environment.failed"; readonly phase: string; readonly error: unknown }
  // ── Chaos ───────────────────────────────────────────────────────────
  | { readonly type: "chaos.stopping" }
  | { readonly type: "chaos.stopped" }
  | { readonly type: "chaos.starting" }
  | { readonly type: "chaos.started" }
  // ── Compose stack reconciliation ────────────────────────────────────
  | { readonly type: "stack.checking"; readonly stackName: string }
  | { readonly type: "stack.fresh"; readonly stackName: string }
  | {
      readonly type: "stack.stale";
      readonly stackName: string;
      /** Which fingerprint fields differ (e.g. `["image", "env"]`). */
      readonly changedFields: readonly string[];
    }
  | { readonly type: "stack.rebuilding"; readonly stackName: string }
  | { readonly type: "stack.rebuilt"; readonly stackName: string; readonly durationMs: number }
  | { readonly type: "stack.attached"; readonly stackName: string; readonly serviceCount: number }
  | { readonly type: "stack.failed"; readonly stackName: string; readonly error: unknown };

/** A fully-formed observer event: catalog entry + stamped envelope. */
export type ObserverEvent = ObserverEventData & ObserverEnvelope;

/** Consumer-facing sink. Pass one on `OrchestratorOptions.observer`. */
export type Observer = (event: ObserverEvent) => void;

/** What emitters call — the envelope is added by `createEmitter`. */
export type Emit = (event: ObserverEventData) => void;

/**
 * Identity an `Emit` is bound to. `seq`/`at` are added per-call. The optional
 * fields admit `undefined` explicitly so callers can forward a possibly-unset
 * `instanceId` without a conditional (the envelope drops `undefined` keys).
 */
export type EmitScope = {
  readonly adapter: string;
  readonly envKey?: string | undefined;
  readonly component?: string | undefined;
  readonly instance?: string | undefined;
};

/**
 * Wrap an `Observer` into a factory of scoped `Emit` functions. Every `Emit`
 * built from the same root shares one `seq` counter, so a reporter receives a
 * single stable total order even across concurrent component starts.
 *
 * A `undefined` observer yields a shared no-op `Emit` — the zero-cost path.
 */
export const createEmitter = (
  observer: Observer | undefined,
): { readonly scope: (scope: EmitScope) => Emit } => {
  if (!observer) {
    const noop: Emit = () => {};
    return { scope: () => noop };
  }
  let seq = 0;
  return {
    scope: (scope: EmitScope): Emit => (data: ObserverEventData): void => {
      const event = {
        ...data,
        seq: seq++,
        at: new Date().toISOString(),
        adapter: scope.adapter,
        ...(scope.envKey !== undefined ? { envKey: scope.envKey } : {}),
        ...(scope.component !== undefined ? { component: scope.component } : {}),
        ...(scope.instance !== undefined ? { instance: scope.instance } : {}),
      } as ObserverEvent;
      // Telemetry must never break the thing it observes: a throwing or
      // buggy reporter is isolated here, not propagated into provisioning.
      try {
        observer(event);
      } catch (err) {
        console.error("[observer] reporter threw (isolated; provisioning continues):", err);
      }
    },
  };
};
