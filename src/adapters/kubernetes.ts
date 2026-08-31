/**
 * KubernetesAdapter — drives `kubectl` via `Bun.spawn` (D-019).
 *
 * Deploy mode (D-017/D-020): bare Pod + ConfigMap + Service per `StartSpec`,
 * one `kubectl port-forward` subprocess per port.
 *
 * Attach mode (D-018/D-021): Service-discovery + Watch-driven reconnect, no
 * cluster mutation by default. Per-Binding `allowChaos: true + deployment:
 * <name>` (D-023, rewritten) lifts the `scale` verb only and drives real
 * outage via `kubectl scale deployment/<x> --replicas=0|1`.
 */

import net from "node:net";
import type { Subprocess } from "bun";
import { z } from "zod";
import type { Adapter, StartSpec, Started, ReconnectSpec, Reconnected } from "../adapter.js";
import { createKubectl, type KubectlClient, type KubectlMode } from "./kubectl.js";
import { invariant } from "../invariants.js";

declare module "../adapter.js" {
  interface AdapterConfig {
    k8s?: {
      attach?: {
        namespace?: string;
        service?: string;
        port?: number;
        allowChaos?: boolean;
        deployment?: string;
      };
    };
  }
}

export const K8sAdapterConfigSchema = z.object({
  k8s: z.object({
    attach: z.object({
      namespace: z.string().optional(),
      service: z.string().optional(),
      port: z.number().optional(),
      allowChaos: z.boolean().optional(),
      deployment: z.string().optional(),
    }).optional(),
  }).optional(),
});

export type K8sAdapterOptions = {
  readonly mode: KubectlMode;
  readonly sessionId: string;
  readonly context?: string;
  readonly namespace?: string;
};

const DEFAULT_NS = "cyanotype-tests";
const POD_READY_TIMEOUT_MS = 60_000;
const PORT_READY_TIMEOUT_MS = 10_000;

type Tracked = {
  readonly podName: string;
  readonly namespace: string;
  readonly context: string | undefined;
  readonly forwards: Subprocess[];
  readonly serviceName: string | null;
  readonly attach?: AttachState;
};

type ReconnectForward = {
  readonly localPort: number;
  readonly containerPort: number;
  currentPod: string;
  proc: Subprocess | null;
  stopped: boolean;
  paused: boolean;
  kill(): void;
  pause(): void;
};

type AttachState = {
  readonly serviceName: string;
  readonly namespace: string;
  readonly allowChaos: boolean;
  readonly deployment: string | null;
  readonly k: KubectlClient;
  currentPod: string;
  paused: boolean;
  readonly reconnects: ResumableForward[];
};

let exitHandlerRegistered = false;
const globalKnown = new Set<string>();
const globalTracked = new Map<string, Tracked>();
const globalSessions = new Set<{ namespace: string; sessionId: string; context: string | undefined }>();
const pausedAttaches = new Map<string, {
  reconnects: ResumableForward[];
  serviceName: string;
  namespace: string;
  deployment: string | null;
  k: KubectlClient;
}>();

const ENDPOINT_WAIT_TIMEOUT_MS = 30_000;

/**
 * Ready endpoint count, or `null` when the cluster could not be asked.
 *
 * "Could not tell" and "zero" must not be the same value. This returned 0 for
 * both, and `chaos.stop` waits for `n === 0`: a listing that failed on RBAC or
 * an unreachable API server satisfied that predicate instantly, so chaos
 * reported the workload down without ever having looked. A resilience test then
 * asserts behaviour "while the service is down" against a service that is fully
 * up — a false green, which is the one failure a chaos library must not have.
 *
 * The `n >= 1` direction did not have the bug: 0 kept it waiting until it threw.
 * That asymmetry is why this went unnoticed.
 */
const countReadyEndpoints = async (k: KubectlClient, serviceName: string): Promise<number | null> => {
  const r = await k.run([
    "get", "endpointslices",
    "-l", `kubernetes.io/service-name=${serviceName}`,
    "-o", "json",
  ]);
  if (r.exit !== 0) return null;
  type Slice = { endpoints?: Array<{ conditions?: { ready?: boolean } }> };
  let parsed: { items?: Slice[] };
  try { parsed = JSON.parse(r.stdout) as { items?: Slice[] }; } catch { return null; }
  let n = 0;
  for (const slice of parsed.items ?? []) {
    for (const ep of slice.endpoints ?? []) {
      if (ep.conditions?.ready === true) n++;
    }
  }
  return n;
};

const waitForEndpoints = async (
  k: KubectlClient,
  serviceName: string,
  predicate: (n: number) => boolean,
  timeoutMs = ENDPOINT_WAIT_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let unreadable = 0;
  while (Date.now() < deadline) {
    const n = await countReadyEndpoints(k, serviceName);
    // Only a real count can satisfy the predicate. An unreadable cluster keeps
    // polling and ultimately times out loudly, in BOTH directions.
    if (n !== null && predicate(n)) return;
    if (n === null) unreadable++;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw { kind: "k8s_attach_endpoint_wait_timeout", service: serviceName, timeoutMs, unreadable };
};

const killForwards = (t: Tracked) => {
  for (const p of t.forwards) {
    try { p.kill(); } catch { /* ignore */ }
  }
  if (t.attach) {
    for (const r of t.attach.reconnects) {
      try { r.kill(); } catch { /* ignore */ }
    }
  }
};

const claimLocalPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject({
          kind: "k8s_local_port_claim_failed",
          hint:
            "The OS accepted a bind on port 0 but then reported no usable address for the socket, " +
            "which should not happen. Note this is NOT the port-exhaustion case: when no ephemeral " +
            "port is available the bind itself fails and surfaces as an untagged socket error, not " +
            "as this. If you are seeing repeated port trouble, look for leaked kubectl port-forward " +
            "processes from earlier runs holding ports open.",
        });
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });

