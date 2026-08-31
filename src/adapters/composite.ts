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
      throw {
        kind: "composite_route_key_invalid",
        key,
        hint:
          `Route key "${key}" contains "${SEP}", which the composite adapter reserves to prefix container ids so it can route stop, logs and exists back to the substrate that started them. The usual cause is writing an instance with the wrong separator — the accepted forms are the component name alone, or component.instance with a DOT. Another is pasting a container id, which already carries this prefix, where a route key was wanted. Only if the component itself is genuinely named with "${SEP}" is renaming the component the fix, and note that renaming just the key without matching a real component silently leaves that component on the default substrate.`,
      };
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
        hint:
          "This composite routes some components to a host-bound substrate (an in-process "
          + "simulator binds the test host's loopback) and others into a cluster, which cannot "
          + "generally reach that loopback — so the in-cluster components would fail to talk to "
          + "the simulated ones. Either route both sides to the same substrate, or set "
          + "allowUnreachableSubstrates: true if this cluster can route to your host.",
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

  // NO `reconnect` HERE, AND NOT BY OVERSIGHT (D-046, D-047).
  //
  // Routing one would be easy — `split()` already yields the member and the
  // inner id, and the result just needs re-prefixing. The blocker is what to do
  // for a member that does NOT implement it. `ReconnectSpec` carries port
  // NAMES, not the numbers the snapshot recorded, so this adapter cannot answer
  // "use the recorded ports for that one" and has nothing valid to return.
  //
  // The conservative fix — expose `reconnect` only when every member implements
  // it — is inert here by construction. This adapter exists to run the
  // component under test for real beside simulated dependencies (D-038), and
  // the in-memory adapter cannot implement `reconnect` at all: its fakes live
  // in this process, so there is nothing for another process to reconnect to.
  // A composite doing its job therefore always has a member without it.
  //
  // Closing this properly means putting the recorded ports in `ReconnectSpec`,
  // which is an SPI change and wants evidence that someone needs cross-process
  // attach against a mixed-substrate Environment. Nobody has asked yet.
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
      invariant( () => split(containerId) !== null, "a minted composite id routes back",
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
