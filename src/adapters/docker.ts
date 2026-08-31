/**
 * DockerAdapter — production adapter against the local Docker daemon.
 *
 * Two modes:
 *   - `mode: "deploy"` (default): pulls images, creates/starts/removes
 *     containers, and writes bind-mount tmpfiles — full lifecycle ownership.
 *   - `mode: "attach"`: connects to an existing docker-compose project via
 *     `com.docker.compose.project`/`service` label discovery, creates and
 *     removes nothing. Optionally exercises chaos-stop/restart when the
 *     per-binding `allowChaos` flag is set.
 *
 * Uses `dockerode` (pure JS, works on both Bun and Node). `logs()` returns
 * `AsyncIterable<string>` of pre-split lines with `AbortSignal` cleanup —
 * live lines only (`tail: 0`), matching the K8s adapter's
 * `kubectl logs -f --tail=0` and avoiding multi‑GiB history replay on
 * long‑lived attach containers. Registers an idempotent SIGINT/SIGTERM
 * handler that stops known containers on Ctrl-C so test runs leave no orphans.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { createRequire } from "node:module";
import { z } from "zod";
import type { Adapter, StartSpec, Started } from "../adapter.js";
import type { Emit, ObserverEventData } from "../observer.js";
import { invariant } from "../invariants.js";

/**
 * Policy for attach-mode image drift — what to do when the discovered
 * container's image does not match the `Binding`'s expectation.
 *
 *  - `"warn"` (default): log the mismatch to stderr and continue attaching.
 *  - `"fail"`: throw `{ kind: "attach_image_drift", ... }`.
 *  - `"ignore"`: skip the check entirely.
 */
export type ImageDriftPolicy = "warn" | "fail" | "ignore";

/**
 * Structured error thrown when `onImageDrift: "fail"` and the discovered
 * attach-mode container's image does not match the `Binding`'s expectation.
 */
export type AttachImageDriftError = {
  readonly kind: "attach_image_drift";
  readonly expected: string;
  readonly actual: string;
  readonly component: string;
};

declare module "../adapter.js" {
  interface AdapterConfig {
    compose?: {
      attach?: {
        project?: string;
        service?: string;
        containerNumber?: number;
        port?: number;
        allowChaos?: boolean;
        /** Per-binding override of the adapter-level `onImageDrift` policy. */
        onImageDrift?: ImageDriftPolicy;
      };
    };
  }
}

export const ComposeAdapterConfigSchema = z.object({
  compose: z.object({
    attach: z.object({
      project: z.string().optional(),
      service: z.string().optional(),
      containerNumber: z.number().optional(),
      port: z.number().optional(),
      allowChaos: z.boolean().optional(),
      onImageDrift: z.enum(["warn", "fail", "ignore"]).optional(),
    }).optional(),
  }).optional(),
});

// WHY: @types/dockerode is not a dependency of this project. Load via
// createRequire so TS doesn't type-resolve it; DockerClient below captures
// the surface we actually consume.
const Docker = createRequire(import.meta.url)("dockerode") as new (opts?: unknown) => DockerClient;

type DockerStream = NodeJS.ReadableStream & { destroy?: (e?: Error) => void };
type DockerContainer = {
  id: string;
  start(): Promise<void>;
  stop(opts?: { t?: number }): Promise<void>;
  restart(opts?: { t?: number }): Promise<void>;
  kill(opts?: { signal?: string }): Promise<void>;
  remove(opts?: { force?: boolean }): Promise<void>;
  inspect(): Promise<{
    /** Top-level image digest (`sha256:...`) the container was created from. */
    Image?: string;
    NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> };
    HostConfig: { Binds: string[] | null };
    Config?: { Labels?: Record<string, string> | null; Image?: string };
    State?: { Status?: string };
  }>;
  logs(opts: {
    follow: true;
    stdout: true;
    stderr: true;
    /** `0` = follow from now; omit/`"all"` = full history (never used by Cyanotype). */
    tail?: number | "all";
  }): Promise<DockerStream>;
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
    followProgress(
      stream: NodeJS.ReadableStream,
      cb: (err: unknown) => void,
      onProgress?: (event: unknown) => void,
    ): void;
    demuxStream(src: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream): void;
  };
};

