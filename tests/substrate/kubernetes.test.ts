/**
 * Kubernetes adapter smoke tests against OrbStack.
 *
 * When no cluster answers, both blocks below report as SKIPPED, not passed.
 * The probe therefore runs at module scope rather than in `beforeAll`, which
 * Bun runs after registration and so too late for `describe.skipIf` to see.
 * Set `CYANOTYPE_REQUIRE_K8S=1` — continuous integration does — to make an
 * unreachable cluster fail instead of skip. See
 * `tests/support/require-substrate.ts`.
 */

import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { createK8sAdapter } from "../../src/adapters/kubernetes";
import type { Adapter, StartSpec } from "../../src/adapter";
import { k8sAvailable, requireSubstrate } from "../support/require-substrate";

const CONTEXT = process.env.CYANOTYPE_K8S_CONTEXT ?? "orbstack";
const NAMESPACE = "cyanotype-tests";
const IMAGE = "cyanotype/petstore-sla:latest";
const CONTAINER_PORT = "8080";

const HAS_K8S = requireSubstrate(
  await k8sAvailable(CONTEXT), "k8s", `kubectl --context ${CONTEXT} get nodes`);

const tcpConnect = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    const t = setTimeout(() => { c.destroy(); resolve(false); }, 2000);
    c.on("connect", () => { clearTimeout(t); c.end(); resolve(true); });
    c.on("error", () => { clearTimeout(t); resolve(false); });
  });

const waitUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const mkSpec = (sessionId: string, overrides: Partial<StartSpec> = {}): StartSpec => ({
  image: IMAGE,
  env: {},
  ports: { [CONTAINER_PORT]: "auto" },
  mounts: {},
  labels: { cyanotype: "1", "cyanotype.session": sessionId, "cyanotype.component": "petstore" },
  ...overrides,
});

