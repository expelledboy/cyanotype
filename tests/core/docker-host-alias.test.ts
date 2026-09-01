/**
 * The Docker adapter asks for `host.docker.internal` explicitly.
 *
 * WHY THIS IS PINNED. Containers in this harness reach each other through
 * published host ports, and `host.docker.internal` is the name they use to hop
 * back to the host. Docker Desktop and OrbStack define it themselves, so on a
 * developer's Mac the adapter appeared to work without asking for it. Plain
 * Linux Docker does not define it, and there the omission surfaced as every
 * component failing readiness — a 30-second timeout naming a container that
 * was running correctly and simply could not resolve its neighbours.
 *
 * A substrate test cannot catch a regression here on a machine whose runtime
 * supplies the name anyway; only asserting on what the adapter ASKS FOR can.
 * That is the whole point of this file, and why it lives in tests/core rather
 * than beside the real-Docker suites. See D-048.
 */

import { describe, test, expect } from "bun:test";
import { createDockerAdapter } from "../../src/adapters/docker";
import type { StartSpec } from "../../src/adapter";

// `DockerClient` is structural and not exported, and there is no
// @types/dockerode in this project, so a partial fake cannot satisfy it
// nominally. Same documented escape the attach-mode suite uses.
// biome-ignore lint/suspicious/noExplicitAny: see above
type InjectedDockerClient = any;

type CreateArgs = { HostConfig?: { ExtraHosts?: string[] } };

const spyClient = (captured: CreateArgs[]) => ({
  ping: async () => "OK",
  getImage: (_r: string) => ({ inspect: async () => ({}) }),
  pull: async () => { throw new Error("image is present; pull should not run"); },
  createContainer: async (opts: CreateArgs) => {
    captured.push(opts);
    return {
      id: "c1",
      start: async () => {},
      inspect: async () => ({
        NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "34567" }] } },
        HostConfig: { Binds: null },
        Config: { Labels: {}, Image: "img" },
        State: { Status: "running" },
      }),
      remove: async () => {},
    };
  },
  getContainer: () => { throw new Error("not used"); },
  listContainers: async () => [],
});

const spec: StartSpec = {
  image: "img",
  env: {},
  ports: { "8080": "auto" },
  mounts: {},
  labels: { cyanotype: "1" },
};

describe("docker/adapter host alias", () => {
  test("start() maps host.docker.internal to the bridge gateway", async () => {
    const captured: CreateArgs[] = [];
    const a = createDockerAdapter({
      sessionId: "s1",
      dockerClient: spyClient(captured) as unknown as InjectedDockerClient,
    });
    await a.connect();
    await a.start(spec);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.HostConfig?.ExtraHosts).toEqual([
      "host.docker.internal:host-gateway",
    ]);
  });
});
