/**
 * `Adapter.reconnect` — the optional SPI method (D-046).
 *
 * The defect it exists for: `Started.ports` is durable only where it is a real
 * host binding. Kubernetes deploy mode reports `kubectl port-forward` locals,
 * which die with the process that opened them, so a second process attaching
 * from persisted metadata finds closed ports and burns its whole readiness
 * budget against them.
 *
 * The load-bearing assertion is that attach uses the ports `reconnect`
 * RETURNS rather than the ones the snapshot recorded. A test that only checks
 * "attach succeeded" cannot tell a reconnect that ran from one that never did
 * — the snapshot's ports work fine in a stub. So the stub deliberately hands
 * back different numbers, and the negative control is an adapter without the
 * method, which must keep using the snapshot's.
 */

import { describe, test, expect } from "bun:test";
import {
  defineBlueprint, bind, iface, opaque, attachEnvironment,
  type Adapter, type Environment, type StartSpec, type Started,
  type ReconnectSpec, type Reconnected,
} from "../../src/index";

const SNAPSHOT_PORT = 45001;
const RECONNECTED_PORT = 51001;

const blueprint = defineBlueprint({
  portNames: ["tcp"] as const,
  interface: (_cfg: Record<string, never>, _env: Record<string, string>, ports) => ({
    tcp: iface({ uri: `tcp://127.0.0.1:${ports.tcp}`, host: "127.0.0.1", port: ports.tcp, protocol: opaque() }),
  }),
});

const binding = bind(blueprint, {
  image: "stub/svc:v1", version: "v1", config: {}, env: {}, ports: { tcp: "auto" },
});
const env: Environment = { svc: binding };

const base = (): Omit<Adapter, "reconnect"> => ({
  name: "stub",
  connect: async () => { /* noop */ },
  disconnect: async () => { /* noop */ },
  teardown: async () => { /* noop */ },
  start: async (spec: StartSpec): Promise<Started> => ({
    containerId: "c1",
    ports: Object.fromEntries(Object.keys(spec.ports).map((n) => [n, SNAPSHOT_PORT])),
    owned: true,
  }),
  stop: async () => { /* noop */ },
  logs: async function* () { /* none */ },
  exists: async () => true,
});

const snapshot = { components: { svc: { kind: "single" as const, snapshot: { containerId: "c1", ports: { tcp: SNAPSHOT_PORT } } } } };

describe("adapter/reconnect (D-046)", () => {
  test("attach uses the ports reconnect returns, not the ones recorded", async () => {
    const seen: ReconnectSpec[] = [];
    const adapter: Adapter = {
      ...base(),
      reconnect: async (spec: ReconnectSpec): Promise<Reconnected> => {
        seen.push(spec);
        return { containerId: spec.containerId, ports: { tcp: RECONNECTED_PORT } };
      },
    };

    const rt = await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" }, snapshot);
    expect(rt.snapshot().components[0]?.ports.tcp).toBe(RECONNECTED_PORT);
    // The interface is derived from those ports, so the whole api surface
    // points at the reconnected port rather than the dead recorded one.
    const svc = rt.svc as unknown as { interface: { tcp: { port: number } } };
    expect(svc.interface.tcp.port).toBe(RECONNECTED_PORT);
    expect(seen).toHaveLength(1);
    await rt.stop();
  });

  test("NEGATIVE CONTROL: without the method, the recorded ports are used", async () => {
    // Proves the test above is discriminating. If attach ignored `reconnect`
    // entirely, this case and that one would both pass.
    const rt = await attachEnvironment(env, { adapter: base() as Adapter, sessionId: "s1", envKey: "e1" }, snapshot);
    expect(rt.snapshot().components[0]?.ports.tcp).toBe(SNAPSHOT_PORT);
    await rt.stop();
  });

  test("reconnect is given the identity that survives the process boundary", async () => {
    // `cyanotype.env` + component + instance is what a later process can match
    // on; `cyanotype.session` identifies the adapter that CREATED the container
    // and never matches from here.
    let got: ReconnectSpec | undefined;
    const adapter: Adapter = {
      ...base(),
      reconnect: async (spec) => { got = spec; return { containerId: spec.containerId, ports: { tcp: RECONNECTED_PORT } }; },
    };
    const rt = await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "my-env" }, snapshot);
    expect(got?.envKey).toBe("my-env");
    expect(got?.component).toBe("svc");
    expect(got?.containerId).toBe("c1");
    expect(got?.ports).toEqual(["tcp"]);
    await rt.stop();
  });

  test("a returned containerId replaces the recorded one", async () => {
    // Not used by any adapter today. Pinned because it is the property that
    // lets reconcile — resolving a component to its CURRENT container after a
    // chaos restart replaced it — arrive without another SPI change.
    const adapter: Adapter = {
      ...base(),
      reconnect: async () => ({ containerId: "c2-replacement", ports: { tcp: RECONNECTED_PORT } }),
    };
    const rt = await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" }, snapshot);
    expect(rt.snapshot().components[0]?.containerId).toBe("c2-replacement");
    await rt.stop();
  });

  test("a failing reconnect surfaces as attach_reconnect_failed naming the component", async () => {
    const adapter: Adapter = {
      ...base(),
      reconnect: async () => { throw { kind: "k8s_reconnect_pod_not_running", podName: "c1", phase: "Succeeded" }; },
    };
    let caught: unknown;
    try {
      await attachEnvironment(env, { adapter, sessionId: "s1", envKey: "e1" }, snapshot);
    } catch (e) { caught = e; }

    const err = caught as { kind: string; componentName: string; containerId: string; cause: { kind: string }; hint: string };
    expect(err.kind).toBe("attach_reconnect_failed");
    expect(err.componentName).toBe("svc");
    expect(err.containerId).toBe("c1");
    expect(err.cause.kind).toBe("k8s_reconnect_pod_not_running");
    expect(err.hint).toContain("containerId");
  });

  test("attach still produces a non-owned component when reconnect ran", async () => {
    // D-034. `Reconnected` has no `owned` field, so an adapter cannot claim
    // ownership through this path — this pins the resulting runtime.
    const adapter: Adapter = {
      ...base(),
      reconnect: async (spec) => ({ containerId: spec.containerId, ports: { tcp: RECONNECTED_PORT } }),
    };
    let stopped = 0;
    const counting: Adapter = { ...adapter, stop: async () => { stopped += 1; } };
    const rt = await attachEnvironment(env, { adapter: counting, sessionId: "s1", envKey: "e1" }, snapshot);
    await rt.stop();
    expect(stopped).toBe(0);
  });
});
