/**
 * Owned-lifecycle SPI: `Started.owned` (adapter return) and
 * `ComponentSnapshot.owned` (metadata) wire substrate ownership through the
 * orchestrator. Owned components have their containers stopped on
 * `runtime.stop()` and on cross-process invalidation; non-owned components
 * are detached (log streams aborted, state marked stopped) without touching
 * the underlying container.
 *
 * Invariants covered:
 *   - `runtime.stop()` calls `adapter.stop` only for owned components.
 *   - `attachOne` always produces `owned: false`, regardless of the
 *     snapshot's `owned` field.
 *   - `metadata()` snapshot writes `owned: false` for non-owned components
 *     and OMITS the field for owned components (byte-stable with pre-0.4.0
 *     readers).
 *   - `stopAllInMeta` (triggered via version drift in `startOrAttach`) only
 *     stops owned containers; absent `owned` in the snapshot is treated as
 *     fully owned for backward compat.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defineBlueprint, bind, createSharedEnvs, startEnvironment, attachEnvironment,
  type Adapter, type Environment, type StartSpec, type Started,
} from "../../src/index";

// ----------------------------------------------------------------------
// Recording adapter — minimal substrate that lets each test choose
// per-image ownership and observe every `adapter.stop()` call.
// ----------------------------------------------------------------------

type RecordingAdapter = Adapter & {
  readonly stops: string[];
  readonly starts: string[];
  readonly setOwnership: (image: string, owned: boolean) => void;
};

const createRecordingAdapter = (initial?: Record<string, boolean>): RecordingAdapter => {
  const ownership = new Map<string, boolean>(Object.entries(initial ?? {}));
  const live = new Set<string>();
  const stops: string[] = [];
  const starts: string[] = [];
  let counter = 0;

  const adapter: Adapter = {
    name: "recording",
    connect: async () => { /* noop */ },
    disconnect: async () => { /* noop */ },
    teardown: async () => { /* noop */ },
    start: async (spec: StartSpec): Promise<Started> => {
      counter += 1;
      const containerId = `rec-${counter}`;
      live.add(containerId);
      starts.push(containerId);
      const owned = ownership.get(spec.image) ?? true;
      const resolvedPorts: Record<string, number> = {};
      for (const [name, requested] of Object.entries(spec.ports)) {
        resolvedPorts[name] = requested === "auto" ? 40000 + counter : requested;
      }
      return { containerId, ports: resolvedPorts, owned };
    },
    stop: async (containerId: string): Promise<void> => {
      stops.push(containerId);
      live.delete(containerId);
    },
    // biome-ignore lint/correctness/useYield: empty stream
    logs: async function* () { /* no log lines */ },
    exists: async (containerId: string) => live.has(containerId),
  };
  return Object.assign(adapter, {
    stops, starts,
    setOwnership: (image: string, owned: boolean) => { ownership.set(image, owned); },
  });
};

// ----------------------------------------------------------------------
// Trivial Blueprint — no interface, no readiness, no log parser. The
// ownership invariants live entirely in orchestrator/shared glue.
// ----------------------------------------------------------------------

const trivialBlueprint = defineBlueprint({
  portNames: ["tcp"] as const,
  interface: (_cfg: Record<string, never>, _env: Record<string, string>, _ports) => ({}),
});

const trivialBinding = (image: string, version = "v1") =>
  bind(trivialBlueprint, {
    image,
    version,
    config: {},
    env: {},
    ports: { tcp: "auto" },
  });

