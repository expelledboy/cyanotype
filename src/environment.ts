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
/**
 * Every port a Blueprint declares must be assigned by the Binding that
 * instantiates it.
 *
 * `Binding.ports` is `Record<string, "auto" | number>` rather than a key-for-key
 * mapping of `Blueprint.portNames`, so a Binding that omits one type-checks. The
 * omission is not inert: the orchestrator hands the resolved map to
 * `blueprint.interface(...)`, the missing entry reads `undefined`, and it lands
 * in a URI as `http://127.0.0.1:undefined`. What the author then sees is a
 * readiness timeout against their own service — a failure that points at the
 * system under test rather than at the Binding.
 *
 * Checked here rather than as a runtime invariant because this is consumer
 * misconfiguration, not an agreement between Cyanotype's own modules: it must
 * fail for everyone, at construction, naming the port.
 */
const checkDeclaredPorts = (componentName: string, slot: unknown): void => {
  const bindings: [string | undefined, AnyBindingLike][] =
    isBindingLike(slot)
      ? [[undefined, slot]]
      : Object.entries(slot as Record<string, AnyBindingLike>)
          .filter((e): e is [string, AnyBindingLike] => isBindingLike(e[1]))
          .map(([k, v]) => [k, v]);

  for (const [instance, binding] of bindings) {
    const declared = binding.blueprint?.portNames ?? [];
    const assigned = binding.ports ?? {};
    const missing = declared.filter((n) => assigned[n] === undefined);
    if (missing.length === 0) continue;
    const where = instance === undefined ? componentName : `${componentName}.${instance}`;
    throw {
      kind: "binding_missing_declared_ports",
      component: componentName,
      ...(instance !== undefined ? { instance } : {}),
      missing,
      declared,
      assigned: Object.keys(assigned),
      hint:
        `The Blueprint bound at "${where}" declares portNames [${declared.join(", ")}] but its ` +
        `Binding assigns [${Object.keys(assigned).join(", ") || "nothing"}], leaving ` +
        `[${missing.join(", ")}] unset. Add ${missing.map((m) => `${m}: "auto"`).join(", ")} to ` +
        `that Binding's ports. Removing the name from the Blueprint's portNames only silences ` +
        `this check — it is the right fix ONLY if nothing in that Blueprint's interface() ` +
        `reads the port, otherwise the same failure returns unguarded. Left unset, the port ` +
        `resolves to undefined and your interface URI becomes "http://host:undefined", which ` +
        `surfaces later as a readiness timeout apparently against your own service.`,
    };
  }
};

type AnyBindingLike = {
  blueprint?: { portNames?: readonly string[] };
  ports?: Record<string, "auto" | number>;
};

const isBindingLike = (v: unknown): v is AnyBindingLike =>
  typeof v === "object" && v !== null && "blueprint" in v;

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
        hint:
          name === "start"
            ? `"start" is reserved defensively: runtime.start is not exposed today, but ` +
              `reserving the name means adding an environment-level start later cannot ` +
              `silently shadow a component. Rename the component in createEnvironment().`
            : `"${name}" is a system operation on the runtime (runtime.${name}). The runtime ` +
              `assigns components first and system operations last, so the operation would ` +
              `overwrite your component and leave it unreachable — the shadowing runs that ` +
              `way round, not the other. Rename the component in createEnvironment().`,
      };
    }
    checkDeclaredPorts(name, env[name]);
  }
  return env;
};
