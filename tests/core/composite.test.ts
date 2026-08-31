/**
 * Composite adapter — one Environment spanning two substrates.
 *
 * The scenario this exists for: the component under test runs for real while
 * its dependencies are simulated, so another team's build cannot fail your
 * test. The load-bearing case is a single component whose instances differ —
 * a real "stable" beside a simulated "canary" — because that is what forces
 * routing to key on component AND instance rather than on image.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  http, iface, defineBlueprint, bind, createCompositeAdapter,
  startEnvironment, attachEnvironment,
  type Adapter, type Environment, type HttpRouteMap, type EventCatalog,
  type LogParser, type StartSpec, type Started,
} from "../../src/index";
import { createInMemoryAdapter } from "../../src/adapters/memory";

// Every Environment below is built from one shared Binding, so the precise
// Runtime shape is not inferable and the tests index it by component and
// instance. One documented escape beats six bare casts.
// biome-ignore lint/suspicious/noExplicitAny: see above
type TestRuntime = any;

const routes = {
  whoami: { method: "GET", path: "/whoami", response: z.object({ substrate: z.string() }) },
} as const satisfies HttpRouteMap;

const events = {
  SERVED: z.object({ substrate: z.string() }),
} as const satisfies EventCatalog;

const logParser: LogParser = (line) => {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (o.event !== "served") return null;
    return { name: "SERVED", attributes: { substrate: String(o.substrate ?? "") } };
  } catch { return null; }
};

const blueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (_c: Record<string, never>, _e: Record<string, string>, ports) => ({
    http: iface({ uri: `http://127.0.0.1:${ports.http}`, protocol: http(routes) }),
  }),
  readiness: { kind: "http", interfaceName: "http", path: "/whoami", statusMin: 200, statusMax: 299 },
  events,
});

const binding = bind(blueprint, {
  image: "svc:v1", version: "v1", config: {}, env: {},
  ports: { http: "auto" }, logParser,
});

/** Stands in for a real substrate: serves over a real socket, reports "real". */
const createRealishAdapter = (): Adapter & { readonly started: string[] } => {
  const servers = new Map<string, ReturnType<typeof Bun.serve>>();
  const started: string[] = [];
  let n = 0;
  const adapter: Adapter = {
    name: "realish",
    connect: async () => {}, disconnect: async () => {}, teardown: async () => {},
    start: async (spec: StartSpec): Promise<Started> => {
      n += 1;
      const id = `realish-${n}`;
      started.push(spec.instance ?? "<single>");
      const s = Bun.serve({ port: 0, fetch: () => Response.json({ substrate: "real" }) });
      servers.set(id, s);
      // Bun types `port` as optional; a bound server always has one.
      return { containerId: id, ports: { http: s.port as number }, owned: true };
    },
    stop: async (id) => { servers.get(id)?.stop(true); servers.delete(id); },
    logs: async function* () {},
    exists: async (id) => servers.has(id),
  };
  return Object.assign(adapter, { started });
};

const createFakeAdapter = () =>
  createInMemoryAdapter({
    factories: {
      "svc:v1": async (_spec, emit) => {
        const s = Bun.serve({
          port: 0,
          fetch: () => {
            emit(JSON.stringify({ event: "served", substrate: "fake" }));
            return Response.json({ substrate: "fake" });
          },
        });
        return { ports: { http: s.port as number }, close: async () => { s.stop(true); } };
      },
    },
  });