const registerExitHandler = () => {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const onSignal = () => {
    for (const t of globalTracked.values()) killForwards(t);
    for (const s of globalSessions) {
      const argv = ["kubectl"];
      if (s.context) argv.push("--context", s.context);
      argv.push("-n", s.namespace, "delete", "pods,configmaps,services",
        "-l", `cyanotype=1,cyanotype.session=${s.sessionId}`,
        "--wait=false", "--ignore-not-found=true");
      try { Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }); } catch { /* ignore */ }
    }
    process.exit(process.exitCode ?? 130);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
};

const buildPodManifest = (
  podName: string,
  cmName: string | null,
  spec: StartSpec,
  namespace: string,
  extraLabels: Record<string, string>,
): unknown => {
  const containerPorts = Object.keys(spec.ports).map((name) => ({
    containerPort: Number(name),
    protocol: "TCP",
  }));
  const env = Object.entries(spec.env).map(([name, value]) => ({ name, value }));
  const volumeMounts: Array<{ name: string; mountPath: string; subPath: string; readOnly: boolean }> = [];
  const cmData: Record<string, string> = {};
  let i = 0;
  for (const [containerPath, content] of Object.entries(spec.mounts)) {
    const basename = `file-${i++}`;
    cmData[basename] = content;
    volumeMounts.push({ name: "cyanotype-mounts", mountPath: containerPath, subPath: basename, readOnly: true });
  }
  const volumes = cmName
    ? [{ name: "cyanotype-mounts", configMap: { name: cmName } }]
    : [];
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName, namespace,
      labels: { ...spec.labels, ...extraLabels, "cyanotype.substrate": "kubernetes" },
    },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "main",
          image: spec.image,
          imagePullPolicy: "IfNotPresent",
          env,
          ports: containerPorts,
          ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
        },
      ],
      ...(volumes.length > 0 ? { volumes } : {}),
    },
  };
};

const buildConfigMapManifest = (
  cmName: string,
  spec: StartSpec,
  namespace: string,
): unknown => {
  const data: Record<string, string> = {};
  let i = 0;
  for (const content of Object.values(spec.mounts)) {
    data[`file-${i++}`] = content;
  }
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: cmName, namespace,
      labels: { ...spec.labels, "cyanotype.substrate": "kubernetes" },
    },
    data,
  };
};

const sanitiseDnsLabel = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "x";

const buildServiceName = (spec: StartSpec): string | null => {
  const component = spec.labels["cyanotype.component"];
  if (!component) return null;
  const instance = spec.labels["cyanotype.instance"];
  const raw = instance ? `${component}-${instance}` : component;
  return sanitiseDnsLabel(raw);
};

/**
 * Select the *binding*, not one pod. `cyanotype.component` + optional
 * `cyanotype.instance`, scoped to the session, identify a slot across pod
 * replacement, so the Service survives chaos and its endpoints follow the new
 * pod automatically.
 *
 * WHY this matters beyond tidiness: selecting on a per-pod label forced chaos
 * to delete the Service with the pod, which deletes the cluster-internal DNS
 * name. Dependents then hit NXDOMAIN — a different, slower-to-recover failure
 * than the connection-refused a real pod death produces, since resolvers cache
 * negative answers and clients back off against a name that no longer exists.
 * A dead pod behind a live Service is what production actually does. (D-039)
 */
const buildServiceSelector = (spec: StartSpec): Record<string, string> => {
  const selector: Record<string, string> = {};
  for (const key of ["cyanotype.component", "cyanotype.instance", "cyanotype.session"]) {
    const value = spec.labels[key];
    if (value !== undefined) selector[key] = value;
  }
  return selector;
};

const buildServiceManifest = (
  serviceName: string,
  spec: StartSpec,
  namespace: string,
): unknown => {
  const ports = Object.keys(spec.ports).map((name) => ({
    name: `p-${name}`,
    port: Number(name),
    targetPort: Number(name),
    protocol: "TCP",
  }));
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: serviceName, namespace,
      labels: { ...spec.labels, "cyanotype.substrate": "kubernetes" },
    },
    spec: {
      type: "ClusterIP",
      selector: buildServiceSelector(spec),
      ports,
    },
  };
};

const sanitisePodName = (sessionId: string): string => {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const sid = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20).replace(/^-+|-+$/g, "") || "s";
  return `cyanotype-${sid}-${stamp}-${rand}`;
};