export type DockerMode = "deploy" | "attach";

export type DockerAdapterOptions = {
  readonly labelPrefix?: string;
  readonly sessionId: string;
  readonly mode?: DockerMode;
  readonly project?: string;
  /**
   * Default policy when the attached container's image differs from the
   * `Binding`'s expectation. Defaults to `"warn"`. A per-binding
   * `adapter.compose.attach.onImageDrift` override beats this value.
   */
  readonly onImageDrift?: ImageDriftPolicy;
};

/**
 * Internal extension of `DockerAdapterOptions` used by `createDockerAdapter`.
 * Adds the `dockerClient` test seam so core tests can inject a fake dockerode
 * client without exposing the opaque `DockerClient` type in the public API.
 * Production callers always use the plain `DockerAdapterOptions`.
 */
type DockerAdapterOptionsInternal = DockerAdapterOptions & {
  /**
   * Test seam: a pre-built dockerode-compatible client. When supplied,
   * `connect()` skips daemon discovery and `ping()`s this client instead.
   * Production callers never set this — it lets core tests exercise
   * discovery/lifecycle logic without a real Docker daemon.
   */
  readonly dockerClient?: DockerClient;
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

/**
 * Attach-mode non-destructive chokepoint (mirrors kubectl `guardAttach`).
 *
 * Wraps a dockerode client so destructive operations throw
 * `{ kind: "attach_mode_violation", op }`. `createContainer`, `pull`, and
 * container `remove` are always blocked; container `stop`/`start`/`restart`/
 * `kill` are blocked unless the per-binding `allowChaos` flag is set. Reads
 * (`listContainers`, `inspect`, `getImage`, `logs`, `ping`) always pass.
 *
 * `getContainer(id)` returns a fresh handle with its own methods, so the
 * wrapper must also wrap that returned handle — not just the top-level client.
 *
 * @internal
 */
const guardAttachClient = (raw: DockerClient, allowChaos: boolean): DockerClient => {
  const deny = (op: string): never => {
    throw { kind: "attach_mode_violation", op };
  };
  const wrapContainer = (cont: DockerContainer): DockerContainer => ({
    id: cont.id,
    inspect: () => cont.inspect(),
    logs: (o) => cont.logs(o),
    remove: () => deny("container.remove"),
    start: allowChaos ? (() => cont.start()) : (() => deny("container.start")),
    stop: allowChaos ? ((o) => cont.stop(o)) : (() => deny("container.stop")),
    restart: allowChaos ? ((o) => cont.restart(o)) : (() => deny("container.restart")),
    kill: allowChaos ? ((o) => cont.kill(o)) : (() => deny("container.kill")),
  });
  return {
    ping: () => raw.ping(),
    getImage: (ref) => raw.getImage(ref),
    listContainers: (o) => raw.listContainers(o),
    getContainer: (id) => wrapContainer(raw.getContainer(id)),
    pull: () => deny("pull"),
    createContainer: () => deny("createContainer"),
    modem: raw.modem,
  };
};

export const createDockerAdapter = (opts: DockerAdapterOptionsInternal): Adapter => {
  const sessionId = opts.sessionId;
  const mode: DockerMode = opts.mode ?? "deploy";
  let client: DockerClient | null = null;
  let agent: http.Agent | https.Agent | null = null;
  const known = new Set<string>();
  const tmpRoots = new Map<string, string>();

  // Per-binding attach state, keyed by the `attach:<project>/<id>` containerId.
  type AttachBinding = {
    readonly realId: string;
    readonly allowChaos: boolean;
    readonly portKeys: string[];
    paused: boolean;
  };
  const attachBindings = new Map<string, AttachBinding>();

  const requireClient = (): DockerClient => {
    if (!client) throw { kind: "docker_not_connected" };
    return client;
  };

  // In attach mode every consumer goes through the guarded chokepoint.
  // `allowChaos` is per-binding, so the guard is rebuilt per call.
  const guardedClient = (allowChaos: boolean): DockerClient =>
    mode === "attach" ? guardAttachClient(requireClient(), allowChaos) : requireClient();

  const realId = (containerId: string): string => {
    const b = attachBindings.get(containerId);
    if (b) return b.realId;
    if (containerId.startsWith("attach:")) return containerId.slice(containerId.indexOf("/") + 1);
    return containerId;
  };

  const ensureImage = async (image: string, emit?: Emit) => {
    const c = requireClient();
    emit?.({ type: "image.resolving", image });
    try {
      await c.getImage(image).inspect();
      emit?.({ type: "image.cache_hit", image });
      return;
    } catch {
      /* fall through to pull */
    }
    emit?.({ type: "image.pull_started", image });
    const pullStart = Date.now();
    let pullStream: NodeJS.ReadableStream;
    try {
      pullStream = await c.pull(image);
    } catch (cause) {
      emit?.({ type: "image.pull_failed", image, error: cause });
      throw { kind: "image_pull_failed", image, cause };
    }
    // Throttle per-layer progress: emit on every status transition, and at
    // most ~1.4×/s while a layer stays in the same status (e.g. Downloading).
    const lastSeen = new Map<string, { status: string; t: number }>();
    const onProgress = (event: unknown): void => {
      if (!emit) return;
      const e = event as {
        status?: string; id?: string;
        progressDetail?: { current?: number; total?: number };
      };
      if (!e?.status) return;
      const key = e.id ?? "_";
      const now = Date.now();
      const prev = lastSeen.get(key);
      if (prev && prev.status === e.status && now - prev.t < 700) return;
      lastSeen.set(key, { status: e.status, t: now });
      const d = e.progressDetail ?? {};
      const percent = d.current !== undefined && d.total
        ? Math.round((d.current / d.total) * 100)
        : undefined;
      const prog: ObserverEventData = {
        type: "image.pull_progress", image, status: e.status,
        ...(e.id !== undefined ? { layerId: e.id } : {}),
        ...(d.current !== undefined ? { current: d.current } : {}),
        ...(d.total !== undefined ? { total: d.total } : {}),
        ...(percent !== undefined ? { percent } : {}),
      };
      emit(prog);
    };
    await new Promise<void>((resolve, reject) => {
      c.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve()), onProgress);
    }).catch((cause) => {
      emit?.({ type: "image.pull_failed", image, error: cause });
      throw { kind: "image_pull_failed", image, cause };
    });
    emit?.({ type: "image.pulled", image, durationMs: Date.now() - pullStart });
  };

  const writeMountFiles = (mounts: Record<string, string>) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyanotype-mounts-"));
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

  // Read `NetworkSettings.Ports["<key>/tcp"][0].HostPort` for each requested
  // port key — the same structure deploy mode reads post-start.
  const resolvePorts = (
    inspected: { NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> } },
    portKeys: string[],
    containerId: string,
  ): Record<string, number> => {
    const networkPorts = inspected.NetworkSettings.Ports ?? {};
    const ports: Record<string, number> = {};
    for (const name of portKeys) {
      const arr = networkPorts[`${name}/tcp`];
      if (!arr || arr.length === 0 || !arr[0]) {
        throw { kind: "port_not_bound", containerId, port: name };
      }
      ports[name] = Number(arr[0].HostPort);
    }
    return ports;
  };

  const stop = async (containerId: string): Promise<void> => {
    if (mode === "attach") {
      const b = attachBindings.get(containerId);
      if (!b) return;
      // Explicit chaos call without opt-in: surface the misconfiguration
      // rather than silently succeeding — the only remaining caller of
      // adapter.stop in attach mode is the chaos API, so no opt-in is a
      // test-author error.
      if (!b.allowChaos) {
        const containerId = b.realId;
        throw {
          kind: "chaos_unsupported_in_attach_mode",
          message: "chaos.stop on an attached binding requires adapter.compose.attach.allowChaos: true",
          containerId,
        };
      }
      // Chaos path: real outage via `docker stop`.
      const c = guardAttachClient(requireClient(), true);
      try {
        await c.getContainer(b.realId).stop({ t: 10 });
      } catch (e) {
        const err = e as { statusCode?: number; message?: string };
        // 304 = "container already stopped / not modified" — legitimate already-stopped.
        if (err?.statusCode === 304 || (typeof err?.message === "string" && /already stopped|not modified/i.test(err.message))) {
          // Container was already stopped — that's fine; still mark paused.
        } else {
          throw { kind: "docker_stop_failed", containerId: b.realId, cause: e };
        }
      }
      b.paused = true;
      return;
    }
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
    if (opts.dockerClient) {
      client = opts.dockerClient;
      try {
        await client.ping();
      } catch (cause) {
        client = null;
        throw { kind: "docker_connect_failed", cause, hint: "Injected client ping failed." };
      }
      return;
    }
    const agentOptions = { keepAlive: false };
    const dockerHost = process.env.DOCKER_HOST;
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

  // Attach mode: discover an existing docker-compose container, never create.
  const startAttach = async (spec: StartSpec, emit?: Emit): Promise<Started> => {
    const attach = spec.adapterConfig?.compose?.attach;
    const project = attach?.project ?? opts.project;
    if (!project) {
      throw { kind: "compose_attach_project_required" };
    }
    const allowChaos = attach?.allowChaos === true;
    const component = spec.labels["cyanotype.component"];
    const instance = spec.labels["cyanotype.instance"];
    const service = attach?.service
      ?? (component ? (instance ? `${component}-${instance}` : component) : undefined);
    if (!service) {
      throw {
        kind: "compose_attach_service_not_found",
        service: null,
        project,
        reason: "missing cyanotype.component label and no adapter.compose.attach.service override",
      };
    }
    const containerNumber = attach?.containerNumber ?? 1;

    const c = guardAttachClient(requireClient(), allowChaos);
    const list = await c.listContainers({
      all: true,
      filters: {
        label: [
          `com.docker.compose.project=${project}`,
          `com.docker.compose.service=${service}`,
        ],
      },
    });
    let match: { id: string; status: string; image: string } | null = null;
    for (const entry of list) {
      const inspected = await c.getContainer(entry.Id).inspect();
      const labels = inspected.Config?.Labels ?? {};
      if (labels["com.docker.compose.container-number"] === String(containerNumber)) {
        match = {
          id: entry.Id,
          status: inspected.State?.Status ?? "unknown",
          // Prefer the human-readable tag (`Config.Image`); fall back to the
          // top-level digest when the tag is unavailable.
          image: inspected.Config?.Image ?? inspected.Image ?? "",
        };
        break;
      }
    }
    if (!match) {
      throw { kind: "compose_attach_service_not_found", service, project, containerNumber };
    }
    const containerId = `attach:${project}/${match.id}`;

    // Compare the discovered container's image against what the `Binding`
    // expects (`spec.image`). Per-binding override beats the adapter-level
    // default; the resolved default is `"warn"`.
    const driftPolicy: ImageDriftPolicy = attach?.onImageDrift ?? opts.onImageDrift ?? "warn";
    if (driftPolicy !== "ignore" && match.image !== "") {
      const expected = spec.image;
      const actual = match.image;
      // Tolerant compare bounded to the digest-suffix shape only: an exact
      // match, or one ref equals the other plus an `@sha256:...` digest.
      // A loose prefix check would false-negative drift (e.g. `redis` vs
      // `redis-evil:latest`); the digest boundary is the only ambiguity
      // worth tolerating.
      const SHA = "@sha256:";
      const aligned = expected === actual
        || actual.startsWith(expected + SHA)
        || expected.startsWith(actual + SHA);
      if (!aligned) {
        if (driftPolicy === "fail") {
          throw {
            kind: "attach_image_drift",
            expected,
            actual,
            component: component ?? service,
          } satisfies AttachImageDriftError;
        }
        // "warn": surface and continue.
        console.warn(
          `[cyanotype] attach_image_drift: component "${component ?? service}" `
          + `expected image "${expected}" but the running container uses "${actual}".`,
        );
      }
    }

    // Resume path: a re-`start` of a chaos-paused binding restarts the real
    // container and refreshes ports. A stopped container is valid here.
    const existing = attachBindings.get(containerId);
    if (existing?.paused) {
      try { await c.getContainer(match.id).start(); } catch { /* already running */ }
      const refreshed = await c.getContainer(match.id).inspect();
      const ports = resolvePorts(refreshed, existing.portKeys, match.id);
      existing.paused = false;
      emit?.({ type: "container.started", containerId, ports });
      return { containerId, ports, owned: false };
    }

    if (match.status !== "running") {
      throw { kind: "compose_attach_container_not_running", service, project, status: match.status, containerId: match.id };
    }

    const portKeys = attach?.port !== undefined
      ? [String(attach.port)]
      : Object.keys(spec.ports);
    const inspected = await c.getContainer(match.id).inspect();
    const ports = resolvePorts(inspected, portKeys, match.id);

    attachBindings.set(containerId, { realId: match.id, allowChaos, portKeys, paused: false });
    known.add(containerId);
    emit?.({ type: "container.started", containerId, ports });
    return { containerId, ports, owned: false };
  };

  const start = async (rawSpec: StartSpec, emit?: Emit): Promise<Started> => {
    // See the Kubernetes adapter: the adapter owns `cyanotype.session` because
    // `teardown()` sweeps by it. (I1)
    const spec: StartSpec = {
      ...rawSpec,
      labels: { ...rawSpec.labels, "cyanotype.session": sessionId },
    };
    if (spec.labels.cyanotype !== "1") {
      throw { kind: "missing_cyanotype_label", labels: spec.labels };
    }
    // I1: see the same check in the Kubernetes adapter — the label stamped on a
    // container must be the one this adapter's teardown sweeps.
    invariant(spec.labels["cyanotype.session"] === sessionId,
      "the stamped session label is the one teardown sweeps",
      () => ({ stamped: spec.labels["cyanotype.session"], sweptBy: sessionId }));
    if (mode === "attach") {
      return await startAttach(spec, emit);
    }
    const c = requireClient();
    const imageRef = spec.image;
    await ensureImage(imageRef, emit);
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

    emit?.({ type: "container.creating", image: imageRef });
    const created = await c.createContainer({
      Image: imageRef,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: exposedPorts,
      Labels: { ...spec.labels, "cyanotype.substrate": "docker" },
      HostConfig: { Binds: binds, PortBindings: portBindings, AutoRemove: false },
    });
    emit?.({ type: "container.created", containerId: created.id });

    emit?.({ type: "container.starting", containerId: created.id });
    try {
      await created.start();
    } catch (cause) {
      emit?.({ type: "container.start_failed", image: imageRef, error: cause });
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

    emit?.({ type: "container.started", containerId: created.id, ports });
    return { containerId: created.id, ports, owned: true };
  };

  const exists = async (containerId: string): Promise<boolean> => {
    const c = guardedClient(false);
    // Attach mode: a chaos-paused binding is "gone" for verification purposes
    // — the orchestrator's chaosStop polls exists() and expects false. The
    // real container is only stopped (not removed), so inspect() still
    // succeeds; mirror the K8s attach adapter, where a stopped binding no
    // longer reports as existing. The binding stays in `attachBindings` so
    // the chaos resume path can re-`start` it.
    if (mode === "attach") {
      const b = attachBindings.get(containerId);
      if (b?.paused) return false;
    }
    try {
      const inspected = await c.getContainer(realId(containerId)).inspect();
      // A stopped-but-not-removed container still inspects successfully.
      // Treat a non-running container as not existing so chaos stop can be
      // verified even if `container.stop()` returns before State flips.
      if (mode === "attach") {
        const status = inspected.State?.Status;
        if (status !== undefined && status !== "running") return false;
      }
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
    const c = guardedClient(false);
    const cont = c.getContainer(realId(containerId));
    // WHY: without tail:0 dockerode replays the entire log buffer on follow.
    // Attach stacks (compose up for hours) can hold tens of MB; replaying them
    // into the event bus has allocated multi‑GiB in consumers. K8s uses --tail=0.
    const raw = await cont.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
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
    // Attach mode: never remove the user's containers.
    if (mode === "attach") {
      attachBindings.clear();
      known.clear();
      return;
    }
    for (const id of Array.from(known)) {
      try { await stop(id); } catch { /* ignore */ }
    }
    if (!client) return;
    try {
      const list = await client.listContainers({
        all: true,
        // Substrate-scoped, not just session-scoped. Where one container
        // runtime is shared with Kubernetes (OrbStack, Docker Desktop), Pods
        // carry the same `cyanotype` and `cyanotype.session` labels, and a
        // session-only filter would sweep up live Pod sandboxes.
        filters: {
          label: [
            "cyanotype.substrate=docker",
            `cyanotype.session=${sessionId}`,
          ],
        },
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
