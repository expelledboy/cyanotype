/**
 * Kubernetes adapter smoke tests against OrbStack.
 *
 * If `kubectl --context orbstack get nodes` fails, the entire suite skips —
 * we don't fail when the cluster isn't available.
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import net from "node:net";
import { createK8sAdapter } from "../../src/adapters/kubernetes";
import type { Adapter, StartSpec } from "../../src/adapter";

const CONTEXT = process.env.CYANOTYPE_K8S_CONTEXT ?? "orbstack";
const NAMESPACE = "cyanotype-tests";
const IMAGE = "cyanotype/petstore-sla:latest";
const CONTAINER_PORT = "8080";

const k8sAvailable = async (): Promise<boolean> => {
  try {
    const proc = Bun.spawn(["kubectl", "--context", CONTEXT, "get", "nodes"], {
      stdout: "ignore", stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
};

let HAS_K8S = false;
beforeAll(async () => { HAS_K8S = await k8sAvailable(); });

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

describe("kubernetes/adapter", () => {
  let adapter: Adapter | null = null;
  const started: string[] = [];

  afterEach(async () => {
    if (!HAS_K8S || !adapter) return;
    for (const id of started.splice(0)) {
      try { await adapter.stop(id); } catch { /* ignore */ }
    }
    try { await adapter.teardown(); } catch { /* ignore */ }
    try { await adapter.disconnect(); } catch { /* ignore */ }
    adapter = null;
  });

  test("connect creates namespace if missing", async () => {
    if (!HAS_K8S) return;
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
    if (!HAS_K8S) return;
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
    if (!HAS_K8S) return;
    const sid = `exists-${Math.random().toString(36).slice(2, 8)}`;
    adapter = createK8sAdapter({ mode: "deploy", sessionId: sid, context: CONTEXT, namespace: NAMESPACE });
    await adapter.connect();
    const r = await adapter.start(mkSpec(sid));
    started.push(r.containerId);
    expect(await adapter.exists(r.containerId)).toBe(true);
    expect(await adapter.exists("cyanotype-does-not-exist-xyz")).toBe(false);
  }, 120_000);

  test("logs yields at least one line", async () => {
    if (!HAS_K8S) return;
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
    if (!HAS_K8S) return;
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
    if (!HAS_K8S) return;
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
