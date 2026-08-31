/**
 * Feature 2 — attach-mode image-drift check.
 *
 * In attach mode the Docker adapter discovers a container someone else
 * started. These tests verify it compares the discovered container's image
 * against the `Binding`'s expectation (`spec.image`) and applies the
 * configured `onImageDrift` policy: `"warn"` (default, logs + continues),
 * `"fail"` (throws `attach_image_drift`), `"ignore"` (skips the check).
 *
 * Driven against a fake dockerode client via the `dockerClient` test seam,
 * mirroring `docker-attach.test.ts` — no real Docker daemon required. The
 * fake satisfies the consumed surface, so the suite self-skips nothing; if
 * a real-Docker variant were added it would self-skip on connect failure.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createDockerAdapter } from "../../src/adapters/docker";
import type { Adapter, StartSpec } from "../../src/adapter";

type FakeContainerState = {
  Id: string;
  labels: Record<string, string>;
  status: string;
  ports: Record<string, Array<{ HostPort: string }> | null>;
  image: string;
  imageDigest?: string;
};

let fakeContainers: FakeContainerState[] = [];

const makeContainerHandle = (st: FakeContainerState) => ({
  id: st.Id,
  start: async () => { st.status = "running"; },
  stop: async () => { st.status = "exited"; },
  restart: async () => { st.status = "running"; },
  kill: async () => { st.status = "exited"; },
  remove: async () => { fakeContainers = fakeContainers.filter((c) => c.Id !== st.Id); },
  inspect: async () => ({
    Image: st.imageDigest,
    NetworkSettings: { Ports: st.ports },
    HostConfig: { Binds: null },
    Config: { Labels: st.labels, Image: st.image },
    State: { Status: st.status },
  }),
  logs: async () => { throw new Error("logs not used in these tests"); },
});

const makeFakeClient = () => ({
  ping: async () => "OK",
  pull: async () => { throw new Error("pull not used"); },
  getImage: (_ref: string) => ({ inspect: async () => ({}) }),
  getContainer: (id: string) => {
    const st = fakeContainers.find((c) => c.Id === id);
    if (!st) throw Object.assign(new Error("no such container"), { statusCode: 404 });
    return makeContainerHandle(st);
  },
  createContainer: async () => { throw new Error("createContainer not used"); },
  listContainers: async (o: { all?: boolean; filters?: { label?: string[] } }) => {
    const labels = o.filters?.label ?? [];
    return fakeContainers
      .filter((c) => labels.every((l) => {
        const [k, v] = l.split("=");
        return c.labels[k!] === v;
      }))
      .map((c) => ({ Id: c.Id }));
  },
  modem: { followProgress: () => {}, demuxStream: () => {} },
});

const seedContainer = (image: string, digest?: string): FakeContainerState => ({
  Id: "api1",
  labels: {
    "com.docker.compose.project": "myproj",
    "com.docker.compose.service": "api",
    "com.docker.compose.container-number": "1",
  },
  status: "running",
  ports: { "8080/tcp": [{ HostPort: "49153" }] },
  image,
  ...(digest !== undefined ? { imageDigest: digest } : {}),
});

const mkSpec = (overrides: Partial<StartSpec> = {}): StartSpec => ({
  image: "myapp:expected",
  version: "expected",
  env: {},
  ports: { "8080": "auto" },
  mounts: {},
  labels: { cyanotype: "1", "cyanotype.session": "s1", "cyanotype.component": "api" },
  ...overrides,
});

const mkAdapter = (extra: Partial<Parameters<typeof createDockerAdapter>[0]> = {}): Adapter =>
  createDockerAdapter({
    sessionId: "s1",
    mode: "attach",
    project: "myproj",
    // biome-ignore lint/suspicious/noExplicitAny: fake satisfies the consumed DockerClient surface.
    dockerClient: makeFakeClient() as any,
    ...extra,
  });

const catchKind = async (fn: () => unknown | Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; }
  catch (e) { return e; }
};

beforeEach(() => { fakeContainers = []; });

describe("docker/adapter/attach image-drift (Feature 2)", () => {
  test("matching image is silent (no throw) under default policy", async () => {
    fakeContainers = [seedContainer("myapp:expected")];
    const a = mkAdapter();
    await a.connect();
    const r = await a.start(mkSpec());
    expect(r.containerId).toBe("attach:myproj/api1");
    await a.disconnect();
  });

  test('default policy "warn" continues attaching on drift', async () => {
    fakeContainers = [seedContainer("myapp:WRONG")];
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => { warnings.push(String(msg)); };
    try {
      const a = mkAdapter(); // no onImageDrift → default "warn"
      await a.connect();
      const r = await a.start(mkSpec());
      expect(r.containerId).toBe("attach:myproj/api1"); // attached anyway
      await a.disconnect();
    } finally {
      console.warn = orig;
    }
    expect(warnings.some((w) => w.includes("attach_image_drift"))).toBe(true);
  });

  test('"fail" policy throws attach_image_drift on drift', async () => {
    fakeContainers = [seedContainer("myapp:WRONG")];
    const a = mkAdapter({ onImageDrift: "fail" });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec()));
    expect((e as { kind?: string }).kind).toBe("attach_image_drift");
    expect((e as { expected?: string }).expected).toBe("myapp:expected");
    expect((e as { actual?: string }).actual).toBe("myapp:WRONG");
    expect((e as { component?: string }).component).toBe("api");
    await a.disconnect();
  });

  test('"fail" policy does NOT throw when the image matches', async () => {
    fakeContainers = [seedContainer("myapp:expected")];
    const a = mkAdapter({ onImageDrift: "fail" });
    await a.connect();
    const r = await a.start(mkSpec());
    expect(r.containerId).toBe("attach:myproj/api1");
    await a.disconnect();
  });

  test('"ignore" policy skips the check entirely (no throw on drift)', async () => {
    fakeContainers = [seedContainer("myapp:WRONG")];
    const a = mkAdapter({ onImageDrift: "ignore" });
    await a.connect();
    const r = await a.start(mkSpec());
    expect(r.containerId).toBe("attach:myproj/api1");
    await a.disconnect();
  });

  test("per-binding onImageDrift overrides the adapter-level default", async () => {
    fakeContainers = [seedContainer("myapp:WRONG")];
    // Adapter default is "ignore"; the binding bumps it to "fail".
    const a = mkAdapter({ onImageDrift: "ignore" });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec({
      adapterConfig: { compose: { attach: { onImageDrift: "fail" } } },
    })));
    expect((e as { kind?: string }).kind).toBe("attach_image_drift");
    await a.disconnect();
  });

  test("prefix-aligned refs (tag vs tag@digest) do not count as drift", async () => {
    fakeContainers = [seedContainer("myapp:expected@sha256:abc123")];
    const a = mkAdapter({ onImageDrift: "fail" });
    await a.connect();
    const r = await a.start(mkSpec({ image: "myapp:expected" }));
    expect(r.containerId).toBe("attach:myproj/api1");
    await a.disconnect();
  });

  test("loose prefix shape (repo vs repo-other:tag) is drift", async () => {
    fakeContainers = [seedContainer("redis-evil:latest")];
    const a = mkAdapter({ onImageDrift: "fail" });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec({ image: "redis" })));
    expect((e as { kind?: string }).kind).toBe("attach_image_drift");
    await a.disconnect();
  });

  test("digest-suffix tolerance: repo:tag vs repo:tag@sha256:... is not drift", async () => {
    fakeContainers = [seedContainer("redis:7@sha256:abc123def456")];
    const a = mkAdapter({ onImageDrift: "fail" });
    await a.connect();
    const r = await a.start(mkSpec({ image: "redis:7" }));
    expect(r.containerId).toBe("attach:myproj/api1");
    await a.disconnect();
  });

  test("single-character prefix shape is drift", async () => {
    fakeContainers = [seedContainer("alpine")];
    const a = mkAdapter({ onImageDrift: "fail" });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec({ image: "a" })));
    expect((e as { kind?: string }).kind).toBe("attach_image_drift");
    await a.disconnect();
  });
});