describe.skipIf(!HAS_K8S)("kubernetes/adapter", () => {
  let adapter: Adapter | null = null;
  const started: string[] = [];

  afterEach(async () => {
    if (!adapter) return;
    for (const id of started.splice(0)) {
      try { await adapter.stop(id); } catch { /* ignore */ }
    }
    try { await adapter.teardown(); } catch { /* ignore */ }
    try { await adapter.disconnect(); } catch { /* ignore */ }
    adapter = null;
  });

  test("connect creates namespace if missing", async () => {
    const sid = `ns-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const proc = Bun.spawn(
      ["kubectl", "--context", CONTEXT, "get", "namespace", NAMESPACE, "-o", "name"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain(NAMESPACE);
  }, 30_000);

  test("start returns Started with reachable port", async () => {
    const sid = `start-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(mkSpec(sid));
    started.push(r.containerId);
    expect(r.containerId.length).toBeGreaterThan(0);
    expect(r.ports[CONTAINER_PORT]).toBeGreaterThan(0);
    const ok = await waitUntil(() => tcpConnect(r.ports[CONTAINER_PORT]!), 10_000);
    expect(ok).toBe(true);
  }, 120_000);

  test("exists returns true for started, false for never-existed", async () => {
    const sid = `exists-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(mkSpec(sid));
    started.push(r.containerId);
    expect(await adapter.exists(r.containerId)).toBe(true);
    expect(await adapter.exists("cyanotype-does-not-exist-xyz")).toBe(false);
  }, 120_000);

  test("logs yields at least one line", async () => {
    const sid = `logs-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(mkSpec(sid));
    started.push(r.containerId);
    // Hit /health to ensure the petstore service logs at least one request line.
    const ac = new AbortController();
    const it = adapter.logs(r.containerId, ac.signal);
    const reader = (async () => {
      for await (const line of it) {
        if (line.length > 0) return line;
      }
      return null;
    })();
    // Generate traffic so the petstore writes a log line.
    await new Promise((res) => setTimeout(res, 500));
    for (let i = 0; i < 5; i++) {
      try { await fetch(`http://127.0.0.1:${r.ports[CONTAINER_PORT]}/health`); } catch { /* ignore */ }
      await new Promise((res) => setTimeout(res, 200));
    }
    const timer = setTimeout(() => ac.abort(), 8_000);
    const line = await reader;
    clearTimeout(timer);
    ac.abort();
    expect(line).not.toBeNull();
  }, 120_000);

  test("stop removes the pod and exists returns false", async () => {
    const sid = `stop-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(mkSpec(sid));
    started.push(r.containerId);
    await adapter.stop(r.containerId);
    started.pop();
    const gone = await waitUntil(async () => !(await adapter!.exists(r.containerId)), 30_000);
    expect(gone).toBe(true);
  }, 120_000);

  test("teardown removes all session-labelled pods/configmaps", async () => {
    const sid = `td-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(mkSpec(sid, {
      mounts: { "/etc/cyanotype/marker.txt": "hello" },
    }));
    // Intentionally do not stop — let teardown sweep it.
    started.length = 0;
    await adapter.teardown();
    const gone = await waitUntil(async () => {
      const proc = Bun.spawn(
        ["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "get", "pods,configmaps",
          "-l", `cyanotype=1,cyanotype.session=${sid}`, "-o", "name"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim() === "";
    }, 60_000);
    expect(gone).toBe(true);
    expect(r.containerId.length).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * D-047 — reconnect resolves the component's CURRENT Pod.
 *
 * The gap this closes: a chaos restart in the process that owns the
 * environment replaces the Pod and never updates the shared metadata (D-007),
 * so an attaching worker holds a name that no longer exists while the
 * component itself is healthy. Resolving by `cyanotype.env` + component +
 * instance finds the replacement; trusting the recorded id cannot.
 *
 * The load-bearing case is the third one. The first two would pass against an
 * implementation that simply re-forwarded the id it was handed.
 */
describe.skipIf(!HAS_K8S)("k8s/reconnect resolves by label (D-047)", () => {
  const SESSION = "s-reconcile";
  const ENVKEY = "recon-env";
  const started: Array<{ adapter: Adapter; id: string }> = [];

  afterEach(async () => {
    for (const { adapter, id } of started.splice(0)) {
      try { await adapter.stop(id); } catch { /* best effort */ }
    }
  });

  const specFor = (component: string, instance?: string): StartSpec => ({
    image: IMAGE,
    env: {},
    ports: { [CONTAINER_PORT]: "auto" },
    mounts: {},
    labels: {
      cyanotype: "1",
      "cyanotype.session": SESSION,
      "cyanotype.env": ENVKEY,
      "cyanotype.component": component,
      ...(instance !== undefined ? { "cyanotype.instance": instance } : {}),
    },
    ...(instance !== undefined ? { instance } : {}),
  });

  test("re-establishes ports for a Pod this process did not start", async () => {
    const adapter = createK8sAdapter({ mode: "deploy", sessionId: SESSION, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(specFor("solo"));
    started.push({ adapter, id: r.containerId });

    const again = await adapter.reconnect?.({
      containerId: r.containerId, envKey: ENVKEY, component: "solo", ports: [CONTAINER_PORT],
    });
    expect(again?.containerId).toBe(r.containerId);
    // A second, independent forward — a different local port to the same Pod.
    expect(again?.ports[CONTAINER_PORT]).not.toBe(r.ports[CONTAINER_PORT]);
    expect(await tcpConnect(again?.ports[CONTAINER_PORT] as number)).toBe(true);
    await adapter.disconnect();
  }, 90_000);

  test("a single-instance lookup does not match an instance-labelled Pod", async () => {
    const adapter = createK8sAdapter({ mode: "deploy", sessionId: SESSION, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(specFor("dual", "one"));
    started.push({ adapter, id: r.containerId });

    // Same component name, no instance: must NOT resolve to the instance Pod,
    // which is why the selector requires the label's ABSENCE rather than
    // simply omitting it.
    let caught: unknown;
    try {
      await adapter.reconnect?.({ containerId: r.containerId, envKey: ENVKEY, component: "dual", ports: [CONTAINER_PORT] });
    } catch (e) { caught = e; }
    expect((caught as { kind: string }).kind).toBe("k8s_reconcile_no_match");
    await adapter.disconnect();
  }, 90_000);

  test("finds the REPLACEMENT after the recorded Pod is gone", async () => {
    const adapter = createK8sAdapter({ mode: "deploy", sessionId: SESSION, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();

    const first = await adapter.start(specFor("churn"));
    const staleId = first.containerId;
    await adapter.stop(staleId);                      // what a chaos restart does

    const second = await adapter.start(specFor("churn"));   // same labels, new Pod
    started.push({ adapter, id: second.containerId });
    expect(second.containerId).not.toBe(staleId);

    // Hand reconnect the STALE id, as a worker reading old metadata would.
    const resolved = await adapter.reconnect?.({
      containerId: staleId, envKey: ENVKEY, component: "churn", ports: [CONTAINER_PORT],
    });
    expect(resolved?.containerId).toBe(second.containerId);
    expect(await tcpConnect(resolved?.ports[CONTAINER_PORT] as number)).toBe(true);
    await adapter.disconnect();
  }, 120_000);
});
