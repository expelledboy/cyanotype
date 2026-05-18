/**
 * KubernetesAdapter — drives `kubectl` via `Bun.spawn` (D-019).
 *
 * Deploy mode is implemented here: bare Pod + ConfigMap per `StartSpec`,
 * one `kubectl port-forward` subprocess per port (D-017). Attach mode
 * (D-018) is out of scope for this PR; the `mode` factory option and the
 * kubectl helper's write-verb denylist exist so attach can slot in later
 * without re-plumbing.
 */

import type { Subprocess } from "bun";
import type { Adapter, StartSpec, Started } from "../adapter";
import { createKubectl, type KubectlClient, type KubectlMode } from "./kubectl";

export type K8sAdapterOptions = {
  readonly mode: KubectlMode;
  readonly sessionId: string;
  readonly context?: string;
  readonly namespace?: string;
};

const DEFAULT_NS = "speculum-tests";
const POD_READY_TIMEOUT_MS = 60_000;
const PORT_READY_TIMEOUT_MS = 10_000;

type Tracked = {
  readonly podName: string;
  readonly namespace: string;
  readonly context: string | undefined;
  readonly forwards: Subprocess[];
};

let exitHandlerRegistered = false;
const globalKnown = new Set<string>();
const globalTracked = new Map<string, Tracked>();
const globalSessions = new Set<{ namespace: string; sessionId: string; context: string | undefined }>();

const killForwards = (t: Tracked) => {
  for (const p of t.forwards) {
    try { p.kill(); } catch { /* ignore */ }
  }
};

const registerExitHandler = () => {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const onSignal = () => {
    for (const t of globalTracked.values()) killForwards(t);
    for (const s of globalSessions) {
      const argv = ["kubectl"];
      if (s.context) argv.push("--context", s.context);
      argv.push("-n", s.namespace, "delete", "pods,configmaps",
        "-l", `speculum=1,speculum.session=${s.sessionId}`,
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
    volumeMounts.push({ name: "speculum-mounts", mountPath: containerPath, subPath: basename, readOnly: true });
  }
  const volumes = cmName
    ? [{ name: "speculum-mounts", configMap: { name: cmName } }]
    : [];
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: podName, namespace, labels: spec.labels },
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
    metadata: { name: cmName, namespace, labels: spec.labels },
    data,
  };
};

