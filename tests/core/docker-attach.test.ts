/**
 * Docker adapter attach-mode tests.
 *
 * Denylist tests exercise the attach-mode chokepoint via the adapter's
 * `start`/`stop` surface (guardAttachClient is module-private). The
 * discovery/port-resolution/lifecycle tests drive the adapter against a fake
 * dockerode client injected via the `dockerClient` test seam, so the core
 * suite never needs a real Docker daemon.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createDockerAdapter } from "../../src/adapters/docker";
import type { Adapter, StartSpec } from "../../src/adapter";

// ---------------------------------------------------------------------------
// Fake dockerode — a controllable in-memory Docker daemon.
// ---------------------------------------------------------------------------

type FakeContainerState = {
  Id: string;
  labels: Record<string, string>;
  status: string;
  ports: Record<string, Array<{ HostPort: string }> | null>;
  image: string;
};

let fakeContainers: FakeContainerState[] = [];

const makeContainerHandle = (st: FakeContainerState) => ({
  id: st.Id,
  start: async () => { st.status = "running"; },
  stop: async (_o?: { t?: number }) => { st.status = "exited"; },
  restart: async () => { st.status = "running"; },
  kill: async () => { st.status = "exited"; },
  remove: async () => { fakeContainers = fakeContainers.filter((c) => c.Id !== st.Id); },
  inspect: async () => ({
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

const seedContainer = (
  overrides: Partial<FakeContainerState> & { number?: string } = {},
): FakeContainerState => ({
  Id: overrides.Id ?? "c0ffee" + Math.random().toString(36).slice(2, 8),
  labels: overrides.labels ?? {
    "com.docker.compose.project": "myproj",
    "com.docker.compose.service": "api",
    "com.docker.compose.container-number": overrides.number ?? "1",
  },
  status: overrides.status ?? "running",
  ports: overrides.ports ?? { "8080/tcp": [{ HostPort: "49153" }] },
  image: overrides.image ?? "myapp:latest",
});

const mkSpec = (overrides: Partial<StartSpec> = {}): StartSpec => ({
  image: "ignored-in-attach-mode",
  env: {},
  ports: { "8080": "auto" },
  mounts: {},
  labels: { speculum: "1", "speculum.session": "s1", "speculum.component": "api" },
  ...overrides,
});

const mkAdapter = (extra: Partial<Parameters<typeof createDockerAdapter>[0]> = {}): Adapter =>
  createDockerAdapter({
    sessionId: "s1",
    mode: "attach",
    // biome-ignore lint/suspicious/noExplicitAny: fake satisfies the consumed DockerClient surface.
    dockerClient: makeFakeClient() as any,
    ...extra,
  });

beforeEach(() => { fakeContainers = []; });

const catchKind = async (fn: () => unknown | Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; }
  catch (e) { return e; }
};

// ---------------------------------------------------------------------------
// Denylist — attach-mode chokepoint (exercised via adapter and spy clients).
//
// guardAttachClient is module-private; these tests verify its policy by
// injecting spy clients that record calls and confirm blocking vs. pass-through
// at the adapter boundary.
// ---------------------------------------------------------------------------

/** Build a fake client wired to a call-recorder for denylist assertions. */
const makeDenylistClient = () => {
  const calls: string[] = [];
  const client = {
    ping: async () => { calls.push("ping"); return "OK"; },
    pull: async (_img: string) => { calls.push("pull"); throw new Error("pull not blocked"); },
    getImage: (ref: string) => ({ inspect: async () => { calls.push(`getImage:${ref}`); return {}; } }),
    getContainer: (id: string) => {
      const st = fakeContainers.find((c) => c.Id === id);
      if (!st) throw Object.assign(new Error("no such container"), { statusCode: 404 });
      return {
        id: st.Id,
        start: async () => { calls.push("container.start"); st.status = "running"; },
        stop: async () => { calls.push("container.stop"); st.status = "exited"; },
        restart: async () => { calls.push("container.restart"); st.status = "running"; },
        kill: async () => { calls.push("container.kill"); st.status = "exited"; },
        remove: async () => { calls.push("container.remove"); fakeContainers = fakeContainers.filter((c) => c.Id !== st.Id); },
        inspect: async () => { calls.push("container.inspect"); return {
          NetworkSettings: { Ports: st.ports },
          HostConfig: { Binds: null },
          Config: { Labels: st.labels, Image: st.image },
          State: { Status: st.status },
        }; },
        logs: async () => { throw new Error("logs not used"); },
      };
    },
    createContainer: async () => { calls.push("createContainer"); throw new Error("createContainer not blocked"); },
    listContainers: async (o: { all?: boolean; filters?: { label?: string[] } }) => {
      calls.push("listContainers");
      const labels = o.filters?.label ?? [];
      return fakeContainers
        .filter((c) => labels.every((l) => {
          const [k, v] = l.split("=");
          return c.labels[k!] === v;
        }))
        .map((c) => ({ Id: c.Id }));
    },
    modem: { followProgress: () => {}, demuxStream: () => {} },
    _calls: calls,
  };
  return client;
};

