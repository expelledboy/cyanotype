/**
 * Docker adapter smoke tests. Real Docker required.
 * If no daemon is reachable, the entire suite skips silently.
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { createRequire } from "node:module";
import { createDockerAdapter } from "../../src/adapters/docker";
import type { Adapter, StartSpec } from "../../src/adapter";

const IMAGE = "redis:7-alpine";
const ALPINE = "alpine:3.20";

type Dockerode = new (o?: unknown) => {
  getContainer(id: string): {
    inspect(): Promise<{ HostConfig: { Binds: string[] | null } }>;
    logs(opts: Record<string, unknown>): Promise<NodeJS.ReadableStream | Buffer>;
    stop(opts?: { t?: number }): Promise<void>;
    remove(opts?: { force?: boolean }): Promise<void>;
  };
  createContainer(opts: Record<string, unknown>): Promise<{
    id: string;
    start(): Promise<void>;
    stop(opts?: { t?: number }): Promise<void>;
    remove(opts?: { force?: boolean }): Promise<void>;
  }>;
  pull(image: string): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      cb: (err: unknown) => void,
    ): void;
  };
};

const dockerCtor = (): Dockerode =>
  createRequire(import.meta.url)("dockerode") as Dockerode;

const dockerOpts = (): { socketPath: string } => ({
  socketPath: process.env["DOCKER_HOST"]?.replace("unix://", "") ?? "/var/run/docker.sock",
});

const streamToString = async (raw: NodeJS.ReadableStream | Buffer): Promise<string> => {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of raw) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Containers created outside adapter.start — cleaned in afterEach. */
const rawContainers: string[] = [];

const ensureImage = async (image: string): Promise<void> => {
  const Docker = dockerCtor();
  const client = new Docker(dockerOpts());
  try {
    await new Promise<void>((resolve, reject) => {
      client.pull(image).then(
        (stream) => client.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
        reject,
      );
    });
  } catch {
    /* image may already exist; createContainer will fail loudly if not */
  }
};

const startAlpineLogger = async (session: string, cmd: string[]): Promise<string> => {
  await ensureImage(ALPINE);
  const Docker = dockerCtor();
  const client = new Docker(dockerOpts());
  const cont = await client.createContainer({
    Image: ALPINE,
    Cmd: cmd,
    Labels: { cyanotype: "1", "cyanotype.session": session },
  });
  await cont.start();
  rawContainers.push(cont.id);
  return cont.id;
};

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
  labels: { cyanotype: "1", "cyanotype.session": "test" },
  ...overrides,
});

describe("docker/adapter", () => {
  let adapter: Adapter | null = null;
  const started: string[] = [];

  afterEach(async () => {
    if (HAS_DOCKER && adapter) {
      for (const id of started.splice(0)) {
        try { await adapter.stop(id); } catch { /* ignore */ }
      }
      try { await adapter.disconnect(); } catch { /* ignore */ }
      adapter = null;
    }
    if (!HAS_DOCKER) return;
    const Docker = dockerCtor();
    const client = new Docker(dockerOpts());
    for (const id of rawContainers.splice(0)) {
      try {
        const c = client.getContainer(id);
        try { await c.stop({ t: 2 }); } catch { /* ignore */ }
        try { await c.remove({ force: true }); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
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
        mounts: { "/etc/cyanotype/test.txt": "hello-cyanotype" },
        ports: { "6379": 36380 },
      })
    );
    started.push(r.containerId);
    const Docker = dockerCtor();
    const client = new Docker(dockerOpts());
    const ins = await client.getContainer(r.containerId).inspect();
    const bind = (ins.HostConfig.Binds ?? []).find((b) => b.endsWith(":/etc/cyanotype/test.txt:ro"));
    expect(bind).toBeDefined();
    const hostPath = bind!.split(":")[0]!;
    expect(fs.readFileSync(hostPath, "utf8")).toBe("hello-cyanotype");
  }, 60_000);

  test("logs yields live lines and aborts cleanly", async () => {
    if (!HAS_DOCKER) return;
    // Continuous logger: redis is quiet after Ready, so tail:0 would hang.
    const id = await startAlpineLogger("s-logs", ["sh", "-c", "while true; do echo tick; sleep 0.15; done"]);
    adapter = createDockerAdapter({ sessionId: "s-logs" });
    await adapter.connect();
    const ac = new AbortController();
    const it = adapter.logs(id, ac.signal);
    let got: string | null = null;
    const timer = setTimeout(() => ac.abort(), 5_000);
    for await (const line of it) {
      got = line;
      break;
    }
    clearTimeout(timer);
    ac.abort();
    expect(got).not.toBeNull();
  }, 60_000);

  test("logs does not replay container history", async () => {
    if (!HAS_DOCKER) return;
    const HIST = "CYANOTYPE_HISTORIC_MARKER";
    // Historic line first; then a quiet sleep so non-follow dump settles with HIST only.
    // After follow opens, emit LIVE lines so we prove the stream is still open.
    const id = await startAlpineLogger("s-logs-hist", [
      "sh",
      "-c",
      `echo ${HIST}; sleep 0.4; i=0; while true; do i=$((i+1)); echo LIVE_$i; sleep 0.15; done`,
    ]);
    const Docker = dockerCtor();
    const client = new Docker(dockerOpts());
    const cont = client.getContainer(id);
    // Wait until HIST is definitely in the stored buffer (would be replayed without tail:0).
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("historic marker never appeared in docker logs");
      const raw = await cont.logs({ stdout: true, stderr: true, follow: false });
      const text = await streamToString(raw as NodeJS.ReadableStream | Buffer);
      if (text.includes(HIST)) break;
      await Bun.sleep(50);
    }
    adapter = createDockerAdapter({ sessionId: "s-logs-hist" });
    await adapter.connect();
    const seen: string[] = [];
    const ac = new AbortController();
    const drain = (async () => {
      for await (const line of adapter!.logs(id, ac.signal)) {
        seen.push(line);
      }
    })();
    const liveDeadline = Date.now() + 8_000;
    for (;;) {
      if (seen.some((l) => l.includes("LIVE_"))) break;
      if (Date.now() > liveDeadline) break;
      await Bun.sleep(50);
    }
    ac.abort();
    await drain.catch(() => {});
    expect(seen.some((l) => l.includes(HIST))).toBe(false);
    expect(seen.some((l) => l.includes("LIVE_"))).toBe(true);
  }, 60_000);

  test("teardown stops labeled stragglers across adapters", async () => {
    if (!HAS_DOCKER) return;
    const sid = "s-straggler-" + Math.random().toString(36).slice(2, 8);
    const a1 = createDockerAdapter({ sessionId: sid });
    await a1.connect();
    const r = await a1.start(
      mkSpec({ labels: { cyanotype: "1", "cyanotype.session": sid } })
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
