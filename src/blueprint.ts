/**
 * Blueprint — the typed contract a component declares.
 *
 * A Blueprint says what a component *exposes*: declared port names, a
 * factory that builds the typed interface from config + env + resolved
 * ports, an optional custom API factory, an event catalog, and readiness
 * / health probes. It carries no `image`, no `mounts`, no `env` values —
 * substrate-agnostic by construction. Multiple Bindings (`./binding.ts`)
 * can satisfy a single Blueprint: a real Docker image, an in-process
 * simulator, a prior version, a vendor-compatible alternative.
 *
 * Four type parameters, each inferable from the literal passed to
 * `defineBlueprint(...)`:
 *   - `C` — config type. Passed to the factory at start time from the
 *     Binding's `config: C` field.
 *   - `E` — env-vars type. Typed `Record<string, string>` by default;
 *     narrow via the factory's explicit parameter annotation.
 *   - `I` — the InterfaceRecord this Blueprint produces. Inferred from
 *     the return type of `interface(config, env, resolvedPorts)`.
 *   - `A` — the api shape. Defaults to `ApiFromInterface<I>` (auto-derived
 *     from schema-bearing interfaces); overridden when `api?:` is supplied.
 */

import type { InterfaceRecord, ApiFromInterface } from "./interface.js";
import type { Probe } from "./probe.js";
import type { EventCatalog } from "./events.js";
import type { HelperContext } from "./helpers.js";

/**
 * Method syntax for `interface` / `api` / `readiness` is deliberate — it
 * gives bivariant parameter checking so a `Blueprint<SpecificC, SpecificE,
 * ConcreteI, ConcreteA>` is assignable to `Blueprint<unknown, ..., InterfaceRecord, unknown>`
 * (the wider slot constraint Environment uses). Without bivariance,
 * literal Blueprint values would fail Environment's slot constraint.
 */
export type Blueprint<
  C = unknown,
  E extends Record<string, string> = Record<string, string>,
  I extends InterfaceRecord = InterfaceRecord,
  A = ApiFromInterface<I>,
> = {
  /** Declared port names. The Binding assigns host ports to these. */
  readonly portNames: readonly string[];

  /**
   * Build the typed InterfaceRecord from the Binding's config + env and
   * the resolved host ports. Called by the orchestrator at start time.
   */
  interface(config: C, env: E, resolvedPorts: Record<string, number>): I;

  /**
   * Optional custom API factory. When omitted, the orchestrator auto-derives
   * typed clients from schema-bearing interfaces. When provided, its return
   * type flows through `A` and becomes `runtime.X.api`'s type.
   */
  api?(iface: I, helpers: HelperContext): A;

  readonly events?: EventCatalog;
  readonly readiness?: Probe<I>;
  readonly health?: Probe<I>;
};

/**
 * Identity factory that captures the Blueprint's literal type — including
 * the specific shape of the `events` catalog and other readonly fields —
 * via the `const` type-parameter modifier (TS 5.0+).
 *
 * The constraint `Blueprint<any, any, any, any>` is intentional. With
 * specific generic parameters (`<C, E, I, A>`), TypeScript widens the
 * `events` field to `EventCatalog`, breaking downstream typed-event
 * assertions (`runtime.X.events.waitFor("NAME", { attributes: ... })`).
 * The `const` modifier preserves literals end-to-end.
 *
 * Plain objects satisfying `Blueprint<...>` also work — the helper is
 * an inference convenience, not a required wrapper.
 */
export const defineBlueprint = <
  // biome-ignore lint/suspicious/noExplicitAny: const-modifier needs widest constraint to preserve literals
  const BP extends Blueprint<any, any, any, any>,
>(
  bp: BP,
): BP => bp;