const resolveReadyPod = async (
  k: KubectlClient,
  serviceName: string,
): Promise<string> => {
  const r = await k.run([
    "get", "endpointslices",
    "-l", `kubernetes.io/service-name=${serviceName}`,
    "-o", "json",
  ]);
  if (r.exit !== 0) {
    throw {
      kind: "k8s_attach_no_ready_endpoints",
      service: serviceName,
      stderr: r.stderr,
      hint:
        `Listing EndpointSlices for Service "${serviceName}" failed — this is the query erroring, not a Service with no endpoints yet. The credentials need list on endpointslices in the discovery.k8s.io group, and the context and namespace must be the workload\u2019s. See docs/k8s-rbac.md; \`stderr\` carries what kubectl said.`,
    };
  }
  type Slice = {
    endpoints?: Array<{
      conditions?: { ready?: boolean };
      targetRef?: { name?: string; kind?: string };
    }>;
  };
  let parsed: { items?: Slice[] };
  try { parsed = JSON.parse(r.stdout) as { items?: Slice[] }; }
  catch { throw { kind: "k8s_attach_endpointslice_parse_failed", service: serviceName }; }
  for (const slice of parsed.items ?? []) {
    for (const ep of slice.endpoints ?? []) {
      if (ep.conditions?.ready === true && ep.targetRef?.kind === "Pod" && ep.targetRef.name) {
        return ep.targetRef.name;
      }
    }
  }
  throw {
    kind: "k8s_attach_no_ready_endpoints",
    service: serviceName,
    hint:
      `Service "${serviceName}" resolves to no ready Pod endpoint, so there is nothing to port-forward to. Its selector may match no pods, the pods it matches may be failing readiness, or their endpoints may not target a Pod — only Pod-backed ready endpoints count here. Describe the Service to see its selector and current endpoints, remembering to pass the namespace and context the adapter uses: a bare kubectl reads your current ones, which are usually not the same.`,
  };
};

type ResumableForward = ReconnectForward & { resume(initialPod: string): Promise<void> };

const startReconnectForward = async (
  k: KubectlClient,
  serviceName: string,
  initialPod: string,
  containerPort: number,
  onPodChange: (pod: string) => void,
  presetLocalPort?: number,
): Promise<ResumableForward> => {
  const localPort = presetLocalPort ?? await claimLocalPort();
  const state: ResumableForward = {
    localPort,
    containerPort,
    currentPod: initialPod,
    proc: null,
    stopped: false,
    paused: false,
    kill: () => {
      state.stopped = true;
      if (state.proc) { try { state.proc.kill(); } catch { /* ignore */ } }
    },
    pause: () => {
      state.paused = true;
      if (state.proc) { try { state.proc.kill(); } catch { /* ignore */ } }
    },
    resume: async (pod: string) => {
      state.currentPod = pod;
      // Clear `paused` only AFTER the new child exists. The supervisor polls
      // this flag; if it were cleared first, the supervisor could wake while
      // `state.proc` still referenced the dead child, see it already exited,
      // and race into its own respawn.
      await spawnOnce(pod);
      state.paused = false;
    },
  };

  const spawnOnce = (pod: string): Promise<void> => {
    const handle = k.stream(["port-forward", `pod/${pod}`, `${localPort}:${containerPort}`]);
    state.proc = handle.proc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { handle.kill(); } catch { /* ignore */ }
        reject({
          kind: "k8s_port_forward_timeout",
          podName: pod,
          containerPort,
        hint:
          `kubectl port-forward produced no local listener for pod ${pod} within ${PORT_READY_TIMEOUT_MS}ms. kubectl port-forward reports "Forwarding from ..." as soon as it has opened the LOCAL listener; it does not dial the container port first, so a container that is not listening cannot cause this timeout and checking it will not fix it. The tunnel runs through the API server, so this is reachability or authorization for the pods/portforward subresource. Note the pod was observed Ready earlier, not now.`,
        });
      }, PORT_READY_TIMEOUT_MS);
      (async () => {
        try {
          for await (const line of handle.lines) {
            if (/Forwarding from 127\.0\.0\.1:\d+ ->/.test(line)) {
              clearTimeout(timer);
              resolve();
              return;
            }
          }
          clearTimeout(timer);
          reject({
            kind: "k8s_port_forward_exited",
            podName: pod,
            containerPort,
            hint:
              `kubectl port-forward for pod ${pod} exited instead of forwarding port ` +
              `${containerPort}. Usually the pod went away underneath it, or the credentials lack ` +
              `create on pods/portforward in this namespace — see docs/k8s-rbac.md. No stderr is captured on this path.`,
          });
        } catch (e) { clearTimeout(timer); reject(e); }
      })();
    });
  };

  await spawnOnce(initialPod);

  (async () => {
    while (!state.stopped) {
      const proc = state.proc;
      if (!proc) break;
      try { await proc.exited; } catch { /* ignore */ }
      if (state.stopped) break;
      if (state.paused) {
        while (state.paused && !state.stopped) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (state.stopped) break;
        // `resume()` has already spawned the replacement and published it as
        // `state.proc`. Falling through to the respawn path below would spawn a
        // SECOND child and overwrite the reference to the first, orphaning a
        // `kubectl port-forward` that nothing can subsequently kill — one leaked
        // process per chaos cycle. Re-enter instead and supervise the new child.
        continue;
      }
      let attempts = 0;
      let newPod: string | null = null;
      while (attempts < 3 && !state.stopped) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          newPod = await resolveReadyPod(k, serviceName);
          break;
        } catch { attempts++; }
      }
      if (state.stopped) break;
      if (!newPod) {
        state.stopped = true;
        console.error(JSON.stringify({ kind: "k8s_attach_reconnect_failed", service: serviceName, attempts }));
        break;
      }
      state.currentPod = newPod;
      onPodChange(newPod);
      try { await spawnOnce(newPod); }
      catch { /* loop back, will try again on next exit */ }
    }
  })();

  return state;
};

