import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  http, iface, defineBlueprint, bind, createSharedEnvs,
  type Environment, type HttpRouteMap, type EventCatalog, type LogParser,
  type Adapter,
} from "../../src/index";
import { createInMemoryAdapter } from "../../src/adapters/memory";
import { petstoreFake, createSharedPetStore } from "../fakes/petstore";

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
    http: iface({ uri: `http://127.0.0.1:${ports.http}`, protocol: http(routes) }),
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

const buildAdapter = (): Adapter => {
  const store = createSharedPetStore();
  return createInMemoryAdapter({
    factories: { "test/petstore:v1": petstoreFake({ instanceId: "one", store }) },
  });
};

const buildRegistry = () => ({
  petstore: { petstore: petstoreBinding } as const satisfies Environment,
});

describe("shared/createSharedEnvs", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "spec-test-"));
  });

  afterEach(async () => {
    try { await fs.promises.rm(stateDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test("startOrAttach: first call starts and persists running metadata", async () => {
    const shared = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir });
    const runtime = await shared.ensure("petstore");
    const result = await runtime.petstore.api.http.listPets();
    expect(Array.isArray(result.items)).toBe(true);
    const fileRaw = await fs.promises.readFile(path.join(stateDir, "petstore.json"), "utf8");
    const meta = JSON.parse(fileRaw) as { state: string };
    expect(meta.state).toBe("running");
    await shared.stopAll();
  });

  test("startOrAttach: second ensure in same process returns cached identity", async () => {
    const shared = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir });
    const r1 = await shared.ensure("petstore");
    const r2 = await shared.ensure("petstore");
    expect(r1).toBe(r2);
    await shared.stopAll();
  });

  test("two instances racing on the same stateDir: exactly one owns", async () => {
    const adapter = buildAdapter();
    const a = createSharedEnvs(buildRegistry(), { adapter, stateDir });
    const b = createSharedEnvs(buildRegistry(), { adapter, stateDir });
    const [ra, rb] = await Promise.all([a.ensure("petstore"), b.ensure("petstore")]);
    const la = await ra.petstore.api.http.listPets();
    const lb = await rb.petstore.api.http.listPets();
    expect(Array.isArray(la.items)).toBe(true);
    expect(Array.isArray(lb.items)).toBe(true);
    await a.stopAll();
    await b.stopAll();
    expect(fs.existsSync(path.join(stateDir, "petstore.json"))).toBe(false);
  });

  test("dead-container fallback: kill container externally, ensure restarts", async () => {
    const adapter = buildAdapter();
    const shared = createSharedEnvs(buildRegistry(), { adapter, stateDir });
    const r1 = await shared.ensure("petstore");
    const snap1 = r1.snapshot();
    const cid = snap1.components[0]?.containerId;
    expect(cid).toBeDefined();
    if (!cid) throw new Error("no containerId");
    await r1.stop();
    await adapter.stop(cid);
    // simulate stale metadata file from previous run, no longer cached
    const meta = r1.metadata();
    await fs.promises.writeFile(
      path.join(stateDir, "petstore.json"),
      JSON.stringify({ ...meta, state: "running" }),
    );
    const shared2 = createSharedEnvs(buildRegistry(), { adapter, stateDir });
    const r2 = await shared2.ensure("petstore");
    const list = await r2.petstore.api.http.listPets();
    expect(Array.isArray(list.items)).toBe(true);
    await shared2.stopAll();
  });

  test("stale claim recovery: starting file older than 90s is deleted and re-raced", async () => {
    const stalePayload = {
      schemaVersion: 1, envKey: "petstore", state: "starting",
      pid: process.pid, startedAt: Date.now() - 100_000,
    };
    await fs.promises.writeFile(path.join(stateDir, "petstore.json"), JSON.stringify(stalePayload));
    const shared = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir });
    const runtime = await shared.ensure("petstore");
    const list = await runtime.petstore.api.http.listPets();
    expect(Array.isArray(list.items)).toBe(true);
    await shared.stopAll();
  });

  test("mode 'attach' with no metadata throws", async () => {
    const shared = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir, mode: "attach" });
    let caught: unknown;
    try { await shared.ensure("petstore"); } catch (e) { caught = e; }
    expect((caught as { kind: string }).kind).toBe("attach_no_metadata");
  });

  test("mode 'start' with existing metadata throws", async () => {
    const shared1 = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir });
    await shared1.ensure("petstore");
    const shared2 = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir, mode: "start" });
    let caught: unknown;
    try { await shared2.ensure("petstore"); } catch (e) { caught = e; }
    expect((caught as { kind: string }).kind).toBe("start_metadata_exists");
    await shared1.stopAll();
  });

  test("stopAll deletes metadata for owned envs", async () => {
    const shared = createSharedEnvs(buildRegistry(), { adapter: buildAdapter(), stateDir });
    await shared.ensure("petstore");
    const filePath = path.join(stateDir, "petstore.json");
    expect(fs.existsSync(filePath)).toBe(true);
    await shared.stopAll();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
