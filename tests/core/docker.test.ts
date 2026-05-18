/**
 * Docker adapter smoke tests. Real Docker required.
 * If no daemon is reachable, the entire suite skips silently.
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { createDockerAdapter } from "../../src/adapters/docker";
import type { Adapter, StartSpec } from "../../src/adapter";

const IMAGE = "redis:7-alpine";

const dockerAvailable = async (): Promise<boolean> => {
  try {
    const a = createDockerAdapter({ sessionId: "probe" });
    await a.connect();
    await a.disconnect();
    return true;
  } catch {
    return false;
  }
};

let HAS_DOCKER = false;
beforeAll(async () => { HAS_DOCKER = await dockerAvailable(); });

const mkSpec = (overrides: Partial<StartSpec> = {}): StartSpec => ({
  image: IMAGE,
  env: {},
  ports: { "6379": "auto" },
  mounts: {},
  labels: { speculum: "1", "speculum.session": "test" },
  ...overrides,
});

describe("docker/adapter", () => {
  let adapter: Adapter | null = null;
  const started: string[] = [];

  afterEach(async () => {
    if (!HAS_DOCKER || !adapter) return;
    for (const id of started.splice(0)) {
      try { await adapter.stop(id); } catch { /* ignore */ }
    }
    try { await adapter.disconnect(); } catch { /* ignore */ }
    adapter = null;
  });

  test("connect + disconnect cleanly", async () => {
    if (!HAS_DOCKER) return;
    adapter = createDockerAdapter({ sessionId: "s-connect" });
    await adapter.connect();
    await adapter.disconnect();
    expect(true).toBe(true);
  });

  test("start + exists + stop", async () => {
    if (!HAS_DOCKER) return;
    adapter = createDockerAdapter({ sessionId: "s-lifecycle" });
    await adapter.connect();
    const r = await adapter.start(mkSpec());
    started.push(r.containerId);
    expect(await adapter.exists(r.containerId)).toBe(true);
    await adapter.stop(r.containerId);
    started.pop();
    expect(await adapter.exists(r.containerId)).toBe(false);
  }, 60_000);

  test("port resolution with 'auto'", async () => {
    if (!HAS_DOCKER) return;
    adapter = createDockerAdapter({ sessionId: "s-auto" });
    await adapter.connect();
    const r = await adapter.start(mkSpec({ ports: { "6379": "auto" } }));
    started.push(r.containerId);
    expect(r.ports["6379"]).toBeGreaterThan(0);
  }, 60_000);

  test("port resolution with fixed port", async () => {
    if (!HAS_DOCKER) return;
    adapter = createDockerAdapter({ sessionId: "s-fixed" });
    await adapter.connect();
    const r = await adapter.start(mkSpec({ ports: { "6379": 36379 } }));
    started.push(r.containerId);
    expect(r.ports["6379"]).toBe(36379);
  }, 60_000);

  test("mount-as-content writes tmpfile and binds it", async () => {
    if (!HAS_DOCKER) return;
    const fs = await import("node:fs");
    adapter = createDockerAdapter({ sessionId: "s-mount" });
    await adapter.connect();
    const r = await adapter.start(
      mkSpec({
        mounts: { "/etc/speculum/test.txt": "hello-speculum" },
        ports: { "6379": 36380 },
      })
    );
    started.push(r.containerId);
    const Docker = (await import("node:module")).createRequire(import.meta.url)("dockerode") as new (o?: unknown) => {
      getContainer(id: string): { inspect(): Promise<{ HostConfig: { Binds: string[] | null } }> };
    };
    const client = new Docker({ socketPath: process.env["DOCKER_HOST"]?.replace("unix://", "") ?? "/var/run/docker.sock" });
    const ins = await client.getContainer(r.containerId).inspect();
    const bind = (ins.HostConfig.Binds ?? []).find((b) => b.endsWith(":/etc/speculum/test.txt:ro"));
    expect(bind).toBeDefined();
    const hostPath = bind!.split(":")[0]!;
    expect(fs.readFileSync(hostPath, "utf8")).toBe("hello-speculum");
  }, 60_000);

  test("logs yields lines and aborts cleanly", async () => {
    if (!HAS_DOCKER) return;
    adapter = createDockerAdapter({ sessionId: "s-logs" });
    await adapter.connect();
    const r = await adapter.start(mkSpec());
    started.push(r.containerId);
    const ac = new AbortController();
    const it = adapter.logs(r.containerId, ac.signal);
    let got: string | null = null;
    const timer = setTimeout(() => ac.abort(), 5_000);
    for await (const line of it) {
      got = line;
      break;
    }
    clearTimeout(timer);
    ac.abort();
    expect(got).not.toBeNull();
  }, 30_000);

  test("teardown stops labeled stragglers across adapters", async () => {
    if (!HAS_DOCKER) return;
    const sid = "s-straggler-" + Math.random().toString(36).slice(2, 8);
    const a1 = createDockerAdapter({ sessionId: sid });
    await a1.connect();
    const r = await a1.start(
      mkSpec({ labels: { speculum: "1", "speculum.session": sid } })
    );
    // Intentionally do NOT call a1.stop — orphan it.
    await a1.disconnect();

    const a2 = createDockerAdapter({ sessionId: sid });
    await a2.connect();
    await a2.teardown();
    expect(await a2.exists(r.containerId)).toBe(false);
    await a2.disconnect();
  }, 60_000);
});