export const createK8sAdapter = (opts: K8sAdapterOptions): Adapter => {
  const namespace = opts.namespace ?? DEFAULT_NS;
  const context = opts.context;
  const sessionId = opts.sessionId;
  const mode = opts.mode;
  const k: KubectlClient = createKubectl({ mode, namespace, context });
  const known = new Set<string>();
  const tracked = new Map<string, Tracked>();
  const sessionEntry = { namespace, sessionId, context };

  // `connect` is called once by the orchestrator and again by the shared
  // registry on each of its paths — five call sites in all. The Docker adapter
  // already short-circuits a repeat (`if (client) return`); this one re-ran a
  // `kubectl version --client` that cannot change during a session, plus a
  // namespace get and a possible create, every time. Same contract, ~120ms per
  // redundant call reclaimed. `disconnect` clears it so a later reconnect works.
  let connected = false;

  const connect = async (): Promise<void> => {
    if (connected) return;
    const ver = await k.run(["version", "--client", "-o", "json"]);
    if (ver.exit !== 0) {
      throw {
        kind: "kubectl_not_found",
        stderr: ver.stderr,
        hint:
          `The Kubernetes adapter shells out to kubectl, and the client-version check it runs ` +
          `first exited non-zero. A kubectl was found and executed, so this is not an empty ` +
          `PATH (a missing binary fails earlier, as a spawn ENOENT): what is on PATH is not a ` +
          `usable client — commonly a wrapper script that failed, or a build too old for the ` +
          `flags the adapter passes. Check which kubectl the test process resolves; stderr ` +
          `carries its own message.`,
      };
    }

    const ns = await k.run(["get", "namespace", namespace, "-o", "name"]);
    if (ns.exit !== 0) {
      if (mode === "attach") {
        throw {
          kind: "k8s_namespace_missing",
          namespace,
          stderr: ns.stderr,
          hint:
            `kubectl could not read namespace "${namespace}". That is either genuinely absent or forbidden — \`stderr\` says which, and the two need opposite fixes. Attach mode never creates cluster resources, so if it is absent, create it and deploy your workloads there, or point the adapter at the namespace they already occupy. If it is forbidden, note that a request for a single namespace is authorized as a namespaced request, so a Role in that namespace granting get on namespaces is enough — docs/k8s-rbac.md does not currently include such a rule.`,
        };
      }
      const create = await k.run(["create", "namespace", namespace]);
      if (create.exit !== 0 && !/already exists/i.test(create.stderr)) {
        throw {
          kind: "k8s_namespace_create_failed",
          namespace,
          stderr: create.stderr,
          hint:
            `Creating namespace "${namespace}" failed. Deploy mode creates its own namespace, and namespaces are cluster-scoped, so this needs a ClusterRole granting create on namespaces — docs/k8s-rbac.md documents only the namespaced Roles and does not cover this, so do not expect to find it there. The simpler route is to pre-create the namespace and pass its name to createK8sAdapter. \`stderr\` carries what the API server said.`,
        };
      }
    }
    globalSessions.add(sessionEntry);
    registerExitHandler();
    connected = true;
  };

  const disconnect = async (): Promise<void> => {
    connected = false;
    // Release the port-forwards this process opened. `stop()` already does it
    // for containers we stop, but a process that only ATTACHED never stops
    // anything, so without this it leaks one `kubectl port-forward` child per
    // port on a clean exit. The signal handler covers SIGINT/SIGTERM only, and
    // a normally-terminating `bun test` fires neither. Measured against the
    // k8s-attach suite: two orphaned children before, none after.
    for (const t of tracked.values()) killForwards(t);
    tracked.clear();
    for (const [key, p] of Array.from(pausedAttaches.entries())) {
      if (p.namespace === namespace) {
        for (const r of p.reconnects) { try { r.kill(); } catch { /* ignore */ } }
        pausedAttaches.delete(key);
      }
    }
    globalSessions.delete(sessionEntry);
  };

  const waitForPodRunning = async (podName: string): Promise<void> => {
    const start = Date.now();
    // kubectl wait uses the watch API — returns as soon as the kubelet
    // marks Ready, rather than polling every 500ms.
    const timeoutSec = Math.max(1, Math.floor(POD_READY_TIMEOUT_MS / 1000));
    const r = await k.run(["wait", "pod", podName, "--for=condition=Ready", `--timeout=${timeoutSec}s`]);
    if (r.exit === 0) return;
    // Fall through: inspect once for a structured error.
    const inspect = await k.run(["get", "pod", podName, "-o", "json"]);
    let lastPhase = "Unknown";
    try {
      const obj = JSON.parse(inspect.stdout) as { status?: { phase?: string } };
      lastPhase = obj.status?.phase ?? lastPhase;
    } catch { /* ignore */ }
    throw {
      kind: "k8s_pod_not_ready",
      podName, lastPhase, elapsedMs: Date.now() - start, stderr: r.stderr,
      hint:
        `Pod ${podName} never became Ready (last phase "${lastPhase}"). This is the pod, not Cyanotype: "Pending" means it cannot be scheduled or its image cannot be pulled, and "Failed" or "Succeeded" mean the container already exited — the pod spec sets restartPolicy: Never, so nothing restarted it and there is no crash loop to watch. Inspect it with the adapter\u2019s own namespace and context, which a bare kubectl will not use: kubectl --context ${context ?? "<current>"} -n ${namespace} describe pod ${podName}.`,
    };
  };

  const startPortForward = (podName: string, containerPort: number, requestedLocal: number | "auto"): Promise<{ proc: Subprocess; localPort: number }> => {
    const localSpec = requestedLocal === "auto" ? `:${containerPort}` : `${requestedLocal}:${containerPort}`;
    const handle = k.stream(["port-forward", `pod/${podName}`, localSpec]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.kill();
        reject({
          kind: "k8s_port_forward_timeout",
          podName,
          containerPort,
          elapsedMs: PORT_READY_TIMEOUT_MS,
        hint:
          `kubectl port-forward produced no local listener for pod ${podName} within ${PORT_READY_TIMEOUT_MS}ms. kubectl port-forward reports "Forwarding from ..." as soon as it has opened the LOCAL listener; it does not dial the container port first, so a container that is not listening cannot cause this timeout and checking it will not fix it. The tunnel runs through the API server, so this is reachability or authorization for the pods/portforward subresource. Note the pod was observed Ready earlier, not now.`,
        });
      }, PORT_READY_TIMEOUT_MS);
      (async () => {
        try {
          for await (const line of handle.lines) {
            const m = line.match(/Forwarding from 127\.0\.0\.1:(\d+) ->/);
            if (m?.[1]) {
              clearTimeout(timer);
              resolve({ proc: handle.proc, localPort: Number(m[1]) });
              return;
            }
          }
          clearTimeout(timer);
          let stderr = "";
          try { stderr = await new Response(handle.proc.stderr as unknown as ReadableStream).text(); } catch { /* ignore */ }
          reject({
            kind: "k8s_port_forward_exited",
            podName,
            containerPort,
            stderr,
            hint:
              `kubectl port-forward for pod ${podName} exited instead of forwarding port ` +
              `${containerPort}. Usually the pod went away underneath it, or the credentials lack ` +
              `create on pods/portforward in this namespace — see docs/k8s-rbac.md. stderr carries the message kubectl printed.`,
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      })();
    });
  };

  const stop = async (containerId: string): Promise<void> => {
    const t = tracked.get(containerId);
    if (t?.attach && containerId.startsWith("attach:")) {
      if (!t.attach.allowChaos) {
        throw {
          kind: "chaos_unsupported_in_attach_mode",
          service: t.attach.serviceName,
          namespace: t.namespace,
          hint:
            `Chaos is refused for "${t.attach.serviceName}" because its Binding did not opt in. Attach mode blocks cluster writes at the kubectl chokepoint unless a Binding asks for them, which is what makes it safe to point at a shared namespace — with one exception worth knowing: the SIGINT/SIGTERM handler issues a session-scoped delete outside that chokepoint. To disrupt this component set adapter.k8s.attach.allowChaos: true on its Binding, together with the Deployment name chaos scales.`,
        };
      }
      const deployment = t.attach.deployment;
      // `startAttach` refuses `allowChaos` without a deployment, and it is the
      // only place an AttachState is built — so reaching here with `allowChaos`
      // true and no deployment would mean that agreement broke. This was a
      // thrown error carrying advice ("set adapter.k8s.attach.deployment") for a
      // configuration the reader cannot be in: they would have been stopped at
      // start time. A hint nobody can reach is not a hint.
      invariant(() => deployment !== null,
        "an AttachState that allows chaos names a Deployment",
        () => ({ service: t.attach?.serviceName, namespace: t.namespace }));
      if (!deployment) return;
      t.attach.paused = true;
      for (const r of t.attach.reconnects) r.pause();
      // D-023 (rewritten): real cluster mutation. Scale the Deployment to 0
      // so cluster-internal traffic actually fails — pausing the port-forward
      // alone leaves Service DNS routing intact.
      const ak = t.attach.k;
      const scaleRes = await ak.run([
        "scale", `deployment/${deployment}`, "--replicas=0",
      ]);
      if (scaleRes.exit !== 0) {
        throw {
          kind: "k8s_attach_scale_failed",
          deployment, replicas: 0, stderr: scaleRes.stderr,
          hint:
            `Scaling deployment/${deployment} down to 0 failed, so chaos could not take the component down. The likeliest cause is no Deployment by that name in this namespace — adapter.k8s.attach.deployment must name the Deployment, not the Service. Otherwise it is permissions: there is no "scale" verb in Kubernetes RBAC, so granting one does nothing; the credentials need get and patch on deployments/scale in the apps group. See docs/k8s-rbac.md, and \`stderr\` for what kubectl said.`,
        };
      }
      await waitForEndpoints(ak, t.attach.serviceName, (n) => n === 0);
      pausedAttaches.set(`${t.namespace}/${t.attach.serviceName}`, {
        reconnects: t.attach.reconnects,
        serviceName: t.attach.serviceName,
        namespace: t.namespace,
        deployment,
        k: ak,
      });
      tracked.delete(containerId);
      globalTracked.delete(containerId);
      known.delete(containerId);
      globalKnown.delete(containerId);
      return;
    }
    if (t) {
      killForwards(t);
      tracked.delete(containerId);
      globalTracked.delete(containerId);
    }
    known.delete(containerId);
    globalKnown.delete(containerId);
    if (mode === "deploy") {
      // Fire deletes in parallel and don't block on graceful termination —
      // chaos tests stop+start within a single afterEach hook and the default
      // bun:test hook timeout (5s) is tight on K8s substrate.
      const tasks: Array<Promise<unknown>> = [
        k.run(["delete", "pod", containerId, "--wait=false", "--ignore-not-found=true", "--grace-period=0", "--force"]),
        k.run(["delete", "configmap", `${containerId}-mounts`, "--wait=false", "--ignore-not-found=true"]),
      ];
      // The Service is deliberately left in place. Deleting it would remove the
      // cluster-internal DNS name along with the pod, which is a compound fault
      // production never produces: a dead pod leaves a live Service with no
      // endpoints, so dependents get connection-refused and recover promptly.
      // Suite teardown removes it by label. (D-039)
      await Promise.all(tasks);
    }
  };

  const startAttach = async (spec: StartSpec): Promise<Started> => {
    const override = spec.adapterConfig?.k8s?.attach;
    const attachNamespace = override?.namespace ?? namespace;
    const allowChaos = override?.allowChaos === true;
    const deployment = override?.deployment ?? null;
    if (allowChaos && !deployment) {
      throw {
        kind: "k8s_attach_deployment_required",
        hint:
          `Chaos in attach mode scales a Deployment to 0 and back, so it needs the ` +
          `Deployment's name — a Service alone cannot be scaled. Set ` +
          `adapter.k8s.attach.deployment alongside allowChaos: true on the Binding for ` +
          `"${spec.labels["cyanotype.component"] ?? "<unknown>"}", or drop allowChaos if this ` +
          `component should not be disrupted.`,
        component: spec.labels["cyanotype.component"],
        instance: spec.labels["cyanotype.instance"],
      };
    }
    // D-023 (rewritten): the per-binding attach kubectl client only lifts
    // the `scale` verb when allowChaos is on — every other write stays
    // blocked at the D-018 chokepoint.
    const attachK: KubectlClient = createKubectl({
      mode, namespace: attachNamespace, context, allowChaosScale: allowChaos,
    });
    const serviceName = override?.service ?? buildServiceName(spec);
    if (!serviceName) {
      throw {
        kind: "k8s_attach_service_not_found",
        service: null,
        namespace: attachNamespace,
        hint:
          `Cyanotype resolves a Service name from the component name by convention, but this ` +
          `StartSpec carries no cyanotype.component label to derive one from. Set ` +
          `adapter.k8s.attach.service on the Binding to name the Service in namespace ` +
          `"${attachNamespace}" explicitly.`,
      };
    }
    const pausedKey = `${attachNamespace}/${serviceName}`;
    const paused = pausedAttaches.get(pausedKey);
    if (paused) {
      // Scale the Deployment back to 1 (chaos.start half of D-023). Then wait
      // for the EndpointSlice to report ≥1 Ready endpoint before re-resolving
      // a Pod for the port-forward respawn.
      if (paused.deployment) {
        const scaleRes = await paused.k.run([
          "scale", `deployment/${paused.deployment}`, "--replicas=1",
        ]);
        if (scaleRes.exit !== 0) {
          throw {
            kind: "k8s_attach_scale_failed",
            deployment: paused.deployment, replicas: 1, stderr: scaleRes.stderr,
            hint:
              `Scaling deployment/${paused.deployment} back to 1 failed, so the component chaos stopped is still down and nothing will bring it back on its own — you may need to scale it up by hand. On permissions: there is no "scale" verb in Kubernetes RBAC, so granting one does nothing; the credentials need get and patch on deployments/scale in the apps group. See docs/k8s-rbac.md, and \`stderr\` for what kubectl said.`,
          };
        }
        await waitForEndpoints(paused.k, serviceName, (n) => n >= 1);
      }
      pausedAttaches.delete(pausedKey);
      const initialPod = await resolveReadyPod(attachK, serviceName);
      const ports: Record<string, number> = {};
      for (const r of paused.reconnects) {
        await r.resume(initialPod);
        ports[String(r.containerPort)] = r.localPort;
      }
      const attach: AttachState = { serviceName, namespace: attachNamespace, allowChaos, deployment, k: attachK, currentPod: initialPod, paused: false, reconnects: paused.reconnects };
      const containerId = `attach:${attachNamespace}/${initialPod}`;
      const t: Tracked = { podName: initialPod, namespace: attachNamespace, context, forwards: [], serviceName, attach };
      tracked.set(containerId, t);
      globalTracked.set(containerId, t);
      known.add(containerId);
      globalKnown.add(containerId);
      return { containerId, ports, owned: false };
    }
    const svc = await attachK.run(["get", "svc", serviceName, "-o", "json"]);
    if (svc.exit !== 0) {
      throw {
        kind: "k8s_attach_service_not_found",
        service: serviceName, namespace: attachNamespace, stderr: svc.stderr,
        hint:
          `kubectl could not read Service "${serviceName}" in namespace "${attachNamespace}" — \`stderr\` says whether it is absent, forbidden, or the API server was unreachable, and those need different fixes. If you did not set adapter.k8s.attach.service, this name was derived from the component name by convention and your cluster may simply spell it differently; set that option to name it explicitly. If you did set it, the name is yours and the namespace or permissions are the thing to check.`,
      };
    }
    const initialPod = await resolveReadyPod(attachK, serviceName);
    const attach: AttachState = { serviceName, namespace: attachNamespace, allowChaos, deployment, k: attachK, currentPod: initialPod, paused: false, reconnects: [] };
    const ports: Record<string, number> = {};
    try {
      const portKeys = override?.port !== undefined ? [String(override.port)] : Object.keys(spec.ports);
      for (const name of portKeys) {
        const containerPort = Number(name);
        const wrapper = await startReconnectForward(attachK, serviceName, initialPod, containerPort, (p) => {
          attach.currentPod = p;
        });
        attach.reconnects.push(wrapper);
        ports[name] = wrapper.localPort;
      }
    } catch (e) {
      for (const r of attach.reconnects) { try { r.kill(); } catch { /* ignore */ } }
      throw e;
    }
    const containerId = `attach:${attachNamespace}/${initialPod}`;
    const t: Tracked = { podName: initialPod, namespace: attachNamespace, context, forwards: [], serviceName, attach };
    tracked.set(containerId, t);
    globalTracked.set(containerId, t);
    known.add(containerId);
    globalKnown.add(containerId);
    return { containerId, ports, owned: false };
  };

  const start = async (rawSpec: StartSpec): Promise<Started> => {
    // The adapter is authoritative for `cyanotype.session`: `teardown()` sweeps
    // by this label, so whatever the caller handed in is replaced with the id
    // this adapter will actually look for. Normalised once here so the Pod,
    // ConfigMap and Service all carry the same value and are swept together.
    //
    // Before this, `createSharedEnvs` stamped `${process.pid}-${Date.now()}`,
    // recomputed per call — so the label meant to group a session was unique
    // per container — while teardown selected on the adapter's own id. D-016's
    // backstop could never match anything. (I1)
    const spec: StartSpec = {
      ...rawSpec,
      labels: { ...rawSpec.labels, "cyanotype.session": sessionId },
    };
    if (spec.labels.cyanotype !== "1") {
      throw { kind: "missing_cyanotype_label", labels: spec.labels };
    }
    if (mode === "attach") {
      return await startAttach(spec);
    }
    const podName = sanitisePodName(sessionId);
    const hasMounts = Object.keys(spec.mounts).length > 0;
    const cmName = hasMounts ? `${podName}-mounts` : null;

    if (cmName) {
      const cmManifest = buildConfigMapManifest(cmName, spec, namespace);
      const cmRes = await k.run(["apply", "-f", "-"], { stdin: JSON.stringify(cmManifest) });
      if (cmRes.exit !== 0) {
        throw {
          kind: "k8s_configmap_apply_failed",
          cmName,
          stderr: cmRes.stderr,
          hint:
            `Applying the ConfigMap that carries this Binding's mounts failed. Mount-as-content ` +
            `becomes a ConfigMap, so the credentials in use need create on configmaps in this ` +
            `namespace; ` + "see docs/k8s-rbac.md for the verbs the adapter needs; stderr carries kubectl's own message.",
        };
      }
    }

    const podManifest = buildPodManifest(podName, cmName, spec, namespace, { "cyanotype.podname": podName });
    // I4: a Service whose selector is not a subset of its Pod's labels never
    // gets endpoints. Nothing errors; dependents simply hang until a probe
    // times out somewhere unrelated.
    invariant( () =>
      Object.entries(buildServiceSelector(spec)).every(
        ([k, v]) => (podManifest as { metadata: { labels: Record<string, string> } }).metadata.labels[k] === v,
      ),
      "Service selector is a subset of the Pod labels",
      () => ({
        selector: buildServiceSelector(spec),
        podLabels: (podManifest as { metadata: { labels: Record<string, string> } }).metadata.labels,
      }),
    );
    const podRes = await k.run(["apply", "-f", "-"], { stdin: JSON.stringify(podManifest) });
    if (podRes.exit !== 0) {
      if (cmName) {
        await k.run(["delete", "configmap", cmName, "--wait=false", "--ignore-not-found=true"]);
      }
      throw {
        kind: "k8s_pod_apply_failed",
        podName,
        stderr: podRes.stderr,
        hint:
          `Applying Pod ${podName} was rejected by the API server. Common causes are missing ` +
          `create permission on pods, a namespace quota or LimitRange, or an admission ` +
          `controller rejecting the spec; ` + "see docs/k8s-rbac.md for the verbs the adapter needs; stderr carries kubectl's own message.",
      };
    }

    try {
      await waitForPodRunning(podName);
    } catch (e) {
      await k.run(["delete", "pod", podName, "--wait=false", "--ignore-not-found=true"]);
      if (cmName) {
        await k.run(["delete", "configmap", cmName, "--wait=false", "--ignore-not-found=true"]);
      }
      throw e;
    }

    // D-020: per-Pod Service for in-cluster DNS. Service name is stable
    // (`<component>[-<instance>]`); selector is the unique podname label so
    // each Service points to exactly one Pod.
    const serviceName = Object.keys(spec.ports).length > 0 ? buildServiceName(spec) : null;
    if (serviceName) {
      const svcManifest = buildServiceManifest(serviceName, spec, namespace);
      const svcRes = await k.run(["apply", "-f", "-"], { stdin: JSON.stringify(svcManifest) });
      if (svcRes.exit !== 0) {
        await k.run(["delete", "pod", podName, "--wait=false", "--ignore-not-found=true"]);
        if (cmName) {
          await k.run(["delete", "configmap", cmName, "--wait=false", "--ignore-not-found=true"]);
        }
        throw {
          kind: "k8s_service_apply_failed",
          serviceName,
          stderr: svcRes.stderr,
          hint:
            `Applying Service "${serviceName}" failed. Each component with ports gets one so other components can reach it by DNS. The Service name is stable per component and deliberately outlives a chaos stop, so on any run after the first this apply is a get-then-patch, not a create — credentials with only create on services will fail here. docs/k8s-rbac.md lists the full set; \`stderr\` carries what the API server said.`,
        };
      }
    }

    const ports: Record<string, number> = {};
    const forwards: Subprocess[] = [];
    try {
      for (const [name, _value] of Object.entries(spec.ports)) {
        const containerPort = Number(name);
        // Always "auto" for the local side: cross-component traffic uses the
        // Service DNS (D-020), so pinning a stable host port across restarts
        // has no remote consumer and creates a TIME_WAIT hazard for chaos
        // tests that stop+start the same component within seconds.
        const { proc, localPort } = await startPortForward(podName, containerPort, "auto");
        forwards.push(proc);
        ports[name] = localPort;
      }
    } catch (e) {
      for (const p of forwards) { try { p.kill(); } catch { /* ignore */ } }
      await k.run(["delete", "pod", podName, "--wait=false", "--ignore-not-found=true"]);
      if (cmName) {
        await k.run(["delete", "configmap", cmName, "--wait=false", "--ignore-not-found=true"]);
      }
      if (serviceName) {
        await k.run(["delete", "service", serviceName, "--wait=false", "--ignore-not-found=true"]);
      }
      throw e;
    }

    const t: Tracked = { podName, namespace, context, forwards, serviceName };
    tracked.set(podName, t);
    globalTracked.set(podName, t);
    known.add(podName);
    globalKnown.add(podName);

    return { containerId: podName, ports, owned: true };
  };

  const exists = async (containerId: string): Promise<boolean> => {
    if (containerId.startsWith("attach:")) {
      const t = tracked.get(containerId);
      if (!t) return false;
      const svcName = t.serviceName;
      if (!svcName) return false;
      const r = await k.run(["get", "svc", svcName, "-o", "name"]);
      if (r.exit === 0) return true;
      if (/NotFound|not found/i.test(r.stderr)) return false;
      return known.has(containerId);
    }
    const r = await k.run(["get", "pod", containerId, "-o", "name"]);
    if (r.exit === 0) return true;
    if (/NotFound|not found/i.test(r.stderr)) return false;
    return known.has(containerId);
  };

  async function* logs(containerId: string, signal?: AbortSignal): AsyncIterable<string> {
    if (signal?.aborted) return;
    let target = containerId;
    if (containerId.startsWith("attach:")) {
      const t = tracked.get(containerId);
      target = t?.attach?.currentPod ?? containerId.slice(containerId.indexOf("/") + 1);
    }
    const handle = k.stream(["logs", "-f", "--tail=0", target]);
    const onAbort = () => handle.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const line of handle.lines) {
        yield line;
        if (signal?.aborted) break;
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      handle.kill();
    }
  }

  const teardown = async (): Promise<void> => {
    for (const id of Array.from(known)) {
      const t = tracked.get(id);
      if (t?.attach) {
        for (const r of t.attach.reconnects) { try { r.kill(); } catch { /* ignore */ } }
        tracked.delete(id);
        globalTracked.delete(id);
        known.delete(id);
        globalKnown.delete(id);
        continue;
      }
      try { await stop(id); } catch { /* ignore */ }
    }
    for (const [key, p] of Array.from(pausedAttaches.entries())) {
      if (p.namespace === namespace) {
        for (const r of p.reconnects) { try { r.kill(); } catch { /* ignore */ } }
        pausedAttaches.delete(key);
      }
    }
    if (mode === "deploy") {
      try {
        await k.run([
          "delete", "pods,configmaps,services",
          "-l", `cyanotype=1,cyanotype.session=${sessionId}`,
          "--wait=false", "--ignore-not-found=true",
        ]);
      } catch { /* ignore */ }
    }
    for (const t of Array.from(globalTracked.values())) {
      if (t.namespace === namespace) killForwards(t);
    }
    known.clear();
  };

  /**
   * D-046. Re-open port-forwards to a Pod another process started.
   *
   * Deploy mode only, and the adapter exposes it only in deploy mode — in
   * attach mode a component's ports are Service-anchored reconnect wrappers
   * whose Service name can be overridden per Binding, so re-establishing them
   * is the reconcile-shaped work D-046 defers rather than a re-forward.
   *
   * Creates nothing in the cluster. Registers in `tracked` — the port-forward
   * cleanup set — and deliberately NOT in `known`, which means "containers this
   * session created and must remove": `teardown()` walks `known` and calls
   * `stop(id)`, deleting the Pod. A reconnecting process created nothing.
   */
  const reconnect = async (spec: ReconnectSpec): Promise<Reconnected> => {
    const podName = spec.containerId;
    const check = await k.run(["get", "pod", podName, "-o", "jsonpath={.status.phase}"]);
    const phase = check.stdout.trim();
    if (check.exit !== 0 || phase !== "Running") {
      throw { kind: "k8s_reconnect_pod_not_running", podName, phase, stderr: check.stderr };
    }
    const ports: Record<string, number> = {};
    const forwards: Subprocess[] = [];
    try {
      for (const name of spec.ports) {
        const { proc, localPort } = await startPortForward(podName, Number(name), "auto");
        forwards.push(proc);
        ports[name] = localPort;
      }
    } catch (e) {
      for (const fp of forwards) { try { fp.kill(); } catch { /* ignore */ } }
      throw e;
    }
    const t: Tracked = { podName, namespace, context, forwards, serviceName: null };
    tracked.set(podName, t);
    globalTracked.set(podName, t);
    return { containerId: podName, ports };
  };

  return {
    name: "kubernetes",
    ...(mode === "deploy" ? { reconnect } : {}),
    connect,
    disconnect,
    teardown,
    start,
    stop,
    exists,
    logs,
  };
};
