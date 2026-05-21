/**
 * Petstore-SLA — harness wiring.
 *
 * SPECULUM_ADAPTER selects the substrate at session-start time. The fakes
 * route through a shared store (for primary/replica + petstore state) and a
 * shared upstream map (so the in-process nginx can find the petstores).
 */

import { randomUUID } from "node:crypto";
import {
  createSharedEnvs,
  createDockerAdapter,
} from "../../src/index";
import { createInMemoryAdapter, type FakeFactory } from "../../src/adapters/memory";
import { createK8sAdapter } from "../../src/adapters/kubernetes";
import { petstoreFake, createSharedPetStore } from "../fakes/petstore";
import { redisFake } from "../fakes/redis";
import { nginxFake } from "../fakes/nginx";
import { env } from "./env";

const sessionId = randomUUID();
const adapterType = process.env.SPECULUM_ADAPTER ?? "docker";

const buildMemoryAdapter = () => {
  const store = createSharedPetStore();
  const upstreams = new Map<string, string>();

  const petstoreFactory: FakeFactory = async (spec, emit) => {
    const instanceId = spec.instance ?? "default";
    const inner = petstoreFake({ instanceId, store });
    const handle = await inner(spec, emit);
    const port = handle.ports.http ?? handle.ports["8080"] ?? 0;
    upstreams.set(instanceId, `http://127.0.0.1:${port}`);
    return {
      ports: { "8080": port },
      close: async () => {
        upstreams.delete(instanceId);
        await handle.close();
      },
    };
  };

  const redisFactory: FakeFactory = async (spec, emit) => {
    const role = spec.instance === "primary" ? "primary" : "replica";
    return redisFake({ store, role })(spec, emit);
  };

  const nginxFactory: FakeFactory = async (spec, emit) =>
    nginxFake({ upstreams })(spec, emit);

  return createInMemoryAdapter({
    factories: {
      "speculum/petstore-sla:latest":      petstoreFactory,
      "speculum/redis-configurable:latest": redisFactory,
      "nginx:alpine":                      nginxFactory,
    },
  });
};

const adapter = adapterType === "docker"
  ? createDockerAdapter({ sessionId })
  : adapterType === "memory"
  ? buildMemoryAdapter()
  : adapterType === "k8s"
  ? createK8sAdapter({
      mode: "deploy",
      sessionId,
      context: process.env.SPECULUM_K8S_CONTEXT ?? "orbstack",
      namespace: process.env.SPECULUM_K8S_NAMESPACE ?? "speculum-tests",
    })
  : adapterType === "k8s-attach"
  ? createK8sAdapter({
      mode: "attach",
      sessionId,
      context: process.env.SPECULUM_K8S_CONTEXT ?? "orbstack",
      namespace: process.env.SPECULUM_K8S_NAMESPACE ?? "speculum-petstore-attach",
    })
  : adapterType === "docker-attach"
  ? createDockerAdapter({
      mode: "attach",
      project: "speculum-petstore-attach",
      sessionId,
    })
  : (() => { throw { kind: "unknown_adapter", value: adapterType }; })();

export const shared = createSharedEnvs(
  { "petstore-sla": env },
  {
    adapter,
    stateDir: ".speculum-env",
    mode:     "startOrAttach",
    getTargetEnv: () => "petstore-sla",
  },
);
