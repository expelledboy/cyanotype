/**
 * Environment — composition of Bindings.
 *
 * A record of named Bindings or multi-instance groups. Multi-instance is
 * just a nested `Record<string, Binding>` inline; no `Slot` wrapper. The
 * Runtime type derives the right shape (flat for single-instance, nested
 * for multi-instance) from the literal type of an Environment value.
 *
 * Component names are validated against reserved keys at construction
 * time: `start`, `stop`, `snapshot`, `metadata`, `chaos` are reserved by
 * `Runtime<E>` as system operations. A Blueprint named "chaos" would
 * collide with `runtime.chaos.{stop,start,restart}` and the typed access
 * path would silently shadow.
 */

import type { Binding } from "./binding.js";

/**
 * One component slot: a single Binding or a record of named instances.
 *
 * The `Binding<any>` is intentional. Binding's Blueprint generic is
 * invariant (`C`/`E`/`I`/`A` appear in both function-return and
 * method-param positions). A narrower constraint here would reject the
 * literal types of concrete Binding values. `any` admits any specific
 * Blueprint; the literal types are preserved through `typeof env` for
 * the runtime to extract via the binding-module extractors.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance widener, see comment above
export type Slot = Binding<any> | Record<string, Binding<any>>;

export type Environment = Record<string, Slot>;

/**
 * Type-level helper. `true` if the slot is multi-instance, `false` if single.
 * Used by Runtime / ChaosControls to derive the right argument shape.
 */
export type IsMultiInstance<S> =
  S extends Binding ? false
  : S extends Record<string, Binding> ? true
  : never;

/** Reserved names that collide with system ops on `Runtime<E>`. */
export const RESERVED_COMPONENT_NAMES = ["start", "stop", "snapshot", "metadata", "chaos"] as const;

/**
 * Identity factory that captures the Environment's literal type and
 * validates that no component name collides with a system-op key. Use in
 * place of `as const satisfies Environment` for inference parity and
 * runtime safety against shadowing.
 *
 * Validation is at construction (boundary), not throughout the orchestrator
 * (interior) — CONVENTIONS.md "parse at boundaries, trust internally".
 */
export const createEnvironment = <
  const E extends Environment,
>(
  env: E,
): E => {
  for (const name of Object.keys(env)) {
    if ((RESERVED_COMPONENT_NAMES as readonly string[]).includes(name)) {
      throw {
        kind: "reserved_component_name",
        name,
        reserved: RESERVED_COMPONENT_NAMES,
      };
    }
  }
  return env;
};
