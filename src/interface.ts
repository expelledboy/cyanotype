/**
 * Interface — one named endpoint on a component.
 *
 * Each Interface carries a Protocol (which carries the schema, which drives
 * the typed API). A Blueprint's `interface()` factory returns a *record* of
 * Interfaces, so components with multiple addressable endpoints (e.g. Redis:
 * TCP + HTTP-metrics) are first-class.
 *
 * `ApiFromInterface<I>` maps the record to a record of typed APIs. Interfaces
 * with Opaque protocols are filtered out — they have no typed client; tests
 * use the Interface's `host`/`port` directly.
 *
 * Always the record form: `runtime.X.api.http.method()`, `runtime.X.api.redis.set()`.
 * Single-interface flattening (`runtime.X.api.method()`) is not provided —
 * the keyed form is uniform across multi- and single-interface components.
 */

import type { ApiOf, Protocol } from "./protocol.js";

/**
 * `host` and `port` are typed `string | undefined` / `number | undefined`
 * explicitly (rather than `string?` / `number?`) so they remain assignable
 * under `exactOptionalPropertyTypes: true` from sources that produce
 * `string | undefined` / `number | undefined` (e.g. indexing into the
 * `ResolvedPorts: Record<string, number>` parameter, where
 * `noUncheckedIndexedAccess` adds `| undefined`).
 */
export type Interface<P extends Protocol = Protocol> = {
  readonly uri: string;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly protocol: P;
};

export type InterfaceRecord = Record<string, Interface>;

/**
 * Derive the typed API record from an InterfaceRecord. Opaque interfaces
 * (api = undefined) are filtered out.
 */
export type ApiFromInterface<I extends InterfaceRecord> = {
  readonly [K in keyof I as ApiOf<I[K]["protocol"]> extends undefined ? never : K]:
    ApiOf<I[K]["protocol"]>;
};

/** Constructor — preserves the Protocol type for inference. */
export const iface = <P extends Protocol>(init: {
  readonly uri: string;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly protocol: P;
}): Interface<P> => init;
