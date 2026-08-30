import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import {
  http, iface, defineBlueprint, bind,
  type Environment, type HttpRouteMap, type EventCatalog,
  type LogParser,
} from "../../src/index";
import { startEnvironment } from "../../src/orchestrator";
import { createInMemoryAdapter } from "../../src/adapters/memory";
import { petstoreFake, createSharedPetStore } from "../fakes/petstore";

const PetSchema = z.object({ id: z.string(), name: z.string() });
const CreatePetInput = z.object({ name: z.string().min(1) });

const routes = {
  createPet: { method: "POST",   path: "/v1/pets",                    request: CreatePetInput, response: PetSchema },
  getPet:    { method: "GET",    path: (id: string) => `/v1/pets/${id}`,                      response: PetSchema },
  listPets:  { method: "GET",    path: "/v1/pets",                                            response: z.object({ items: z.array(PetSchema) }) },
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

const buildEnv = () => ({ petstore: petstoreBinding } as const satisfies Environment);

const buildAdapter = () => {
  const store = createSharedPetStore();
  return createInMemoryAdapter({
    factories: { "test/petstore:v1": petstoreFake({ instanceId: "one", store }) },
  });
};

describe("orchestrator/startEnvironment", () => {
  // biome-ignore lint/suspicious/noExplicitAny: typed runtime stashed for afterEach
  let runtime: any;
  afterEach(async () => { if (runtime) await runtime.stop(); runtime = undefined; });

  test("starts and exposes interface", async () => {
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "test",
    });
    expect(runtime.petstore.interface.http.uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("typed API works for create", async () => {
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "test",
    });
    const pet = await runtime.petstore.api.http.createPet({ name: "Fido" });
    expect(pet.name).toBe("Fido");
    expect(typeof pet.id).toBe("string");
  });

  test("list reads back created", async () => {
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "test",
    });
    await runtime.petstore.api.http.createPet({ name: "Rex" });
    const result = await runtime.petstore.api.http.listPets();
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.some((p: { name: string }) => p.name === "Rex")).toBe(true);
  });

  test("events flow via log parser", async () => {
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "test",
    });
    // Checkpoint first, act, then wait: the log line can land before the wait
    // is registered, and `waitFor` no longer scans back over history.
    const checkpoint = runtime.petstore.events.mark();
    await runtime.petstore.api.http.createPet({ name: "Spot" });
    const evt = await runtime.petstore.events.waitFor(
      "PETSTORE_REQUEST",
      { attributes: { method: "POST" }, after: checkpoint },
      2000,
    );
    expect(evt.attributes.method).toBe("POST");
  });

  test("snapshot reflects state", async () => {
    runtime = await startEnvironment(buildEnv(), {
      adapter: buildAdapter(), sessionId: "s1", envKey: "test",
    });
    const snap = runtime.snapshot();
    expect(snap.components[0].running).toBe(true);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test("stop tears down cleanly", async () => {
    const adapter = buildAdapter();
    const r = await startEnvironment(buildEnv(), {
      adapter, sessionId: "s1", envKey: "test",
    });
    const first = r.snapshot().components[0];
    if (!first || !first.containerId) throw new Error("no containerId");
    const containerId = first.containerId;
    await r.stop();
    runtime = undefined;
    expect(await adapter.exists(containerId)).toBe(false);
  });
});
