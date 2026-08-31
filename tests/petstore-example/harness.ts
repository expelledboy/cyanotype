/**
 * Petstore-SLA — harness wiring.
 *
 * CYANOTYPE_ADAPTER selects the substrate at session-start time. The fakes
 * route through a shared store (for primary/replica + petstore state) and a
 * shared upstream map (so the in-process nginx can find the petstores).
 */

import { randomUUID } from "node:crypto";
import {
  createSharedEnvs,
  createDockerAdapter,
  createConsoleReporter,
} from "../../src/index";
import { createInMemoryAdapter, type FakeFactory } from "../../src/adapters/memory";
import { createK8sAdapter } from "../../src/adapters/kubernetes";
import { petstoreFake, createSharedPetStore } from "../fakes/petstore";
import { redisFake } from "../fakes/redis";
import { nginxFake } from "../fakes/nginx";
import { env } from "./env";

const sessionId = randomUUID();
const adapterType = process.env.CYANOTYPE_ADAPTER ?? "docker";

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
      "cyanotype/petstore-sla:latest":      petstoreFactory,
      "cyanotype/redis-configurable:latest": redisFactory,
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
      context: process.env.CYANOTYPE_K8S_CONTEXT ?? "kind-cyanotype",
      namespace: process.env.CYANOTYPE_K8S_NAMESPACE ?? "cyanotype-tests",
    })
  : adapterType === "k8s-attach"
  ? createK8sAdapter({
      mode: "attach",
      sessionId,
      context: process.env.CYANOTYPE_K8S_CONTEXT ?? "kind-cyanotype",
      namespace: process.env.CYANOTYPE_K8S_NAMESPACE ?? "cyanotype-petstore-attach",
    })
  : adapterType === "docker-attach"
  ? createDockerAdapter({
      mode: "attach",
      project: "cyanotype-petstore-attach",
      sessionId,
    })
  : (() => { throw { kind: "unknown_adapter", value: adapterType }; })();

// CYANOTYPE_REPORTER=1 renders the framework lifecycle (probe timings, chaos
// phases, per-component readiness) to stderr. Off by default so test output
// stays clean; invaluable when a run fails and you need the timeline.
const observer = process.env.CYANOTYPE_REPORTER === "1" ? createConsoleReporter() : undefined;

export const shared = createSharedEnvs(
  { "petstore-sla": env },
  {
    adapter,
    stateDir: ".cyanotype-env",
    mode:     "startOrAttach",
    getTargetEnv: () => "petstore-sla",
    // Sequential, deliberately. D-040's concurrent mode is only safe when every
    // component tolerates a dependency that is not yet present, and nginx does
    // not: it resolves its `upstream` hostnames once at config load and EXITS
    // if one is missing (`[emerg] host not found in upstream "petstore-one"`).
    // With `restartPolicy: Never` that pod stays dead and the environment fails.
    //
    // The Kubernetes adapter applies a component's Service only after its Pod
    // is Ready (D-020), so under concurrent startup nginx routinely boots before
    // any petstore Service exists and loses the race. Concurrent startup here
    // was worth ~2s and cost an intermittently unstartable environment.
    startup: "sequential",
    ...(observer ? { observer } : {}),
  },
);
