/**
 * DockerAdapter — production adapter against the local Docker daemon.
 *
 * Uses `dockerode` (pure JS, works on both Bun and Node). `logs()` returns
 * `AsyncIterable<string>` of pre-split lines with `AbortSignal` cleanup.
 * Registers an idempotent SIGINT/SIGTERM handler that stops known
 * containers on Ctrl-C so test runs leave no orphans.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { createRequire } from "node:module";
import type { Adapter, StartSpec, Started } from "../adapter.js";

// WHY: @types/dockerode is not a dependency of this project. Load via
// createRequire so TS doesn't type-resolve it; DockerClient below captures
// the surface we actually consume.
const Docker = createRequire(import.meta.url)("dockerode") as new (opts?: unknown) => DockerClient;

type DockerStream = NodeJS.ReadableStream & { destroy?: (e?: Error) => void };
type DockerContainer = {
  id: string;
  start(): Promise<void>;
  stop(opts?: { t?: number }): Promise<void>;
  remove(opts?: { force?: boolean }): Promise<void>;
  inspect(): Promise<{
    NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> };
    HostConfig: { Binds: string[] | null };
  }>;
  logs(opts: { follow: true; stdout: true; stderr: true }): Promise<DockerStream>;
};
type DockerClient = {
  ping(): Promise<unknown>;
  pull(image: string): Promise<NodeJS.ReadableStream>;
  getImage(ref: string): { inspect(): Promise<unknown> };
  getContainer(id: string): DockerContainer;
  createContainer(opts: Record<string, unknown>): Promise<DockerContainer>;
  listContainers(opts: {
    all?: boolean;
    filters?: { label?: string[] };
  }): Promise<Array<{ Id: string }>>;
  modem: {
    followProgress(stream: NodeJS.ReadableStream, cb: (err: unknown) => void): void;
    demuxStream(src: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream): void;
  };
};

export type DockerAdapterOptions = {
  readonly labelPrefix?: string;
  readonly sessionId: string;
};

let exitHandlerRegistered = false;
const globalKnown = new Set<string>();
const globalStopFns = new Map<string, () => Promise<void>>();

const registerExitHandler = () => {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const onSignal = async () => {
    for (const id of Array.from(globalKnown)) {
      try {
        const fn = globalStopFns.get(id);
        if (fn) await fn();
      } catch {
        /* swallow during shutdown */
      }
    }
    process.exit(process.exitCode ?? 130);
  };
  process.on("SIGTERM", () => void onSignal());
  process.on("SIGINT", () => void onSignal());
};

