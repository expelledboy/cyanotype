/**
 * Kubernetes adapter attach-mode tests.
 *
 * Denylist tests exercise the kubectl chokepoint directly — no cluster
 * required. Integration tests apply a fixture (Deployment + Service)
 * into a dedicated namespace and verify discovery, port-forwarding,
 * and reconnection across a rolling restart. When no cluster answers, the
 * integration block reports as SKIPPED, not passed; the denylist block above
 * it still runs and carries most of this file's assertions. The probe runs at
 * module scope because `beforeAll` runs after registration, too late for
 * `describe.skipIf`. Set `CYANOTYPE_REQUIRE_K8S=1` — continuous integration
 * does — to fail instead of skip. See `tests/support/require-substrate.ts`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { createK8sAdapter } from "../../src/adapters/kubernetes";
import { createKubectl } from "../../src/adapters/kubectl";
import type { Adapter, StartSpec } from "../../src/adapter";
import { k8sAvailable, requireSubstrate } from "../support/require-substrate";

const CONTEXT = process.env.CYANOTYPE_K8S_CONTEXT ?? "kind-cyanotype";
const NAMESPACE = "cyanotype-attach-tests";
const SERVICE = "attach-nginx";
const FIXTURE = path.join(import.meta.dir, "..", "support", "k8s", "attach-fixture.yaml");
const OVERRIDE_FIXTURE = path.join(import.meta.dir, "..", "support", "k8s", "attach-override-fixture.yaml");

const kubectl = (args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["kubectl", "--context", CONTEXT, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exit, stdout, stderr };
  })();
};

const httpGet = (port: number, path = "/"): Promise<number | null> =>
  new Promise((resolve) => {
    const ac = new AbortController();
    const t = setTimeout(() => { ac.abort(); resolve(null); }, 3000);
    fetch(`http://127.0.0.1:${port}${path}`, { signal: ac.signal })
      .then((r) => { clearTimeout(t); resolve(r.status); })
      .catch(() => { clearTimeout(t); resolve(null); });
  });

const waitUntil = async (p: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await p()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const mkSpec = (sid: string): StartSpec => ({
  image: "ignored-in-attach-mode",
  env: {},
  ports: { "80": "auto" },
  mounts: {},
  labels: { cyanotype: "1", "cyanotype.session": sid, "cyanotype.component": SERVICE },
});

describe("kubernetes/adapter/attach denylist", () => {
  const k = createKubectl({ mode: "attach", namespace: "any", context: "no-such-context" });
  const verbs = ["apply", "create", "delete", "patch", "replace", "edit", "scale", "rollout"];
  for (const verb of verbs) {
    test(`run([${verb}, ...]) throws attach_mode_violation`, async () => {
      let caught: unknown = null;
      try { await k.run([verb, "pod", "anything"]); }
      catch (e) { caught = e; }
      expect(caught).not.toBeNull();
      const tagged = caught as { kind?: string; op?: string };
      expect(tagged.kind).toBe("attach_mode_violation");
      expect(tagged.op).toBe(verb);
    });
  }
  test("stream(['delete', ...]) throws attach_mode_violation", () => {
    let caught: unknown = null;
    try { k.stream(["delete", "pod", "x"]); }
    catch (e) { caught = e; }
    expect((caught as { kind?: string }).kind).toBe("attach_mode_violation");
  });
});

const HAS_K8S = requireSubstrate(
  await k8sAvailable(CONTEXT), "k8s", `kubectl --context ${CONTEXT} get nodes`);

describe.skipIf(!HAS_K8S)("kubernetes/adapter/attach integration", () => {
  /**
   * Setup THROWS rather than recording readiness. It used to set a
   * `FIXTURE_READY` flag that every test checked and returned on, so a fixture
   * that never came up produced four passing tests that asserted nothing.
   *
   * It lives inside this block, not at file scope, because a file-level
   * `beforeAll` runs whenever any block in the file runs — and the denylist
   * block above needs no cluster, so it always does.
   */
  beforeAll(async () => {
    // Tolerate a still-terminating namespace from a prior afterAll's --wait=false delete.
    const nsClear = await waitUntil(async () => {
      const r = await kubectl(["get", "ns", NAMESPACE, "-o", "jsonpath={.status.phase}"]);
      if (r.exit !== 0) return true;
      return r.stdout !== "Terminating";
    }, 60_000);
    if (!nsClear) {
      throw { kind: "attach_fixture_namespace_terminating", namespace: NAMESPACE };
    }
    for (const f of [FIXTURE, OVERRIDE_FIXTURE]) {
      const apply = await kubectl(["apply", "-f", f]);
      if (apply.exit !== 0) {
        throw { kind: "attach_fixture_apply_failed", fixture: f, stderr: apply.stderr };
      }
    }
    for (const d of ["attach-nginx", "override-nginx"]) {
      const ready = await kubectl([
        "-n", NAMESPACE, "wait", `deployment/${d}`,
        "--for=condition=Available", "--timeout=120s",
      ]);
      if (ready.exit !== 0) {
        throw { kind: "attach_fixture_not_available", deployment: d, stderr: ready.stderr };
      }
    }
  }, 240_000);

  afterAll(async () => {
    await kubectl(["delete", "-f", FIXTURE, "--wait=false", "--ignore-not-found=true"]);
    await kubectl(["delete", "-f", OVERRIDE_FIXTURE, "--wait=false", "--ignore-not-found=true"]);
  }, 60_000);

  test("discovers Service + port-forwards + HTTP 200", async () => {
    const sid = `att-${Math.random().toString(36).slice(2, 8)}`;
    const adapter: Adapter = createK8sAdapter({
      mode: "attach", sessionId: sid, context: CONTEXT, namespace: NAMESPACE,
    });
    await adapter.connect();
    try {
      const r = await adapter.start(mkSpec(sid));
      expect(r.containerId.startsWith("attach:")).toBe(true);
      expect(r.ports["80"]).toBeGreaterThan(0);
      const ok = await waitUntil(async () => (await httpGet(r.ports["80"]!)) === 200, 15_000);
      expect(ok).toBe(true);
      expect(await adapter.exists(r.containerId)).toBe(true);
    } finally {
      await adapter.teardown();
      await adapter.disconnect();
    }
  }, 180_000);

  test("survives rolling restart via reconnection layer", async () => {
    const sid = `rec-${Math.random().toString(36).slice(2, 8)}`;
    const adapter: Adapter = createK8sAdapter({
      mode: "attach", sessionId: sid, context: CONTEXT, namespace: NAMESPACE,
    });
    await adapter.connect();
    try {
      const r = await adapter.start(mkSpec(sid));
      const port = r.ports["80"]!;
      const before = await waitUntil(async () => (await httpGet(port)) === 200, 15_000);
      expect(before).toBe(true);
      const restart = await kubectl(["-n", NAMESPACE, "rollout", "restart", "deployment/attach-nginx"]);
      expect(restart.exit).toBe(0);
      await kubectl(["-n", NAMESPACE, "rollout", "status", "deployment/attach-nginx", "--timeout=120s"]);
      const after = await waitUntil(async () => (await httpGet(port)) === 200, 30_000);
      expect(after).toBe(true);
    } finally {
      await adapter.teardown();
      await adapter.disconnect();
    }
  }, 240_000);

  test("honours adapter.k8s.attach.service override when convention does not match", async () => {
    const sid = `ovr-${Math.random().toString(36).slice(2, 8)}`;
    const adapter: Adapter = createK8sAdapter({
      mode: "attach", sessionId: sid, context: CONTEXT, namespace: NAMESPACE,
    });
    await adapter.connect();
    try {
      const spec: StartSpec = {
        image: "ignored-in-attach-mode",
        env: {},
        ports: { "80": "auto" },
        mounts: {},
        labels: {
          cyanotype: "1",
          "cyanotype.session": sid,
          "cyanotype.component": "does-not-match-any-service",
        },
        adapterConfig: { k8s: { attach: { service: "my-real-prod-nginx" } } },
      };
      const r = await adapter.start(spec);
      expect(r.containerId.startsWith("attach:")).toBe(true);
      expect(r.ports["80"]).toBeGreaterThan(0);
      const ok = await waitUntil(async () => (await httpGet(r.ports["80"]!)) === 200, 15_000);
      expect(ok).toBe(true);
    } finally {
      await adapter.teardown();
      await adapter.disconnect();
    }
  }, 180_000);

  test("teardown does NOT delete cluster resources", async () => {
    const sid = `safe-${Math.random().toString(36).slice(2, 8)}`;
    const adapter: Adapter = createK8sAdapter({
      mode: "attach", sessionId: sid, context: CONTEXT, namespace: NAMESPACE,
    });
    await adapter.connect();
    // teardown (not chaos.stop) is the safe path; verify cluster resources
    // survive even when adapter.teardown rips down forwards directly.
    await adapter.start(mkSpec(sid));
    await adapter.teardown();
    await adapter.disconnect();
    const dep = await kubectl(["-n", NAMESPACE, "get", "deployment", "attach-nginx", "-o", "name"]);
    expect(dep.exit).toBe(0);
    const svc = await kubectl(["-n", NAMESPACE, "get", "svc", SERVICE, "-o", "name"]);
    expect(svc.exit).toBe(0);
  }, 120_000);
});
