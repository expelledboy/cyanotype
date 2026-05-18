/**
 * Binding — the substrate-bound instantiation of a Blueprint.
 *
 * A Binding pairs a Blueprint with the fields needed to actually run it
 * against a substrate: `image`, `version`, the concrete `config: C` and
 * `env: E` injected at start time, host port assignments per declared
 * port name, optional mounts, an optional per-Binding `logParser`, and
 * adapter labels.
 *
 * The Blueprint never crosses the Adapter boundary — it is consumed by the
 * orchestrator, which reads `binding.blueprint.interface(...)` to build the
 * typed runtime surface and `binding.blueprint.events` to wire the event
 * bus. The Adapter only ever sees a flat `StartSpec` derived from the
 * Binding's substrate fields.
 *
 * Multiple Bindings can satisfy one Blueprint:
 *
 *   const real = (cfg) => bind(petstoreBlueprint, { image: "petstore:real", ... });
 *   const sim  = (cfg) => bind(petstoreBlueprint, { image: "petstore:sim",
 *                                                    logParser: simParser, ... });
 *
 * Same tests run against either — the substrate seam is the Adapter, which
 * decides what `image: string` means against the substrate it owns.
 */

import type { InterfaceRecord, ApiFromInterface } from "./interface";
import type { EventCatalog, LogParser } from "./events";
import type { HelperContext } from "./helpers";
import type { Blueprint } from "./blueprint";

/**
 * `Blueprint<any, any, any, any>` as a slot constraint preserves the literal
 * Blueprint type through `typeof binding`, so the runtime extractors below
 * can walk back to the specific `C` / `E` / `I` / `A`. Narrowing the
 * constraint would reject literal types under `strictFunctionTypes` —
 * Blueprint is invariant in its generics.
 */
export type Binding<
  // biome-ignore lint/suspicious/noExplicitAny: variance widener, see comment above
  B extends Blueprint<any, any, any, any> = Blueprint,
> = {
  readonly blueprint: B;
  readonly image: string;
  readonly version: string;
  readonly config: ConfigOf<B>;
  readonly env: EnvOf<B>;
  /** Named port assignments. `"auto"` = orchestrator allocates a free host port. */
  readonly ports: Record<string, "auto" | number>;
  /**
   * Mount-as-content: container path → file contents. The adapter writes the
   * contents to a host tmpfile and bind-mounts it read-only.
   */
  readonly mounts?: Record<string, string>;
  /**
   * Per-Binding log parser. Converts this Binding's specific log format into
   * events conforming to the Blueprint's event catalog. A real Docker image
   * and an in-process simulator can carry different parsers and still feed
   * the same typed event bus.
   */
  readonly logParser?: LogParser;
  /** Adapter labels for teardown discovery and selective cleanup. */
  readonly labels?: Record<string, string>;
};

/**
 * Identity factory that drives generic inference on the Blueprint type.
 * Equivalent to `{ blueprint, ...spec }` — exists so `bind(bp, {...})`
 * captures `B` precisely without a `satisfies` annotation at the call site.
 */
export const bind = <
  // biome-ignore lint/suspicious/noExplicitAny: variance widener
  B extends Blueprint<any, any, any, any>,
>(
  blueprint: B,
  spec: Omit<Binding<B>, "blueprint">,
): Binding<B> => ({ blueprint, ...spec });

// ----------------------------------------------------------------
// Type-level extractors. Used by Running<B> in runtime.ts to derive the
// per-component runtime shape from a Binding literal. They walk through
// `B["blueprint"]` to reach the contract.
//
// Each uses a "concrete first, optional second" two-pattern form to work
// around variance under `strictFunctionTypes`. The first pattern matches
// literal bindings where `blueprint` is concretely present; the second
// matches values typed against the wider `Binding` constraint.
// ----------------------------------------------------------------

/** Extract the Blueprint type from a Binding. */
export type BlueprintOf<B> =
  // biome-ignore lint/suspicious/noExplicitAny: extractor walks any Blueprint shape
  B extends { readonly blueprint: infer BP } ? BP : never;

/** Extract the config type from a Binding's Blueprint. */
export type ConfigOf<B> =
  // biome-ignore lint/suspicious/noExplicitAny: extractor; C is inferred
  B extends Blueprint<infer C, any, any, any> ? C : unknown;

/** Extract the env-vars type from a Binding's Blueprint. */
export type EnvOf<B> =
  // biome-ignore lint/suspicious/noExplicitAny: extractor; E is inferred
  B extends Blueprint<any, infer E, any, any>
    ? E
    : Record<string, string>;

/** Extract the InterfaceRecord type from a Binding. */
export type IfaceOf<B> =
  // biome-ignore lint/suspicious/noExplicitAny: extractor walks factory return
  B extends { readonly blueprint: { interface: (c: any, e: any, p: any) => infer I } }
    ? I extends InterfaceRecord ? I : Record<string, never>
  // biome-ignore lint/suspicious/noExplicitAny: extractor walks factory return
  : B extends { readonly blueprint?: { interface?: (c: any, e: any, p: any) => infer I } }
    ? I extends InterfaceRecord ? I : Record<string, never>
  : Record<string, never>;

/**
 * Extract the typed API shape from a Binding's Blueprint.
 *  - If the Blueprint provides a custom `api` factory, use its return type.
 *  - Otherwise auto-derive from schema-bearing interfaces (`ApiFromInterface<I>`).
 *  - If the interface record is empty (`Record<string, never>`), the api is
 *    `undefined` (no typed surface to expose).
 */
export type ApiOfBlueprint<B> =
  B extends { readonly blueprint: { api: (iface: never, helpers: HelperContext) => infer A } }
    ? A
  : B extends { readonly blueprint?: { api?: (iface: never, helpers: HelperContext) => infer A } }
    ? A
  : IfaceOf<B> extends infer I
    ? I extends InterfaceRecord
      ? [keyof I] extends [never]
        ? undefined
        : ApiFromInterface<I>
      : undefined
    : undefined;

/** Extract the events catalog from a Binding's Blueprint. */
export type EventsOf<B> =
  B extends { readonly blueprint: { events: infer Cat } }
    ? Cat extends EventCatalog ? Cat : undefined
  : B extends { readonly blueprint?: { events?: infer Cat } }
    ? Cat extends EventCatalog ? Cat : undefined
  : undefined;