export const createDockerAdapter = (opts: DockerAdapterOptions): Adapter => {
  const sessionId = opts.sessionId;
  let client: DockerClient | null = null;
  let agent: http.Agent | https.Agent | null = null;
  const known = new Set<string>();
  const tmpRoots = new Map<string, string>();

  const requireClient = (): DockerClient => {
    if (!client) throw { kind: "docker_not_connected" };
    return client;
  };

  const ensureImage = async (image: string) => {
    const c = requireClient();
    try {
      await c.getImage(image).inspect();
      return;
    } catch {
      /* fall through to pull */
    }
    let pullStream: NodeJS.ReadableStream;
    try {
      pullStream = await c.pull(image);
    } catch (cause) {
      throw { kind: "image_pull_failed", image, cause };
    }
    await new Promise<void>((resolve, reject) => {
      c.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve()));
    }).catch((cause) => {
      throw { kind: "image_pull_failed", image, cause };
    });
  };

  const writeMountFiles = (mounts: Record<string, string>) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "speculum-mounts-"));
    const binds: string[] = [];
    for (const [containerPath, content] of Object.entries(mounts)) {
      const safeRel = containerPath.replace(/^\/+/, "").split("/").join(path.sep);
      const hostPath = path.join(tmpRoot, safeRel);
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });
      fs.writeFileSync(hostPath, content, "utf8");
      binds.push(`${hostPath}:${containerPath}:ro`);
    }
    return { tmpRoot, binds };
  };

  const stop = async (containerId: string): Promise<void> => {
    if (!known.has(containerId)) return;
    const c = requireClient();
    const cont = c.getContainer(containerId);
    try { await cont.stop({ t: 10 }); } catch { /* already stopped */ }
    try { await cont.remove({ force: true }); } catch { /* already gone */ }
    const tmp = tmpRoots.get(containerId);
    if (tmp) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpRoots.delete(containerId);
    }
    known.delete(containerId);
    globalKnown.delete(containerId);
    globalStopFns.delete(containerId);
  };

  const connect = async (): Promise<void> => {
    if (client) return;
    const agentOptions = { keepAlive: false };
    const dockerHost = process.env["DOCKER_HOST"];
    // WHY: `agent` is supported by docker-modem at runtime but not in any
    // @types we have — we already lack @types/dockerode entirely; the cast
    // is the documented escape per the task spec.
    let ctorOpts: Record<string, unknown>;
    if (dockerHost) {
      if (dockerHost.startsWith("unix://")) {
        agent = new http.Agent(agentOptions);
        ctorOpts = { socketPath: dockerHost.replace("unix://", ""), agent };
      } else if (/^(tcp|https?):\/\//.test(dockerHost)) {
        const u = new URL(dockerHost.replace(/^tcp:\/\//, "http://"));
        const useHttps = u.protocol === "https:";
        agent = useHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
        ctorOpts = { protocol: u.protocol.replace(":", ""), host: u.hostname, port: Number(u.port) || (useHttps ? 2376 : 2375), agent };
      } else {
        agent = new http.Agent(agentOptions);
        ctorOpts = { agent };
      }
    } else {
      const defaultSock = "/var/run/docker.sock";
      const macDesktopSock = path.join(os.homedir(), ".docker", "run", "docker.sock");
      agent = new http.Agent(agentOptions);
      if (fs.existsSync(defaultSock)) ctorOpts = { socketPath: defaultSock, agent };
      else if (fs.existsSync(macDesktopSock)) ctorOpts = { socketPath: macDesktopSock, agent };
      else ctorOpts = { agent };
    }
    client = new Docker(ctorOpts);
    try {
      await client.ping();
    } catch (cause) {
      if (agent) { agent.destroy(); agent = null; }
      client = null;
      throw {
        kind: "docker_connect_failed",
        cause,
        hint: "Is the Docker daemon running? Check DOCKER_HOST.",
      };
    }
  };

  const disconnect = async (): Promise<void> => {
    if (agent) { agent.destroy(); agent = null; }
    client = null;
  };

  const start = async (spec: StartSpec): Promise<Started> => {
    const c = requireClient();
    const imageRef = spec.image;
    if (spec.labels["speculum"] !== "1") {
      throw { kind: "missing_speculum_label", labels: spec.labels };
    }
    await ensureImage(imageRef);
    const { tmpRoot, binds } = writeMountFiles(spec.mounts);

    // WHY (v1 limitation): StartSpec.ports is keyed by port NAME, but Docker
    // needs the container port number. v1 treats the name as the container
    // port number (callers use "8080" etc.). Assumes TCP.
    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const [name, value] of Object.entries(spec.ports)) {
      const key = `${name}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: value === "auto" ? "" : String(value) }];
    }

    const created = await c.createContainer({
      Image: imageRef,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: exposedPorts,
      Labels: spec.labels,
      HostConfig: { Binds: binds, PortBindings: portBindings, AutoRemove: false },
    });

    try {
      await created.start();
    } catch (cause) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      try { await created.remove({ force: true }); } catch { /* ignore */ }
      throw { kind: "container_start_failed", image: imageRef, cause };
    }

    const inspected = await created.inspect();
    const networkPorts = inspected.NetworkSettings.Ports ?? {};
    const ports: Record<string, number> = {};
    for (const name of Object.keys(spec.ports)) {
      const arr = networkPorts[`${name}/tcp`];
      if (!arr || arr.length === 0 || !arr[0]) {
        throw { kind: "port_not_bound", containerId: created.id, port: name };
      }
      ports[name] = Number(arr[0].HostPort);
    }

    known.add(created.id);
    tmpRoots.set(created.id, tmpRoot);
    globalKnown.add(created.id);
    globalStopFns.set(created.id, () => stop(created.id));
    registerExitHandler();

    return { containerId: created.id, ports };
  };

  const exists = async (containerId: string): Promise<boolean> => {
    const c = requireClient();
    try {
      await c.getContainer(containerId).inspect();
      return true;
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      if (err?.statusCode === 404) return false;
      if (typeof err?.message === "string" && /no such container/i.test(err.message)) return false;
      throw e;
    }
  };

  async function* logs(containerId: string, signal?: AbortSignal): AsyncIterable<string> {
    if (signal?.aborted) return;
    const c = requireClient();
    const cont = c.getContainer(containerId);
    const raw = await cont.logs({ follow: true, stdout: true, stderr: true });
    const out = new PassThrough();
    c.modem.demuxStream(raw, out, out);
    const rl = readline.createInterface({ input: out });
    const cleanup = () => {
      try { rl.close(); } catch { /* ignore */ }
      try { raw.destroy?.(); } catch { /* ignore */ }
      try { out.destroy(); } catch { /* ignore */ }
    };
    const onAbort = () => cleanup();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const line of rl) {
        yield line as string;
        if (signal?.aborted) break;
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      cleanup();
    }
  }

  const teardown = async (): Promise<void> => {
    for (const id of Array.from(known)) {
      try { await stop(id); } catch { /* ignore */ }
    }
    if (!client) return;
    try {
      const list = await client.listContainers({
        all: true,
        filters: { label: ["speculum=1", `speculum.session=${sessionId}`] },
      });
      for (const entry of list) {
        const cont = client.getContainer(entry.Id);
        try { await cont.stop({ t: 5 }); } catch { /* ignore */ }
        try { await cont.remove({ force: true }); } catch { /* ignore */ }
      }
    } catch {
      /* daemon unavailable */
    }
  };

  return {
    name: "docker",
    connect,
    disconnect,
    teardown,
    start,
    stop,
    exists,
    logs,
  };
};
