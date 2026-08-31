/**
 * CompositeAdapter — one Environment, more than one substrate.
 *
 * The isolation case the Blueprint contract exists for: run the component under
 * test for real, and satisfy its dependencies with in-process simulators, so a
 * neighbouring team's broken build cannot fail your test. Until now the choice
 * was per-Environment — `createSharedEnvs` takes one Adapter — so it was all
 * real or all simulated.
 *
 * Routing is by component name and instance, never by image. Two instances of
 * one component must be able to differ (a real "stable" beside a simulated
 * "canary"), and image-keyed routing collapses exactly that case.
 *
 *   createCompositeAdapter({
 *     default: createDockerAdapter({ sessionId }),
 *     routes: {
 *       "redis": memory,             // whole slot, every instance
 *       "petstore.canary": memory,   // one instance; petstore.stable stays real
 *     },
 *   })
 *
 * Realization is fixed when the harness is built and cannot be changed from a
 * test. That is deliberate: the same test must be able to run against different
 * realizations without being rewritten, which stops being true the moment a
 * test can reach in and re-point a component.
 *
 * WHY container ids are prefixed. The Adapter SPI is asymmetric: `start` is
 * handed a StartSpec and can see the component, but `stop`, `logs` and `exists`
 * receive only an opaque container id. A Map from id to sub-adapter would work
 * in one process and fail in the next: attach mode reads container ids out of
 * the metadata file written by a *different* process, which has no such map. So
 * the route has to travel inside the id itself, and every id this adapter
 * returns is `<routeKey>::<underlying id>`.
 *
 * REACHABILITY LIMIT. A simulator listens on 127.0.0.1 on the test host. A
 * Docker container reaches that through `host.docker.internal`; a Kubernetes Pod
 * generally cannot reach the test runner's loopback at all. Docker + memory is
 * the supported pairing. Kubernetes + memory needs `allowUnreachableSubstrates`
 * and a cluster that can actually route to the host — without it, construction
 * throws rather than leaving a readiness probe to time out with no explanation.
 */

import type { Adapter, StartSpec, Started } from "../adapter.js";
import type { Emit } from "../observer.js";
import { invariant } from "../invariants.js";

const SEP = "::";

export type CompositeAdapterOptions = {
  /** Substrate for any component with no matching route. */
  readonly default: Adapter;
  /**
   * Route key → adapter. A key is either a component name (`"redis"`, covering
   * every instance of that slot) or `component.instance` (`"petstore.canary"`).
   * The more specific key wins.
   */
  readonly routes: Record<string, Adapter>;
  /**
   * Permit substrate pairings whose components cannot necessarily reach each
   * other — today, an in-cluster Kubernetes workload alongside an in-process
   * simulator bound to the test host's loopback. Off by default so the failure
   * is a construction error naming the pairing, rather than a probe timeout.
   */
  readonly allowUnreachableSubstrates?: boolean;
};

/** `component.instance` when the spec carries an instance, else `component`. */
const specRouteKeys = (spec: StartSpec): readonly string[] => {
  const component = spec.labels["cyanotype.component"];
  if (component === undefined) return [];
  return spec.instance === undefined
    ? [component]
    : [`${component}.${spec.instance}`, component];
};

const HOST_LOOPBACK_SUBSTRATES = new Set(["memory"]);
const IN_CLUSTER_SUBSTRATES = new Set(["kubernetes", "k8s"]);

export const createCompositeAdapter = (opts: CompositeAdapterOptions): Adapter => {
  for (const key of Object.keys(opts.routes)) {
    if (key.includes(SEP)) {
      throw { kind: "composite_route_key_invalid", key, reason: `must not contain "${SEP}"` };
    }
  }

  const all = [opts.default, ...Object.values(opts.routes)];
  const names = new Set(all.map((a) => a.name));
  if (!opts.allowUnreachableSubstrates) {
    const hostBound = [...names].filter((n) => HOST_LOOPBACK_SUBSTRATES.has(n));
    const inCluster = [...names].filter((n) => IN_CLUSTER_SUBSTRATES.has(n));
    if (hostBound.length > 0 && inCluster.length > 0) {
      throw {
        kind: "composite_substrates_unreachable",
        hostBound, inCluster,
        reason:
          "an in-process simulator binds the test host's loopback, which an "
          + "in-cluster Pod cannot generally reach. Set allowUnreachableSubstrates "
          + "if this cluster can route to the host.",
      };
    }
  }

  // Distinct instances, in a stable order, for the lifecycle fan-outs. One
  // adapter can serve several route keys; connecting it twice is not harmless
  // for every substrate, so dedupe by identity rather than by name.
  const distinct: Adapter[] = [];
  for (const a of all) if (!distinct.includes(a)) distinct.push(a);

  const resolveKey = (spec: StartSpec): string | undefined => {
    for (const k of specRouteKeys(spec)) if (opts.routes[k]) return k;
    return undefined;
  };

  const split = (containerId: string): { adapter: Adapter; id: string } | null => {
    const at = containerId.indexOf(SEP);
    // No prefix: metadata written before this adapter existed. The default
    // substrate is the only sound guess, and it is what a single-adapter
    // environment used.
    if (at < 0) return { adapter: opts.default, id: containerId };
    const key = containerId.slice(0, at);
    const id = containerId.slice(at + SEP.length);
    if (key === "") return { adapter: opts.default, id };
    const adapter = opts.routes[key];
    return adapter ? { adapter, id } : null;
  };

  const fanOut = async (
    what: "connect" | "disconnect" | "teardown",
  ): Promise<void> => {
    const errors: unknown[] = [];
    for (const a of distinct) {
      try { await a[what](); } catch (e) { errors.push(e); }
    }
    if (errors.length > 0) throw errors[0];
  };

  return {
    name: `composite(${distinct.map((a) => a.name).join("+")})`,

    connect: () => fanOut("connect"),
    disconnect: () => fanOut("disconnect"),
    teardown: () => fanOut("teardown"),

    start: async (spec: StartSpec, emit?: Emit): Promise<Started> => {
      const key = resolveKey(spec);
      const adapter = key === undefined ? opts.default : opts.routes[key]!;
      const started = await adapter.start(spec, emit);
      const containerId = `${key ?? ""}${SEP}${started.containerId}`;
      // I9: every id this adapter mints must route back. An unroutable id does
      // not throw — `stop` becomes a no-op and `exists` reports false, so a
      // container silently outlives the suite.
      invariant(split(containerId) !== null, "a minted composite id routes back",
        () => ({ containerId, key, routes: Object.keys(opts.routes) }));
      return { ...started, containerId };
    },

    stop: async (containerId: string): Promise<void> => {
      const r = split(containerId);
      // Idempotent per the SPI: an id this composite cannot place is already
      // not ours to stop.
      if (r) await r.adapter.stop(r.id);
    },

    logs: (containerId: string, signal?: AbortSignal): AsyncIterable<string> => {
      const r = split(containerId);
      if (!r) return (async function* () { /* unroutable id — no stream */ })();
      return r.adapter.logs(r.id, signal);
    },

    exists: async (containerId: string): Promise<boolean> => {
      const r = split(containerId);
      // An id whose route key is gone means the metadata was written under a
      // different composite configuration. Reporting false lets the existing
      // dead-container path invalidate it instead of throwing mid-attach.
      if (!r) return false;
      return r.adapter.exists(r.id);
    },
  };
};