describe("orchestrator/owned-lifecycle", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "spec-owned-"));
  });
  afterEach(async () => {
    try { await fs.promises.rm(stateDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // --------------------------------------------------------------------
  // runtime.stop() — owned vs non-owned per-component behaviour.
  // --------------------------------------------------------------------

  test("runtime.stop() on an owned component calls adapter.stop", async () => {
    const adapter = createRecordingAdapter({ "img/a": true });
    const env: Environment = { svc: trivialBinding("img/a") };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    const containerId = runtime.snapshot().components[0]?.containerId;
    expect(containerId).toBeDefined();
    await runtime.stop();
    expect(adapter.stops).toEqual([containerId as string]);
  });

  test("runtime.stop() on a non-owned component does NOT call adapter.stop", async () => {
    const adapter = createRecordingAdapter({ "img/a": false });
    const env: Environment = { svc: trivialBinding("img/a") };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    await runtime.stop();
    expect(adapter.stops).toEqual([]);
  });

  test("runtime.stop() on a mixed env stops only owned components", async () => {
    const adapter = createRecordingAdapter({ "img/owned": true, "img/external": false });
    const env: Environment = {
      ownedSvc: trivialBinding("img/owned"),
      externalSvc: trivialBinding("img/external"),
    };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    const comps = runtime.snapshot().components;
    const ownedId = comps.find((c) => c.name === "ownedSvc")?.containerId;
    await runtime.stop();
    expect(adapter.stops).toEqual([ownedId as string]);
  });

  // --------------------------------------------------------------------
  // Started.owned wiring — adapter return value flows into ComponentState.
  // --------------------------------------------------------------------

  test("Started.owned=true produces an owned runtime that stops the container", async () => {
    const adapter = createRecordingAdapter({ "img/a": true });
    const env: Environment = { svc: trivialBinding("img/a") };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    await runtime.stop();
    expect(adapter.stops.length).toBe(1);
  });

  test("Started.owned=false produces a non-owned runtime that detaches without stopping", async () => {
    const adapter = createRecordingAdapter({ "img/a": false });
    const env: Environment = { svc: trivialBinding("img/a") };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    await runtime.stop();
    expect(adapter.stops.length).toBe(0);
  });

  // --------------------------------------------------------------------
  // metadata() — owned: false written; owned: true omits the field.
  // --------------------------------------------------------------------

  test("metadata() omits `owned` for owned components (byte-stable with pre-0.4.0 readers)", async () => {
    const adapter = createRecordingAdapter({ "img/a": true });
    const env: Environment = { svc: trivialBinding("img/a") };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    const meta = runtime.metadata();
    const slot = meta.components.svc;
    expect(slot?.kind).toBe("single");
    if (slot?.kind === "single") {
      expect(Object.hasOwn(slot.snapshot, "owned")).toBe(false);
    }
    await runtime.stop();
  });

  test("metadata() writes `owned: false` for non-owned components", async () => {
    const adapter = createRecordingAdapter({ "img/a": false });
    const env: Environment = { svc: trivialBinding("img/a") };
    const runtime = await startEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" });
    const meta = runtime.metadata();
    const slot = meta.components.svc;
    if (slot?.kind === "single") {
      expect(slot.snapshot.owned).toBe(false);
    } else {
      throw new Error("expected single slot");
    }
    await runtime.stop();
  });

  // --------------------------------------------------------------------
  // attachOne — hardcodes owned: false regardless of snapshot.
  // --------------------------------------------------------------------

  test("attachEnvironment always builds non-owned ComponentState (cross-process re-attach is no-op on stop)", async () => {
    // Process A: starts owned env, writes metadata.
    const adapterA = createRecordingAdapter({ "img/a": true });
    const env: Environment = { svc: trivialBinding("img/a") };
    const sharedA = createSharedEnvs({ env }, { adapter: adapterA, stateDir });
    const rA = await sharedA.ensure("env");
    const cidA = rA.snapshot().components[0]?.containerId;

    // Process B: same metadata, fresh adapter — attaches.
    const adapterB = createRecordingAdapter({ "img/a": true });
    // Pre-seed B's live set by adopting the container id from A's metadata via exists().
    // Easier: have B's start be irrelevant; attach() uses snapshot.containerId.
    // We need adapterB.exists(cidA) to be true. Inject it directly.
    (adapterB as unknown as { stops: string[] }); // noop typing
    // Stash the id into B's live registry by calling start in a controlled way:
    // simpler — wrap exists.
    const liveOverride = new Set<string>([cidA as string]);
    const origExists = adapterB.exists;
    adapterB.exists = async (id: string) => liveOverride.has(id) || origExists(id);

    const sharedB = createSharedEnvs({ env }, { adapter: adapterB, stateDir });
    const rB = await sharedB.attach("env");
    expect(rB.snapshot().components[0]?.containerId).toBe(cidA);
    await rB.stop();
    // B never owns: stop must be a no-op on the adapter.
    expect(adapterB.stops).toEqual([]);

    // A still owns: cleanup stops its container.
    await sharedA.stopAll();
    expect(adapterA.stops).toContain(cidA as string);
  });

  test("attachEnvironment ignores a snapshot that claims owned=true and stays non-owned", async () => {
    const adapter = createRecordingAdapter({ "img/a": true });
    // Pre-populate the adapter's live registry by starting once and capturing the id.
    const env: Environment = { svc: trivialBinding("img/a") };
    const r = await startEnvironment(env, { adapter, sessionId: "s0", envKey: "seed" });
    const cid = r.snapshot().components[0]?.containerId as string;

    // Build a snapshot WITHOUT owned (pre-0.4.0 shape) and re-attach.
    const attached = await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" }, {
      components: {
        svc: { kind: "single", snapshot: { containerId: cid, ports: { tcp: 1 } } },
      },
    });
    const stopsBefore = adapter.stops.length;
    await attached.stop();
    // Attach never owns: stop must not call adapter.stop.
    expect(adapter.stops.length).toBe(stopsBefore);

    // The original owned runtime still cleans up.
    await r.stop();
    expect(adapter.stops).toContain(cid);
  });

  // --------------------------------------------------------------------
  // stopAllInMeta — version-drift path; respects per-snapshot `owned`.
  // --------------------------------------------------------------------

  test("stopAllInMeta (via version drift) stops only owned components", async () => {
    const adapter = createRecordingAdapter({ "img/owned": true, "img/external": false });
    const envV = (v: string): Environment => ({
      ownedSvc: trivialBinding("img/owned", v),
      externalSvc: trivialBinding("img/external", v),
    });
    const sharedV1 = createSharedEnvs({ main: envV("v1") }, { adapter, stateDir });
    const r1 = await sharedV1.ensure("main");
    const ownedId = r1.snapshot().components.find((c) => c.name === "ownedSvc")?.containerId;
    const externalId = r1.snapshot().components.find((c) => c.name === "externalSvc")?.containerId;
    expect(ownedId).toBeDefined();
    expect(externalId).toBeDefined();

    // Don't stop r1; leave containers live in the adapter so the next harness
    // sees `exists()=true` and proceeds to the version-stale branch that
    // calls stopAllInMeta.
    adapter.stops.length = 0;

    const sharedV2 = createSharedEnvs({ main: envV("v2") }, { adapter, stateDir });
    const r2 = await sharedV2.ensure("main");

    // The stale-invalidation path must have stopped only the owned one.
    expect(adapter.stops).toContain(ownedId as string);
    expect(adapter.stops).not.toContain(externalId as string);

    await sharedV2.stopAll();
  });

  test("stopAllInMeta treats absent `owned` as fully owned (pre-0.4.0 metadata back-compat)", async () => {
    const adapter = createRecordingAdapter({ "img/a": true });
    const env: Environment = { svc: trivialBinding("img/a", "v1") };
    const shared1 = createSharedEnvs({ main: env }, { adapter, stateDir });
    const r1 = await shared1.ensure("main");
    const cid = r1.snapshot().components[0]?.containerId as string;

    // Rewrite metadata in the pre-0.4.0 shape: strip `owned` from the snapshot.
    const filePath = path.join(stateDir, "main.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      components: { svc: { kind: "single"; snapshot: Record<string, unknown> } };
    };
    delete raw.components.svc.snapshot.owned;
    fs.writeFileSync(filePath, JSON.stringify({ ...raw, state: "running" }));

    adapter.stops.length = 0;
    // Bump the binding version so the next ensure hits the version-stale +
    // stopAllInMeta branch.
    const envV2: Environment = { svc: trivialBinding("img/a", "v2") };
    const shared2 = createSharedEnvs({ main: envV2 }, { adapter, stateDir });
    const r2 = await shared2.ensure("main");

    // Absent `owned` was treated as fully owned: the v1 container was stopped.
    expect(adapter.stops).toContain(cid);

    await shared2.stopAll();
    // Touch r2 so the var isn't dead-code-eliminated by the linter.
    expect(r2.snapshot().status).toBe("running");
  });
});
