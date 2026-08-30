/**
 * Attach-path readiness.
 *
 * `adapter.exists()` proves a container is present, not that it serves. Attach
 * is the case readiness was written for — a warm stack whose components may be
 * mid-restart, or a sibling worker that wrote metadata the instant its
 * containers came up — so `attachEnvironment` must run the Blueprint probe
 * before handing back a runtime, exactly as `startEnvironment` does.
 *
 * The load-bearing assertion is the probe CALL COUNT. A test that only checks
 * "attach succeeded" cannot tell a probe that ran and passed from a probe that
 * never ran at all, which is the bug this file exists to prevent.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  defineBlueprint, bind, iface, opaque, startEnvironment, attachEnvironment,
  type Adapter, type Environment, type StartSpec, type Started,
} from "../../src/index";

let probeCalls = 0;
let healthy = true;

const createStubAdapter = (): Adapter => {
  const live = new Set<string>();
  let counter = 0;
  return {
    name: "stub",
    connect: async () => { /* noop */ },
    disconnect: async () => { /* noop */ },
    teardown: async () => { /* noop */ },
    start: async (spec: StartSpec): Promise<Started> => {
      counter += 1;
      const containerId = `stub-${counter}`;
      live.add(containerId);
      const ports: Record<string, number> = {};
      for (const [name, requested] of Object.entries(spec.ports)) {
        ports[name] = requested === "auto" ? 45000 + counter : requested;
      }
      return { containerId, ports, owned: true };
    },
    stop: async (containerId: string) => { live.delete(containerId); },
    // biome-ignore lint/correctness/useYield: empty stream
    logs: async function* () { /* no log lines */ },
    exists: async (containerId: string) => live.has(containerId),
  };
};

const blueprint = defineBlueprint({
  portNames: ["tcp"] as const,
  interface: (_cfg: Record<string, never>, _env: Record<string, string>, ports) => ({
    tcp: iface({ uri: `tcp://127.0.0.1:${ports.tcp}`, protocol: opaque() }),
  }),
  readiness: {
    kind: "custom",
    check: async () => { probeCalls += 1; return healthy; },
    timeoutMs: 300,
    intervalMs: 50,
  },
});

const binding = bind(blueprint, {
  image: "stub/svc:v1",
  version: "v1",
  config: {},
  env: {},
  ports: { tcp: "auto" },
});

const env: Environment = { svc: binding };

describe("orchestrator/attach readiness", () => {
  beforeEach(() => { probeCalls = 0; healthy = true; });

  test("attach runs the Blueprint probe before returning a runtime", async () => {
    const adapter = createStubAdapter();
    const started = await startEnvironment(env, { adapter, sessionId: "s0", envKey: "seed" });
    const cid = started.snapshot().components[0]?.containerId as string;
    const ports = started.snapshot().components[0]?.ports as Record<string, number>;

    const callsAfterStart = probeCalls;
    expect(callsAfterStart).toBeGreaterThan(0);

    const attached = await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" }, {
      components: { svc: { kind: "single", snapshot: { containerId: cid, ports } } },
    });

    expect(probeCalls).toBeGreaterThan(callsAfterStart);

    await attached.stop();
    await started.stop();
  });

  test("attach rejects when the component is present but not serving", async () => {
    const adapter = createStubAdapter();
    const started = await startEnvironment(env, { adapter, sessionId: "s0", envKey: "seed" });
    const cid = started.snapshot().components[0]?.containerId as string;
    const ports = started.snapshot().components[0]?.ports as Record<string, number>;

    healthy = false;
    let caught: unknown;
    try {
      await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" }, {
        components: { svc: { kind: "single", snapshot: { containerId: cid, ports } } },
      });
    } catch (e) { caught = e; }

    const err = caught as { kind: string; componentName: string; cause: { kind: string } };
    expect(err.kind).toBe("attach_probe_failed");
    expect(err.componentName).toBe("svc");
    expect(err.cause.kind).toBe("probe_timeout");

    healthy = true;
    await started.stop();
  });

  test("attachReadinessTimeoutMs bounds the total probe time, not just each probe", async () => {
    const adapter = createStubAdapter();
    const started = await startEnvironment(env, { adapter, sessionId: "s0", envKey: "seed" });
    const cid = started.snapshot().components[0]?.containerId as string;
    const ports = started.snapshot().components[0]?.ports as Record<string, number>;

    // The Blueprint's own probe would run for 300ms; the aggregate ceiling is
    // shorter, so it wins and the probe is aborted rather than timing out.
    healthy = false;
    const begun = Date.now();
    let caught: unknown;
    try {
      await attachEnvironment(
        env,
        { adapter, sessionId: "s1", envKey: "e1", attachReadinessTimeoutMs: 80 },
        { components: { svc: { kind: "single", snapshot: { containerId: cid, ports } } } },
      );
    } catch (e) { caught = e; }

    const err = caught as { kind: string; cause: { kind: string } };
    expect(err.kind).toBe("attach_probe_failed");
    expect(err.cause.kind).toBe("probe_aborted");
    expect(Date.now() - begun).toBeLessThan(300);

    healthy = true;
    await started.stop();
  });
});