describe("adapters/composite", () => {
  test("one component, one instance real and one simulated", async () => {
    const real = createRealishAdapter();
    const adapter = createCompositeAdapter({
      default: real,
      routes: { "svc.canary": createFakeAdapter() },
    });
    const env: Environment = { svc: { stable: binding, canary: binding } };

    const rt = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "mixed" }) as TestRuntime;

    expect((await rt.svc.stable.api.http.whoami()).substrate).toBe("real");
    expect((await rt.svc.canary.api.http.whoami()).substrate).toBe("fake");
    // The real substrate was asked for exactly one instance — the other never
    // reached it, which is the isolation the feature exists to provide.
    expect(real.started).toEqual(["stable"]);

    await rt.stop();
  });

  test("a whole slot routes by component name", async () => {
    const real = createRealishAdapter();
    const adapter = createCompositeAdapter({
      default: real,
      routes: { svc: createFakeAdapter() },
    });
    const env: Environment = { svc: { one: binding, two: binding } };
    const rt = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "slot" }) as TestRuntime;

    expect((await rt.svc.one.api.http.whoami()).substrate).toBe("fake");
    expect((await rt.svc.two.api.http.whoami()).substrate).toBe("fake");
    expect(real.started).toEqual([]);

    await rt.stop();
  });

  test("the instance route beats the component route", async () => {
    const real = createRealishAdapter();
    const fake = createFakeAdapter();
    const adapter = createCompositeAdapter({
      default: real,
      routes: { svc: fake, "svc.stable": real },
    });
    const env: Environment = { svc: { stable: binding, canary: binding } };
    const rt = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "prec" }) as TestRuntime;

    expect((await rt.svc.stable.api.http.whoami()).substrate).toBe("real");
    expect((await rt.svc.canary.api.http.whoami()).substrate).toBe("fake");

    await rt.stop();
  });

  test("events carry the substrate that produced them", async () => {
    const adapter = createCompositeAdapter({
      default: createRealishAdapter(),
      routes: { "svc.canary": createFakeAdapter() },
    });
    const env: Environment = { svc: { stable: binding, canary: binding } };
    const rt = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "evt" }) as TestRuntime;

    const mark = rt.svc.canary.events.mark();
    await rt.svc.canary.api.http.whoami();
    const evt = await rt.svc.canary.events.waitFor("SERVED", { after: mark }, 5_000);
    expect(evt.attributes.substrate).toBe("fake");
    expect(evt.instance).toBe("canary");

    await rt.stop();
  });

  // The reason ids are prefixed rather than held in a Map: a second process
  // attaching from metadata has no map, only the ids on disk.
  test("routing survives a container id round-tripping through metadata", async () => {
    const real = createRealishAdapter();
    const fake = createFakeAdapter();
    const adapter = createCompositeAdapter({
      default: real,
      routes: { "svc.canary": fake },
    });
    const env: Environment = { svc: { stable: binding, canary: binding } };
    const rt = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "rt" }) as TestRuntime;

    // Exactly what the cross-process registry persists and re-reads.
    const meta = JSON.parse(JSON.stringify(rt.metadata()));

    const attached = await attachEnvironment(
      env, { adapter, sessionId: "s2", envKey: "rt" }, { components: meta.components },
    ) as TestRuntime;

    expect((await attached.svc.stable.api.http.whoami()).substrate).toBe("real");
    expect((await attached.svc.canary.api.http.whoami()).substrate).toBe("fake");

    await attached.stop();
    await rt.stop();
  });

  test("an id whose route no longer exists reports gone rather than throwing", async () => {
    const adapter = createCompositeAdapter({
      default: createRealishAdapter(),
      routes: { "svc.canary": createFakeAdapter() },
    });
    // Metadata written under a different composite configuration.
    expect(await adapter.exists("svc.retired::whatever")).toBe(false);
    await adapter.stop("svc.retired::whatever");
  });

  test("refuses a pairing whose components cannot reach each other", () => {
    const k8sLike: Adapter = {
      name: "kubernetes",
      connect: async () => {}, disconnect: async () => {}, teardown: async () => {},
      start: async () => ({ containerId: "x", ports: {}, owned: true }),
      stop: async () => {},
      logs: async function* () {},
      exists: async () => true,
    };
    let caught: unknown;
    try {
      createCompositeAdapter({ default: k8sLike, routes: { svc: createFakeAdapter() } });
    } catch (e) { caught = e; }
    expect((caught as { kind: string }).kind).toBe("composite_substrates_unreachable");

    // Explicit opt-in for a cluster that can route to the host.
    expect(() =>
      createCompositeAdapter({
        default: k8sLike,
        routes: { svc: createFakeAdapter() },
        allowUnreachableSubstrates: true,
      }),
    ).not.toThrow();
  });
});
