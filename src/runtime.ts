/**
 * Runtime — what tests interact with.
 *
 * Derived from the Environment's literal type via mapped/conditional types.
 * The Runtime tree exposes the **Blueprint surface only** — `api`, `events`,
 * `interface`, `ports`. The Binding's substrate fields (`image`, `mounts`,
 * `env`, `logParser`) never appear on the runtime tree. The call site is
 * identical whether the Binding behind `runtime.petstore` is a real Docker
 * container or an in-process simulator.
 *
 *   runtime.petstore.one.api.http.createPet({...})
 *   runtime.redis.primary.events.waitFor(...)
 *
 * Reserved system names: `chaos`, `snapshot`, `metadata`, `start`, `stop`.
 * Components cannot use these names; `createEnvironment` rejects collisions
 * at construction.
 *
 * Per-component event bus — each Running component has its own typed
 * `.events`. There is no global merged bus.
 *
 * ChaosControls is typed against the Environment so the instance argument
 * is *required* for multi-instance slots and *prohibited* for single-instance.
 */

import type { Binding, IfaceOf, ApiOfBlueprint, EventsOf } from "./binding.js";
import type { Environment } from "./environment.js";
import type { EventBus, EventCatalog } from "./events.js";
import type { EnvironmentMetadata } from "./metadata.js";

/**
 * A frozen view of the orchestrator's live state at call time. `snapshot()`
 * is a getter that walks the live registry — there is no state machine.
 */
export type RuntimeSnapshot = {
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed";
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly instance: string;
    readonly containerId: string | undefined;
    readonly running: boolean;
    readonly ports: Readonly<Record<string, number>>;
  }>;
  readonly lastError?: string;
};

// ============================================================
// Per-component runtime
//
// `Running<B>` and `ComponentRuntime<S>` use `Binding<any>` (or no
// constraint) deliberately. Binding's Blueprint generic is invariant
// — see `environment.ts` for the explanation. The type extractors
// (`IfaceOf` / `ApiOfBlueprint` / `EventsOf`) walk through `B["blueprint"]`
// structurally without requiring B to extend the wide `Binding<Blueprint>`.
// ============================================================

export type Running<B> = {
  readonly ports: Record<string, number>;
  readonly interface: IfaceOf<B>;
  readonly api: ApiOfBlueprint<B>;
  readonly events: EventsOf<B> extends EventCatalog ? EventBus<EventsOf<B>> : undefined;
};

/** Single slot → flat; multi slot → nested record. */
export type ComponentRuntime<S> =
  // biome-ignore lint/suspicious/noExplicitAny: variance widener, see note above
  S extends Binding<any>
    ? Running<S>
    // biome-ignore lint/suspicious/noExplicitAny: variance widener
    : S extends Record<string, Binding<any>>
      ? { readonly [I in keyof S]: Running<S[I]> }
      : never;

// ============================================================
// Environment-wide runtime
// ============================================================

export type Runtime<E extends Environment> = ServicesOf<E> & SystemOps<E>;

type ServicesOf<E extends Environment> = {
  readonly [K in keyof E]: ComponentRuntime<E[K]>;
};

type SystemOps<E extends Environment> = {
  readonly chaos: ChaosControls<E>;
  /** Read the orchestrator's current state. Synchronous. */
  readonly snapshot: () => RuntimeSnapshot;
  /** Read the persisted cross-process metadata. */
  readonly metadata: () => EnvironmentMetadata;
  /** Tear down (if this runtime owns lifecycle) or detach (if attached). */
  readonly stop: () => Promise<void>;
};

// ============================================================
// Chaos controls — type-safe arguments
// ============================================================

export type ChaosControls<E extends Environment> = {
  readonly stop:    <K extends keyof E & string>(...args: ChaosArgs<E, K>) => Promise<void>;
  readonly start:   <K extends keyof E & string>(...args: ChaosArgs<E, K>) => Promise<void>;
  readonly restart: <K extends keyof E & string>(...args: ChaosArgs<E, K>) => Promise<void>;
};

/**
 * If `E[K]` is a single Binding: args are `[name]`.
 * If `E[K]` is a multi-instance record: args are `[name, instance]` with
 * `instance` constrained to that record's keys.
 */
type ChaosArgs<E extends Environment, K extends keyof E & string> =
  // biome-ignore lint/suspicious/noExplicitAny: variance widener
  E[K] extends Binding<any>
    ? readonly [name: K]
    // biome-ignore lint/suspicious/noExplicitAny: variance widener
    : E[K] extends Record<infer I extends string, Binding<any>>
      ? readonly [name: K, instance: I]
      : never;