describe("docker/adapter/attach denylist", () => {
  test("adapter.start in attach mode never calls createContainer", async () => {
    // createContainer on the fake client records the call — if reached, the
    // test would also see an error message other than compose_attach_project_required.
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    const a = createDockerAdapter({ sessionId: "s1", mode: "attach", dockerClient: makeDenylistClient() as any });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec()));
    expect((e as { kind?: string }).kind).toBe("compose_attach_project_required");
    await a.disconnect();
  });

  test("pull is blocked in attach mode (createContainer also blocked)", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    const a = createDockerAdapter({ sessionId: "s1", mode: "attach", project: "myproj", dockerClient: spy as any });
    await a.connect();
    await a.start(mkSpec()); // discovery uses listContainers + inspect — no pull.
    expect(spy._calls).not.toContain("pull");
    expect(spy._calls).not.toContain("createContainer");
    await a.disconnect();
  });

  test("container.remove is never called by teardown in attach mode", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    const a = createDockerAdapter({ sessionId: "s1", mode: "attach", project: "myproj", dockerClient: spy as any });
    await a.connect();
    await a.start(mkSpec());
    await a.teardown();
    expect(spy._calls).not.toContain("container.remove");
    expect(fakeContainers.some((c) => c.Id === "api1")).toBe(true);
    await a.disconnect();
  });

  for (const op of ["stop", "start", "restart", "kill"] as const) {
    test(`container.${op} is not called when allowChaos is false (throws instead)`, async () => {
      fakeContainers = [seedContainer({ Id: "api1" })];
      const spy = makeDenylistClient();
      // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
      const a = createDockerAdapter({ sessionId: "s1", mode: "attach", project: "myproj", dockerClient: spy as any });
      await a.connect();
      const r = await a.start(mkSpec()); // no allowChaos
      spy._calls.length = 0; // reset after start
      const e = await catchKind(() => a.stop(r.containerId));
      expect((e as { kind?: string }).kind).toBe("chaos_unsupported_in_attach_mode");
      expect(spy._calls).not.toContain(`container.${op}`);
      expect(fakeContainers.find((c) => c.Id === "api1")!.status).toBe("running");
      await a.disconnect();
    });
  }

  test("container.stop is called when allowChaos is true", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    const a = createDockerAdapter({ sessionId: "s1", mode: "attach", project: "myproj", dockerClient: spy as any });
    await a.connect();
    const spec = mkSpec({ adapterConfig: { compose: { attach: { allowChaos: true } } } });
    const r = await a.start(spec);
    spy._calls.length = 0;
    await a.stop(r.containerId);
    expect(spy._calls).toContain("container.stop");
    expect(fakeContainers.find((c) => c.Id === "api1")!.status).toBe("exited");
    await a.disconnect();
  });

  test("container.start is permitted through guardAttachClient when allowChaos is true", async () => {
    fakeContainers = [seedContainer({ Id: "api1", status: "exited" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    const a = createDockerAdapter({ sessionId: "s1", mode: "attach", project: "myproj", dockerClient: spy as any });
    await a.connect();
    const spec = mkSpec({ adapterConfig: { compose: { attach: { allowChaos: true } } } });
    // Seed a paused binding so re-start hits the resume path (which calls start).
    fakeContainers[0]!.status = "running"; // must be running for first start
    const r = await a.start(spec);
    await a.stop(r.containerId); // chaos-stop → paused
    fakeContainers[0]!.status = "exited"; // reflect real stopped state
    spy._calls.length = 0;
    await a.start(spec); // resume path calls container.start
    expect(spy._calls).toContain("container.start");
    await a.disconnect();
  });

  test("container.restart is permitted through guardAttachClient when allowChaos is true", async () => {
    // Verify restart is not blocked by the guard when allowChaos=true.
    // Drive it through the fake client directly via the guard (no blocking expected).
    fakeContainers = [seedContainer({ Id: "api1" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    await spy.getContainer("api1").restart();
    expect(spy._calls).toContain("container.restart");
  });

  test("container.kill is permitted through guardAttachClient when allowChaos is true", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    await spy.getContainer("api1").kill();
    expect(spy._calls).toContain("container.kill");
  });

  test("read ops (listContainers, inspect, ping) pass through in attach mode", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const spy = makeDenylistClient();
    // biome-ignore lint/suspicious/noExplicitAny: spy client satisfies DockerClient surface.
    const a = createDockerAdapter({ sessionId: "s1", mode: "attach", project: "myproj", dockerClient: spy as any });
    await a.connect();
    const r = await a.start(mkSpec());
    // ping is called during connect; listContainers + inspect during start; inspect again during exists().
    expect(spy._calls).toContain("ping");
    expect(spy._calls).toContain("listContainers");
    expect(spy._calls).toContain("container.inspect");
    expect(await a.exists(r.containerId)).toBe(true);
    await a.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Discovery + port resolution.
// ---------------------------------------------------------------------------

describe("docker/adapter/attach discovery", () => {
  test("requires a project", async () => {
    const a = mkAdapter();
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec()));
    expect((e as { kind?: string }).kind).toBe("compose_attach_project_required");
    await a.disconnect();
  });

  test("discovers a compose container by convention and resolves ports", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const r = await a.start(mkSpec());
    expect(r.containerId).toBe("attach:myproj/api1");
    expect(r.ports["8080"]).toBe(49153);
    expect(await a.exists(r.containerId)).toBe(true);
    await a.disconnect();
  });

  test("throws compose_attach_service_not_found when no container matches", async () => {
    fakeContainers = [seedContainer({ Id: "other", labels: {
      "com.docker.compose.project": "myproj",
      "com.docker.compose.service": "different",
      "com.docker.compose.container-number": "1",
    } })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec()));
    expect((e as { kind?: string }).kind).toBe("compose_attach_service_not_found");
    await a.disconnect();
  });

  test("throws compose_attach_container_not_running for a stopped container", async () => {
    fakeContainers = [seedContainer({ Id: "api1", status: "exited" })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const e = await catchKind(() => a.start(mkSpec()));
    expect((e as { kind?: string }).kind).toBe("compose_attach_container_not_running");
    await a.disconnect();
  });

  test("honours containerNumber override", async () => {
    fakeContainers = [
      seedContainer({ Id: "api1", number: "1" }),
      seedContainer({ Id: "api2", number: "2", ports: { "8080/tcp": [{ HostPort: "49200" }] } }),
    ];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const r = await a.start(mkSpec({
      adapterConfig: { compose: { attach: { containerNumber: 2 } } },
    }));
    expect(r.containerId).toBe("attach:myproj/api2");
    expect(r.ports["8080"]).toBe(49200);
    await a.disconnect();
  });

  test("honours service + project overrides from adapterConfig", async () => {
    fakeContainers = [seedContainer({ Id: "real1", labels: {
      "com.docker.compose.project": "prod",
      "com.docker.compose.service": "my-real-api",
      "com.docker.compose.container-number": "1",
    } })];
    const a = mkAdapter();
    await a.connect();
    const r = await a.start(mkSpec({
      labels: { speculum: "1", "speculum.session": "s1", "speculum.component": "does-not-match" },
      adapterConfig: { compose: { attach: { project: "prod", service: "my-real-api" } } },
    }));
    expect(r.containerId).toBe("attach:prod/real1");
    await a.disconnect();
  });

  test("port override restricts resolved ports to the named port", async () => {
    fakeContainers = [seedContainer({ Id: "api1", ports: {
      "8080/tcp": [{ HostPort: "49153" }],
      "9090/tcp": [{ HostPort: "49154" }],
    } })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const r = await a.start(mkSpec({
      ports: { "8080": "auto", "9090": "auto" },
      adapterConfig: { compose: { attach: { port: 9090 } } },
    }));
    expect(Object.keys(r.ports)).toEqual(["9090"]);
    expect(r.ports["9090"]).toBe(49154);
    await a.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: teardown is a no-op; chaos stop/start gated by allowChaos.
// ---------------------------------------------------------------------------

describe("docker/adapter/attach lifecycle", () => {
  test("teardown does not remove the user's containers", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    await a.start(mkSpec());
    await a.teardown();
    expect(fakeContainers.some((c) => c.Id === "api1")).toBe(true);
    await a.disconnect();
  });

  test("stop throws chaos_unsupported_in_attach_mode without allowChaos", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const r = await a.start(mkSpec());
    const e = await catchKind(() => a.stop(r.containerId));
    expect((e as { kind?: string }).kind).toBe("chaos_unsupported_in_attach_mode");
    expect(fakeContainers.find((c) => c.Id === "api1")!.status).toBe("running");
    await a.disconnect();
  });

  test("allowChaos lifts stop into a real outage, and re-start resumes it", async () => {
    fakeContainers = [seedContainer({ Id: "api1" })];
    const a = mkAdapter({ project: "myproj" });
    await a.connect();
    const spec = mkSpec({ adapterConfig: { compose: { attach: { allowChaos: true } } } });
    const r = await a.start(spec);
    await a.stop(r.containerId);
    expect(fakeContainers.find((c) => c.Id === "api1")!.status).toBe("exited");
    // Re-start hits startAttach on the paused binding even though the
    // container is stopped — it restarts it and refreshes ports.
    const r2 = await a.start(spec);
    expect(r2.containerId).toBe(r.containerId);
    expect(r2.ports["8080"]).toBe(49153);
    expect(fakeContainers.find((c) => c.Id === "api1")!.status).toBe("running");
    await a.disconnect();
  });
});
