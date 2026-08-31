/**
 * Substrate identity in persisted metadata (D-041).
 *
 * `<stateDir>/<envKey>.json` records the container ids of a running
 * environment. Those ids are only meaningful to the substrate that produced
 * them, so flipping `CYANOTYPE_ADAPTER` between runs leaves a file the next
 * adapter cannot interpret.
 *
 * Before this check existed it still "worked", by accident: `exists()` was
 * handed a foreign container id, said no, and the dead-container path rebuilt.
 * That is undocumented, depends on every adapter returning false rather than
 * throwing for an id shape it has never seen, and in pure attach mode reports
 * `attach_dead_container` — which the docs explain as a stack rebuilt outside
 * Cyanotype's control, a confidently wrong diagnosis.
 *
 * The load-bearing assertions are the ERROR KIND in attach mode and the fact
 * that the containers are REBUILT rather than reused in startOrAttach. A test
 * that only checked "it didn't throw" cannot tell a fresh environment from a
 * silently reused foreign one.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import {
  defineBlueprint, bind, iface, opaque, createSharedEnvs,
  type Adapter, type Environment, type StartSpec, type Started,
} from "../../src/index";

const STATE_DIR = ".cyanotype-test-substrate";

/**
 * Two adapters that differ only in `name` — the field under test.
 *
 * `exists` answers by id PREFIX rather than from instance-local state, because
 * a real substrate can see containers a different process started. That is the
 * entire reason the metadata file exists, and an adapter that only recognised
 * its own instance's containers would make the backward-compatibility case
 * below pass for the wrong reason.
 */
const stubAdapter = (
  name: string,
  opts: { readonly existsAnything?: boolean } = {},
): Adapter => {
  const removed = new Set<string>();
  let n = 0;
  return {
    name,
    connect: async () => { /* noop */ },
    disconnect: async () => { /* noop */ },
    teardown: async () => { /* noop */ },
    start: async (_spec: StartSpec): Promise<Started> => {
      n += 1;
      return { containerId: `${name}-${n}`, ports: { tcp: 40000 + n }, owned: true };
    },
    stop: async (id: string) => { removed.add(id); },
    logs: async function* () { /* no lines */ },
    // `existsAnything` models the substrate this check actually protects
    // against: one that does not reject an id shape it has never issued. The
    // SPI does not require adapters to, so the old accidental behaviour —
    // exists() says no, dead-container path rebuilds — cannot be relied on.
    exists: async (id: string) =>
      !removed.has(id) && (opts.existsAnything === true || id.startsWith(`${name}-`)),
  };
};

const blueprint = defineBlueprint({
  portNames: ["tcp"] as const,
  interface: (_c: Record<string, never>, _e: Record<string, string>, ports) => ({
    tcp: iface({ uri: `tcp://127.0.0.1:${ports.tcp}`, protocol: opaque() }),
  }),
});

const env: Environment = {
  svc: bind(blueprint, {
    image: "stub/svc:v1", version: "v1", config: {}, env: {}, ports: { tcp: "auto" },
  }),
};

const readMeta = () =>
  JSON.parse(readFileSync(`${STATE_DIR}/main.json`, "utf8")) as { adapter?: string };

describe("shared/substrate mismatch", () => {
  beforeEach(() => { rmSync(STATE_DIR, { recursive: true, force: true }); });
  afterEach(() => { rmSync(STATE_DIR, { recursive: true, force: true }); });

  test("metadata records the substrate that started the environment", async () => {
    const shared = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("alpha"), stateDir: STATE_DIR, mode: "start",
    });
    await shared.ensure("main");
    expect(readMeta().adapter).toBe("alpha");
    await shared.stopAll();
  });

  test("startOrAttach rebuilds rather than reusing another substrate's containers", async () => {
    const first = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("alpha"), stateDir: STATE_DIR, mode: "startOrAttach",
    });
    const r1 = await first.ensure("main");
    const idA = r1.snapshot().components[0]?.containerId;
    expect(idA).toBe("alpha-1");

    // A different substrate, same state dir, and one that would happily claim
    // alpha's container id exists. Without the substrate check this attaches to
    // another substrate's containers instead of rebuilding.
    const second = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("beta", { existsAnything: true }),
      stateDir: STATE_DIR, mode: "startOrAttach",
    });
    const r2 = await second.ensure("main");
    const idB = r2.snapshot().components[0]?.containerId;

    expect(idB).toBe("beta-1");
    expect(idB).not.toBe(idA);
    expect(readMeta().adapter).toBe("beta");

    await second.stopAll();
    await first.stopAll();
  });

  test("attach mode refuses, naming both substrates", async () => {
    const first = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("alpha"), stateDir: STATE_DIR, mode: "start",
    });
    await first.ensure("main");

    const second = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("beta"), stateDir: STATE_DIR, mode: "attach",
    });
    let caught: unknown;
    try { await second.ensure("main"); } catch (e) { caught = e; }

    const err = caught as { kind: string; expected: string; found: string };
    expect(err.kind).toBe("attach_substrate_mismatch");
    expect(err.expected).toBe("beta");
    expect(err.found).toBe("alpha");

    // The file is left intact: attach owns nothing and must not delete state
    // another process may still be using.
    expect(existsSync(`${STATE_DIR}/main.json`)).toBe(true);

    await first.stopAll();
  });

  test("metadata without an adapter field still attaches", async () => {
    const first = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("alpha"), stateDir: STATE_DIR, mode: "start",
    });
    await first.ensure("main");

    // Simulate a file written by a Cyanotype that predates the field.
    const raw = JSON.parse(readFileSync(`${STATE_DIR}/main.json`, "utf8")) as Record<string, unknown>;
    delete raw.adapter;
    await Bun.write(`${STATE_DIR}/main.json`, JSON.stringify(raw));

    const second = createSharedEnvs({ main: env }, {
      adapter: stubAdapter("alpha"), stateDir: STATE_DIR, mode: "attach",
    });
    const r = await second.ensure("main");
    expect(r.snapshot().components[0]?.containerId).toBe("alpha-1");

    await first.stopAll();
  });
});
