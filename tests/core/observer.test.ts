import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import {
  http, iface, defineBlueprint, bind,
  type Environment, type HttpRouteMap, type ObserverEvent,
} from "../../src/index";
import { createEmitter } from "../../src/observer";
import { startEnvironment } from "../../src/orchestrator";
import { createInMemoryAdapter } from "../../src/adapters/memory";
import { petstoreFake, createSharedPetStore } from "../fakes/petstore";

describe("observer/createEmitter", () => {
  test("stamps a monotonic seq shared across scopes", () => {
    const seen: ObserverEvent[] = [];
    const emitter = createEmitter((e) => seen.push(e));
    const a = emitter.scope({ adapter: "docker", component: "redis" });
    const b = emitter.scope({ adapter: "docker", component: "petstore" });
    a({ type: "chaos.stopping" });
    b({ type: "chaos.starting" });
    a({ type: "chaos.stopped" });
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(seen.map((e) => e.component)).toEqual(["redis", "petstore", "redis"]);
  });

  test("drops undefined envelope keys", () => {
    const seen: ObserverEvent[] = [];
    const emit = createEmitter((e) => seen.push(e)).scope({ adapter: "memory" });
    emit({ type: "environment.ready", durationMs: 5 });
    expect("component" in seen[0]!).toBe(false);
    expect("instance" in seen[0]!).toBe(false);
  });

  test("undefined observer yields a no-op emit (zero cost)", () => {
    const emit = createEmitter(undefined).scope({ adapter: "memory" });
    expect(() => emit({ type: "chaos.stopping" })).not.toThrow();
  });

  test("isolates a throwing observer — telemetry never breaks the caller", () => {
    const emit = createEmitter(() => { throw new Error("buggy reporter"); })
      .scope({ adapter: "memory" });
    expect(() => emit({ type: "chaos.stopping" })).not.toThrow();
  });
});

const routes = {
  createPet: { method: "POST", path: "/v1/pets", request: z.object({ name: z.string() }), response: z.object({ id: z.string(), name: z.string() }) },
} as const satisfies HttpRouteMap;

const petstoreBlueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (_c: Record<string, never>, _e: Record<string, string>, ports) => ({
    http: iface({ uri: `http://127.0.0.1:${ports.http}`, protocol: http(routes) }),
  }),
  readiness: { kind: "http", interfaceName: "http", path: "/health", statusMin: 200, statusMax: 299 },
});

const petstoreBinding = bind(petstoreBlueprint, {
  image: "test/petstore:v1", version: "v1", config: {}, env: {}, ports: { http: "auto" },
});

const buildEnv = () => ({ petstore: petstoreBinding } as const satisfies Environment);
const buildAdapter = () =>
  createInMemoryAdapter({
    factories: { "test/petstore:v1": petstoreFake({ instanceId: "one", store: createSharedPetStore() }) },
  });

describe("observer/startEnvironment", () => {
  // biome-ignore lint/suspicious/noExplicitAny: typed runtime stashed for afterEach
  let runtime: any;
  afterEach(async () => { if (runtime) await runtime.stop(); runtime = undefined; });

  test("emits the framework lifecycle sequence", async () => {
    const seen: ObserverEvent[] = [];
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "obs", observer: (e) => seen.push(e),
    });
    const types = seen.map((e) => e.type);
    expect(types).toContain("environment.starting");
    expect(types).toContain("substrate.connected");
    expect(types).toContain("container.started");
    expect(types).toContain("probe.ready");
    expect(types).toContain("environment.component_ready");
    expect(types).toContain("environment.ready");
    // ordering: starting before ready, ready is last
    expect(types.indexOf("environment.starting")).toBe(0);
    expect(types[types.length - 1]).toBe("environment.ready");
  });

  test("envelope carries adapter name and component scope", async () => {
    const seen: ObserverEvent[] = [];
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "obs", observer: (e) => seen.push(e),
    });
    const started = seen.find((e) => e.type === "container.started");
    expect(started?.adapter).toBe("memory");
    expect(started?.component).toBe("petstore");
    expect(started?.envKey).toBe("obs");
  });

  test("a throwing observer does not abort startEnvironment", async () => {
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "obs",
      observer: () => { throw new Error("buggy reporter"); },
    });
    expect(runtime.petstore.interface.http.uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("observer/stack events", () => {
  test("stack.* events type-check and carry payloads", () => {
    const seen: ObserverEvent[] = [];
    const emit = createEmitter((e) => seen.push(e)).scope({ adapter: "docker" });

    emit({ type: "stack.checking", stackName: "mystack" });
    emit({ type: "stack.fresh", stackName: "mystack" });
    emit({ type: "stack.stale", stackName: "mystack", changedFields: ["image", "env"] });
    emit({ type: "stack.rebuilding", stackName: "mystack" });
    emit({ type: "stack.rebuilt", stackName: "mystack", durationMs: 4200 });
    emit({ type: "stack.attached", stackName: "mystack", serviceCount: 3 });
    emit({ type: "stack.failed", stackName: "mystack", error: new Error("compose error") });

    expect(seen.map((e) => e.type)).toEqual([
      "stack.checking",
      "stack.fresh",
      "stack.stale",
      "stack.rebuilding",
      "stack.rebuilt",
      "stack.attached",
      "stack.failed",
    ]);

    const checking = seen[0] as Extract<ObserverEvent, { type: "stack.checking" }>;
    expect(checking.stackName).toBe("mystack");

    const stale = seen[2] as Extract<ObserverEvent, { type: "stack.stale" }>;
    expect(stale.changedFields).toEqual(["image", "env"]);

    const rebuilt = seen[4] as Extract<ObserverEvent, { type: "stack.rebuilt" }>;
    expect(rebuilt.durationMs).toBe(4200);

    const attached = seen[5] as Extract<ObserverEvent, { type: "stack.attached" }>;
    expect(attached.serviceCount).toBe(3);

    const failed = seen[6] as Extract<ObserverEvent, { type: "stack.failed" }>;
    expect((failed.error as Error).message).toBe("compose error");
  });

  test("stack.* events flow through createEmitter with monotonic seq", () => {
    const seen: ObserverEvent[] = [];
    const emitter = createEmitter((e) => seen.push(e));
    const a = emitter.scope({ adapter: "docker", component: "app" });
    const b = emitter.scope({ adapter: "docker", component: "db" });

    a({ type: "stack.checking", stackName: "app-stack" });
    b({ type: "stack.checking", stackName: "db-stack" });
    a({ type: "stack.stale", stackName: "app-stack", changedFields: ["image"] });
    b({ type: "stack.fresh", stackName: "db-stack" });
    a({ type: "stack.attached", stackName: "app-stack", serviceCount: 2 });

    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(seen.map((e) => e.component)).toEqual(["app", "db", "app", "db", "app"]);
  });
});
