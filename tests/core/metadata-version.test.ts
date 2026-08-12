/**
 * Feature 4 — `bind({ version })` metadata invalidation.
 *
 * Verifies that the per-Binding `version` round-trips into the running
 * metadata file, that a matching version re-attaches to the live env, that
 * a differing version invalidates the metadata and rebuilds from scratch,
 * and that metadata written without a `version` (older Cyanotype) SKIPS the
 * check rather than false-invalidating.
 *
 * Uses the in-memory adapter — no Docker required.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  http, iface, defineBlueprint, bind, createSharedEnvs,
  type Environment, type HttpRouteMap, type Adapter,
} from "../../src/index";
import { createInMemoryAdapter } from "../../src/adapters/memory";
import { petstoreFake, createSharedPetStore } from "../fakes/petstore";

const PetSchema = z.object({ id: z.string(), name: z.string() });
const CreatePetInput = z.object({ name: z.string().min(1) });

const routes = {
  createPet: { method: "POST", path: "/v1/pets", request: CreatePetInput, response: PetSchema },
  getPet:    { method: "GET",  path: (id: string) => `/v1/pets/${id}`, response: PetSchema },
  listPets:  { method: "GET",  path: "/v1/pets", response: z.object({ items: z.array(PetSchema) }) },
} as const satisfies HttpRouteMap;

const petstoreBlueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (_cfg: Record<string, never>, _env: Record<string, string>, ports) => ({
    http: iface({ uri: `http://127.0.0.1:${ports.http}`, protocol: http(routes) }),
  }),
  readiness: { kind: "http", interfaceName: "http", path: "/health", statusMin: 200, statusMax: 299 },
});

const bindingForVersion = (version: string) =>
  bind(petstoreBlueprint, {
    image: "test/petstore:v1",
    version,
    config: {},
    env: {},
    ports: { http: "auto" },
  });

const buildAdapter = (): Adapter => {
  const store = createSharedPetStore();
  return createInMemoryAdapter({
    factories: { "test/petstore:v1": petstoreFake({ instanceId: "one", store }) },
  });
};

const registryForVersion = (version: string) => ({
  petstore: { petstore: bindingForVersion(version) } as const satisfies Environment,
});

describe("metadata version invalidation (Feature 4)", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "spec-ver-"));
  });
  afterEach(async () => {
    try { await fs.promises.rm(stateDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const readSnapshotVersion = (): string | undefined => {
    const raw = fs.readFileSync(path.join(stateDir, "petstore.json"), "utf8");
    const meta = JSON.parse(raw) as {
      components: { petstore: { kind: "single"; snapshot: { version?: string } } };
    };
    return meta.components.petstore.snapshot.version;
  };

  test("version round-trips into running metadata", async () => {
    const shared = createSharedEnvs(registryForVersion("v1"), { adapter: buildAdapter(), stateDir });
    await shared.ensure("petstore");
    expect(readSnapshotVersion()).toBe("v1");
    await shared.stopAll();
  });

  test("matching version re-attaches to the existing environment", async () => {
    const adapter = buildAdapter();
    const s1 = createSharedEnvs(registryForVersion("v1"), { adapter, stateDir });
    const r1 = await s1.ensure("petstore");
    const cid1 = r1.snapshot().components[0]?.containerId;

    // Same version: a fresh harness must attach to the same container.
    const s2 = createSharedEnvs(registryForVersion("v1"), { adapter, stateDir });
    const r2 = await s2.ensure("petstore");
    expect(r2.snapshot().components[0]?.containerId).toBe(cid1);
    await s1.stopAll();
  });

  test("differing version invalidates metadata and rebuilds from scratch", async () => {
    const adapter = buildAdapter();
    const s1 = createSharedEnvs(registryForVersion("v1"), { adapter, stateDir });
    const r1 = await s1.ensure("petstore");
    const cid1 = r1.snapshot().components[0]?.containerId;
    expect(readSnapshotVersion()).toBe("v1");

    // Bump the binding version: re-ensure must invalidate + re-race, yielding
    // a brand-new container and a metadata file carrying the new version.
    const s2 = createSharedEnvs(registryForVersion("v2"), { adapter, stateDir });
    const r2 = await s2.ensure("petstore");
    const cid2 = r2.snapshot().components[0]?.containerId;
    expect(cid2).not.toBe(cid1);
    expect(readSnapshotVersion()).toBe("v2");
    const list = await r2.petstore.api.http.listPets();
    expect(Array.isArray(list.items)).toBe(true);
    await s2.stopAll();
  });

  test("multi-instance round-trip: matching versions attach, drift on one instance invalidates", async () => {
    const envFor = (versionA: string, versionB: string) =>
      ({
        petstore: {
          a: bind(petstoreBlueprint, {
            image: "test/petstore:v1", version: versionA,
            config: {}, env: {}, ports: { http: "auto" },
          }),
          b: bind(petstoreBlueprint, {
            image: "test/petstore:v1", version: versionB,
            config: {}, env: {}, ports: { http: "auto" },
          }),
        },
      } as const satisfies Environment);
    const registryFor = (versionA: string, versionB: string) =>
      ({ main: envFor(versionA, versionB) });

    const store = createSharedPetStore();
    const adapter = createInMemoryAdapter({
      factories: { "test/petstore:v1": petstoreFake({ instanceId: "multi", store }) },
    });

    const s1 = createSharedEnvs(registryFor("v1", "v1"), { adapter, stateDir });
    const r1 = await s1.ensure("main");
    const comps1 = r1.snapshot().components;
    const cidA1 = comps1.find((c) => c.instance === "a")?.containerId;
    const cidB1 = comps1.find((c) => c.instance === "b")?.containerId;
    expect(cidA1).toBeDefined();
    expect(cidB1).toBeDefined();

    // Metadata records version per instance under the multi snapshot shape.
    const rawAfterStart = fs.readFileSync(path.join(stateDir, "main.json"), "utf8");
    const metaAfterStart = JSON.parse(rawAfterStart) as {
      components: { petstore: { kind: "multi"; instances: Record<string, { version?: string }> } };
    };
    expect(metaAfterStart.components.petstore.kind).toBe("multi");
    expect(metaAfterStart.components.petstore.instances.a?.version).toBe("v1");
    expect(metaAfterStart.components.petstore.instances.b?.version).toBe("v1");

    // Matching versions on both instances: a fresh harness must attach.
    const s2 = createSharedEnvs(registryFor("v1", "v1"), { adapter, stateDir });
    const r2 = await s2.ensure("main");
    const comps2 = r2.snapshot().components;
    expect(comps2.find((c) => c.instance === "a")?.containerId).toBe(cidA1);
    expect(comps2.find((c) => c.instance === "b")?.containerId).toBe(cidB1);

    // Drift on one instance must invalidate the whole environment and rebuild.
    const s3 = createSharedEnvs(registryFor("v1", "v2"), { adapter, stateDir });
    const r3 = await s3.ensure("main");
    const comps3 = r3.snapshot().components;
    const cidA3 = comps3.find((c) => c.instance === "a")?.containerId;
    const cidB3 = comps3.find((c) => c.instance === "b")?.containerId;
    expect(cidA3).not.toBe(cidA1);
    expect(cidB3).not.toBe(cidB1);
    await s3.stopAll();
  });

  test("absent stored version skips the check (no false invalidation)", async () => {
    const adapter = buildAdapter();
    const s1 = createSharedEnvs(registryForVersion("v1"), { adapter, stateDir });
    const r1 = await s1.ensure("petstore");
    const cid1 = r1.snapshot().components[0]?.containerId;

    // Simulate metadata written by an older Cyanotype: strip `version` from
    // the snapshot. s1 stays alive so the container is still present.
    const raw = fs.readFileSync(path.join(stateDir, "petstore.json"), "utf8");
    const meta = JSON.parse(raw) as {
      components: { petstore: { kind: "single"; snapshot: Record<string, unknown> } };
    };
    delete meta.components.petstore.snapshot.version;
    fs.writeFileSync(
      path.join(stateDir, "petstore.json"),
      JSON.stringify({ ...meta, state: "running" }),
    );

    // Even though the binding is now v2, an absent stored version must NOT
    // invalidate — the harness attaches to the existing container.
    const s2 = createSharedEnvs(registryForVersion("v2"), { adapter, stateDir });
    const r2 = await s2.ensure("petstore");
    expect(r2.snapshot().components[0]?.containerId).toBe(cid1);
    await s1.stopAll();
  });
});