const sanitisePodName = (sessionId: string): string => {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const sid = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20).replace(/^-+|-+$/g, "") || "s";
  return `speculum-${sid}-${stamp}-${rand}`;
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

  const connect = async (): Promise<void> => {
    const ver = await k.run(["version", "--client", "-o", "json"]);
    if (ver.exit !== 0) throw { kind: "kubectl_not_found", stderr: ver.stderr };

    const ns = await k.run(["get", "namespace", namespace, "-o", "name"]);
    if (ns.exit !== 0) {
      if (mode === "attach") {
        throw { kind: "k8s_namespace_missing", namespace };
      }
      const create = await k.run(["create", "namespace", namespace]);
      if (create.exit !== 0 && !/already exists/i.test(create.stderr)) {
        throw { kind: "k8s_namespace_create_failed", namespace, stderr: create.stderr };
      }
    }
    globalSessions.add(sessionEntry);
    registerExitHandler();
  };

  const disconnect = async (): Promise<void> => {
    globalSessions.delete(sessionEntry);
  };

  const waitForPodRunning = async (podName: string): Promise<void> => {
    const start = Date.now();
    let lastPhase = "Unknown";
    while (Date.now() - start < POD_READY_TIMEOUT_MS) {
      const r = await k.run(["get", "pod", podName, "-o", "json"]);
      if (r.exit === 0) {
        try {
          const obj = JSON.parse(r.stdout) as { status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean }> } };
          lastPhase = obj.status?.phase ?? lastPhase;
          if (lastPhase === "Running") {
            const cs = obj.status?.containerStatuses ?? [];
            if (cs.length > 0 && cs.every((c) => c.ready === true)) return;
            if (cs.length === 0) return;
          }
          if (lastPhase === "Failed" || lastPhase === "Succeeded") {
            throw { kind: "k8s_pod_not_ready", podName, lastPhase, elapsedMs: Date.now() - start };
          }
        } catch (e) {
          const err = e as { kind?: string };
          if (err?.kind === "k8s_pod_not_ready") throw e;
        }
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw { kind: "k8s_pod_not_ready", podName, lastPhase, elapsedMs: Date.now() - start };
  };

  const startPortForward = (podName: string, containerPort: number, requestedLocal: number | "auto"): Promise<{ proc: Subprocess; localPort: number }> => {
    const localSpec = requestedLocal === "auto" ? `:${containerPort}` : `${requestedLocal}:${containerPort}`;
    const handle = k.stream(["port-forward", `pod/${podName}`, localSpec]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.kill();
        reject({ kind: "k8s_port_forward_timeout", podName, containerPort, elapsedMs: PORT_READY_TIMEOUT_MS });
      }, PORT_READY_TIMEOUT_MS);
      (async () => {
        try {
          for await (const line of handle.lines) {
            const m = line.match(/Forwarding from 127\.0\.0\.1:(\d+) ->/);
            if (m && m[1]) {
              clearTimeout(timer);
              resolve({ proc: handle.proc, localPort: Number(m[1]) });
              return;
            }
          }
          clearTimeout(timer);
          reject({ kind: "k8s_port_forward_exited", podName, containerPort });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      })();
    });
  };

  const stop = async (containerId: string): Promise<void> => {
    const t = tracked.get(containerId);
    if (t) {
      killForwards(t);
      tracked.delete(containerId);
      globalTracked.delete(containerId);
    }
    known.delete(containerId);
    globalKnown.delete(containerId);
    if (mode === "deploy") {
      await k.run(["delete", "pod", containerId, "--ignore-not-found=true"]);
      await k.run(["delete", "configmap", `${containerId}-mounts`, "--wait=false", "--ignore-not-found=true"]);
    }
  };

  const start = async (spec: StartSpec): Promise<Started> => {
    if (spec.labels["speculum"] !== "1") {
      throw { kind: "missing_speculum_label", labels: spec.labels };
    }
    if (mode !== "deploy") {
      throw { kind: "k8s_mode_unsupported", mode };
    }
    const podName = sanitisePodName(sessionId);
    const hasMounts = Object.keys(spec.mounts).length > 0;
    const cmName = hasMounts ? `${podName}-mounts` : null;

    if (cmName) {
      const cmManifest = buildConfigMapManifest(cmName, spec, namespace);
      const cmRes = await k.run(["apply", "-f", "-"], { stdin: JSON.stringify(cmManifest) });
      if (cmRes.exit !== 0) {
        throw { kind: "k8s_configmap_apply_failed", cmName, stderr: cmRes.stderr };
      }
    }

    const podManifest = buildPodManifest(podName, cmName, spec, namespace);
    const podRes = await k.run(["apply", "-f", "-"], { stdin: JSON.stringify(podManifest) });
    if (podRes.exit !== 0) {
      if (cmName) {
        await k.run(["delete", "configmap", cmName, "--wait=false", "--ignore-not-found=true"]);
      }
      throw { kind: "k8s_pod_apply_failed", podName, stderr: podRes.stderr };
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

    const ports: Record<string, number> = {};
    const forwards: Subprocess[] = [];
    try {
      for (const [name, value] of Object.entries(spec.ports)) {
        const containerPort = Number(name);
        const { proc, localPort } = await startPortForward(podName, containerPort, value);
        forwards.push(proc);
        ports[name] = localPort;
      }
    } catch (e) {
      for (const p of forwards) { try { p.kill(); } catch { /* ignore */ } }
      await k.run(["delete", "pod", podName, "--wait=false", "--ignore-not-found=true"]);
      if (cmName) {
        await k.run(["delete", "configmap", cmName, "--wait=false", "--ignore-not-found=true"]);
      }
      throw e;
    }

    const t: Tracked = { podName, namespace, context, forwards };
    tracked.set(podName, t);
    globalTracked.set(podName, t);
    known.add(podName);
    globalKnown.add(podName);

    return { containerId: podName, ports };
  };

  const exists = async (containerId: string): Promise<boolean> => {
    const r = await k.run(["get", "pod", containerId, "-o", "name"]);
    if (r.exit === 0) return true;
    if (/NotFound|not found/i.test(r.stderr)) return false;
    return known.has(containerId);
  };

  async function* logs(containerId: string, signal?: AbortSignal): AsyncIterable<string> {
    if (signal?.aborted) return;
    const handle = k.stream(["logs", "-f", "--tail=0", containerId]);
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
      try { await stop(id); } catch { /* ignore */ }
    }
    if (mode === "deploy") {
      try {
        await k.run([
          "delete", "pods,configmaps",
          "-l", `speculum=1,speculum.session=${sessionId}`,
          "--wait=false", "--ignore-not-found=true",
        ]);
      } catch { /* ignore */ }
    }
    for (const t of Array.from(globalTracked.values())) {
      if (t.namespace === namespace) killForwards(t);
    }
    known.clear();
  };

  return {
    name: "kubernetes",
    connect,
    disconnect,
    teardown,
    start,
    stop,
    exists,
    logs,
  };
};
