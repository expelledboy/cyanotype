import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import {
  http, iface, defineBlueprint, bind,
  type Environment, type HttpRouteMap, type EventCatalog,
  type LogParser,
} from "../../src/index";
import { startEnvironment } from "../../src/orchestrator";
import { createInMemoryAdapter } from "../../src/adapters/memory";
import { petstoreFake, createSharedPetStore, type SharedPetStore } from "../fakes/petstore";

const PetSchema = z.object({ id: z.string(), name: z.string() });
const CreatePetInput = z.object({ name: z.string().min(1) });

const routes = {
  createPet: { method: "POST", path: "/v1/pets",                       request: CreatePetInput, response: PetSchema },
  getPet:    { method: "GET",  path: (id: string) => `/v1/pets/${id}`,                          response: PetSchema },
  listPets:  { method: "GET",  path: "/v1/pets",                                                response: z.object({ items: z.array(PetSchema) }) },
} as const satisfies HttpRouteMap;

const events = {
  PETSTORE_REQUEST: z.object({
    method: z.string(), path: z.string(), status: z.number(), instance: z.string(),
  }),
} as const satisfies EventCatalog;

const logParser: LogParser = (line) => {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (typeof obj.method !== "string" || typeof obj.status !== "number") return null;
    return {
      name: "PETSTORE_REQUEST",
      attributes: {
        method: obj.method, path: String(obj.path ?? ""),
        status: obj.status, instance: String(obj.instance ?? "?"),
      },
    };
  } catch { return null; }
};

const petstoreBlueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (_cfg: Record<string, never>, _env: Record<string, string>, ports) => ({
    http: iface({
      uri: `http://127.0.0.1:${ports.http}`,
      protocol: http(routes),
    }),
  }),
  readiness: { kind: "http", interfaceName: "http", path: "/health", statusMin: 200, statusMax: 299 },
  events,
});

const petstoreBinding = bind(petstoreBlueprint, {
  image: "test/petstore:v1",
  version: "v1",
  config: {},
  env: {},
  ports: { http: "auto" },
  logParser,
});

const buildEnv = () => ({
  petstore: { one: petstoreBinding, two: petstoreBinding },
} as const satisfies Environment);

describe("orchestrator/multi-instance", () => {
  let store: SharedPetStore;
  // biome-ignore lint/suspicious/noExplicitAny: typed runtime stashed across tests
  let runtime: any;

  beforeAll(async () => {
    store = createSharedPetStore();
    const adapter = createInMemoryAdapter({
      factories: {
        "test/petstore:v1": async (spec, emit) => {
          const instanceId = spec.instance ?? "?";
          return petstoreFake({ instanceId, store })(spec, emit);
        },
      },
    });
    runtime = await startEnvironment(buildEnv(), {
      adapter, sessionId: "s1", envKey: "multi-test",
    });
  });

  afterAll(async () => { if (runtime) await runtime.stop(); });

  test("starts all instances with distinct ports", () => {
    expect(runtime.petstore.one).toBeDefined();
    expect(runtime.petstore.two).toBeDefined();
    expect(runtime.petstore.one.ports.http).not.toBe(runtime.petstore.two.ports.http);
  });

  test("typed API works on each instance and shares state", async () => {
    const a = await runtime.petstore.one.api.http.createPet({ name: "Alpha" });
    const b = await runtime.petstore.two.api.http.createPet({ name: "Beta" });
    expect(a.name).toBe("Alpha");
    expect(b.name).toBe("Beta");
    const listOne = await runtime.petstore.one.api.http.listPets();
    const listTwo = await runtime.petstore.two.api.http.listPets();
    const namesOne = listOne.items.map((p: { name: string }) => p.name).sort();
    const namesTwo = listTwo.items.map((p: { name: string }) => p.name).sort();
    expect(namesOne).toEqual(namesTwo);
    expect(namesOne).toContain("Alpha");
    expect(namesOne).toContain("Beta");
  });

  test("chaos.stop on multi-instance slot", async () => {
    const stoppedId = runtime.petstore.one.ports.http;
    await runtime.chaos.stop("petstore", "one");
    const snap = runtime.snapshot();
    const oneSnap = snap.components.find(
      (c: { name: string; instance: string }) => c.name === "petstore" && c.instance === "one",
    );
    expect(oneSnap?.running).toBe(false);
    // other instance still up
    const list = await runtime.petstore.two.api.http.listPets();
    expect(Array.isArray(list.items)).toBe(true);
    expect(stoppedId).toBeGreaterThan(0);
  });

  test("chaos.start re-binds with fresh ports and live api works", async () => {
    const oldPort = runtime.petstore.one.ports.http;
    const runningRef = runtime.petstore.one;
    await runtime.chaos.start("petstore", "one");
    const newPort = runtime.petstore.one.ports.http;
    expect(newPort).toBeGreaterThan(0);
    expect(newPort).not.toBe(oldPort);
    // user-held Running ref still works via mutation-in-place
    expect(runningRef).toBe(runtime.petstore.one);
    const list = await runningRef.api.http.listPets();
    expect(Array.isArray(list.items)).toBe(true);
  });

  test("chaos.restart shorthand", async () => {
    const oldPort = runtime.petstore.two.ports.http;
    await runtime.chaos.restart("petstore", "two");
    const newPort = runtime.petstore.two.ports.http;
    expect(newPort).not.toBe(oldPort);
    const list = await runtime.petstore.two.api.http.listPets();
    expect(Array.isArray(list.items)).toBe(true);
  });

  test("petstore primary-down causes 503 on writes", async () => {
    store.setPrimary(false);
    try {
      let caught: unknown;
      try {
        await runtime.petstore.one.api.http.createPet({ name: "Doomed" });
      } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      const err = caught as { kind: string; status: number };
      expect(err.kind).toBe("http_error");
      expect(err.status).toBe(503);
    } finally {
      store.setPrimary(true);
    }
  });
});
