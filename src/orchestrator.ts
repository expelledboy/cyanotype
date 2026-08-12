/**
 * Orchestrator — the glue between an Environment of Bindings and the Adapter.
 *
 * Owns:
 *   - per-component lifecycle (start / stop / restart)
 *   - port resolution (the Binding's "auto" / fixed → host port)
 *   - interface enrichment (calls the Blueprint factory with config, env,
 *     and resolved ports)
 *   - readiness/health probes (declared on the Blueprint)
 *   - log-stream wiring: `adapter.logs()` → `binding.logParser` →
 *     per-component `EventBus<Cat>` typed against the Blueprint's catalog
 *   - chaos controls (typed by Environment shape)
 *   - snapshot (a getter that walks the live registry; no state machine)
 *
 * The orchestrator hands a Binding to the Adapter as a flat `StartSpec`
 * (image, ports, mounts, env, labels, instance). The Blueprint never
 * crosses the Adapter boundary — substrate-agnostic by construction.
 *
 * Two entry points share most of the per-component setup:
 *   - startEnvironment: calls adapter.start for each Binding
 *   - attachEnvironment: trusts containerIds + ports from a metadata snapshot
 */

import type { Adapter, StartSpec } from "./adapter.js";
import type { Environment } from "./environment.js";
import type { Runtime, RuntimeSnapshot, Running } from "./runtime.js";
import type { Binding } from "./binding.js";
import type { InterfaceRecord } from "./interface.js";
import type { EventBusInternals, EventCatalog } from "./events.js";
import { createEventBus } from "./events.js";
import { createHelpers } from "./helpers.js";
import { createHttpClient } from "./protocol.js";
import { runProbe } from "./probe.js";
import type { EnvironmentMetadata, SlotSnapshot, ComponentSnapshot } from "./metadata.js";
import type { Observer } from "./observer.js";
import { createEmitter } from "./observer.js";

export type OrchestratorOptions = {
  readonly adapter: Adapter;
  readonly sessionId: string;
  readonly envKey: string;
  /**
   * Framework-lifecycle observer (`observer.ts`). Receives substrate /
   * image-pull / container / probe / environment / chaos telemetry. Opt-in:
   * omitted = zero cost, silent (today's behaviour).
   */
  readonly observer?: Observer;
};

type Emitter = ReturnType<typeof createEmitter>;

const countBindings = (env: Environment): number => {
  let n = 0;
  for (const slot of Object.values(env)) {
    if (isSingleBinding(slot)) n += 1;
    else n += Object.keys(slot as Record<string, unknown>).length;
  }
  return n;
};

export type AttachSnapshot = {
  readonly components: Readonly<Record<string, SlotSnapshot>>;
};

// biome-ignore lint/suspicious/noExplicitAny: orchestrator handles bindings of any Blueprint shape
type AnyBinding = Binding<any>;

type ComponentState = {
  readonly componentName: string;
  readonly instanceId: string | undefined;
  readonly binding: AnyBinding;
  containerId: string;
  ports: Record<string, number>;
  interface: InterfaceRecord;
  api: unknown;
  eventBus: EventBusInternals<EventCatalog>;
  signal: AbortController;
  running: Running<unknown>;
  status: "starting" | "running" | "stopped";
  /**
   * Whether the orchestrator owns this container's lifecycle. `true` =
   * `runtime.stop()` calls `adapter.stop()`. `false` = `runtime.stop()`
   * detaches (aborts log streams, marks stopped) without touching the
   * container. `attachOne` always sets `false`; `startOne` reads it from
   * `Started.owned` returned by the adapter.
   */
  owned: boolean;
};

const isSingleBinding = (slot: unknown): slot is AnyBinding =>
  typeof slot === "object"
    && slot !== null
    && "blueprint" in slot
    && typeof (slot as { image?: unknown }).image === "string";

const deriveAutoApi = (ifaceRecord: InterfaceRecord, uri: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, i] of Object.entries(ifaceRecord)) {
    if (i.protocol.kind === "http") {
      out[name] = createHttpClient(i.protocol.routes, { baseUrl: i.uri ?? uri });
    }
  }
  return out;
};

const stateKey = (componentName: string, instanceId: string | undefined): string =>
  instanceId === undefined ? componentName : `${componentName}:${instanceId}`;

/**
 * Auto-extract `host` and `port` from `uri` when the Blueprint factory
 * omitted them. The user writes `iface({ uri: "http://127.0.0.1:8080", protocol })`
 * and gets host="127.0.0.1", port=8080 for free.
 *
 * Honours user-supplied values: if `host` or `port` are explicitly set on
 * the interface, they are kept as-is.
 */
const enrichInterface = (record: InterfaceRecord): InterfaceRecord => {
  const out: Record<string, InterfaceRecord[string]> = {};
  for (const [k, i] of Object.entries(record)) {
    if (i.host !== undefined && i.port !== undefined) {
      out[k] = i;
      continue;
    }
    let host: string | undefined = i.host;
    let port: number | undefined = i.port;
    try {
      const url = new URL(i.uri);
      host = host ?? (url.hostname || undefined);
      port = port ?? (url.port ? Number(url.port) : undefined);
    } catch {
      // non-URL schemes (e.g. raw TCP "tcp://host:port") — best-effort parse
      const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\[?([^\]\s/]+?)\]?:(\d+)/.exec(i.uri);
      if (m) {
        host = host ?? m[1];
        port = port ?? Number(m[2]);
      }
    }
    out[k] = { ...i, host, port };
  }
  return out;
};

const buildIface = (binding: AnyBinding, ports: Record<string, number>): InterfaceRecord => {
  if (!binding.blueprint.interface) return {};
  const raw = binding.blueprint.interface(binding.config, binding.env, ports);
  return enrichInterface(raw);
};

const buildApi = (binding: AnyBinding, ifaceRecord: InterfaceRecord): unknown => {
  if (binding.blueprint.api) return binding.blueprint.api(ifaceRecord, createHelpers());
  const firstIface = Object.values(ifaceRecord)[0];
  return deriveAutoApi(ifaceRecord, firstIface?.uri ?? "");
};

const buildComponentRuntime = (
  adapter: Adapter,
  componentName: string,
  instanceId: string | undefined,
  binding: AnyBinding,
  containerId: string,
  ports: Record<string, number>,
  owned: boolean,
): ComponentState => {
  const ifaceRecord: InterfaceRecord = buildIface(binding, ports);
  const catalog = (binding.blueprint.events ?? {}) as EventCatalog;
  const eventBus = createEventBus(catalog);
  const signal = new AbortController();
  const running: Running<unknown> = {
    ports,
    interface: ifaceRecord,
    api: undefined,
    events: eventBus.bus,
  } as unknown as Running<unknown>;
  const state: ComponentState = {
    componentName, instanceId, binding,
    containerId, ports, interface: ifaceRecord,
    api: undefined, eventBus, signal, running,
    status: "starting",
    owned,
  };
  void (async () => {
    try {
      for await (const line of adapter.logs(containerId, signal.signal)) {
        const parsed = binding.logParser?.(line);
        if (parsed) eventBus.ingest(parsed, { component: componentName });
      }
    } catch (e) {
      console.error(`[orchestrator] log task failed for ${componentName}:`, e);
    }
  })();
  return state;
};

const finalizeApi = (state: ComponentState): void => {
  state.api = buildApi(state.binding, state.interface);
  (state.running as unknown as Record<string, unknown>).api = state.api;
  state.status = "running";
};

export const startEnvironment = async <E extends Environment>(
  env: E,
  opts: OrchestratorOptions,
): Promise<Runtime<E>> => {
  const emitter = createEmitter(opts.observer);
  const rootEmit = emitter.scope({ adapter: opts.adapter.name, envKey: opts.envKey });
  const envStart = Date.now();
  rootEmit({ type: "environment.starting", componentCount: countBindings(env) });

  const connectStart = Date.now();
  rootEmit({ type: "substrate.connecting" });
  try {
    await opts.adapter.connect();
  } catch (e) {
    rootEmit({ type: "substrate.connect_failed", error: e });
    rootEmit({ type: "environment.failed", phase: "connect", error: e });
    throw e;
  }
  rootEmit({ type: "substrate.connected", latencyMs: Date.now() - connectStart });

  const components = new Map<string, ComponentState>();
  const total = countBindings(env);
  let done = 0;

  const buildSpec = (componentName: string, instanceId: string | undefined, binding: AnyBinding): StartSpec => ({
    image: binding.image,
    version: binding.version,
    env: binding.env ?? {},
    ports: binding.ports ?? {},
    mounts: binding.mounts ?? {},
    labels: {
      ...(binding.labels ?? {}),
      cyanotype: "1",
      "cyanotype.session": opts.sessionId,
      "cyanotype.env": opts.envKey,
      "cyanotype.component": componentName,
      ...(instanceId !== undefined ? { "cyanotype.instance": instanceId } : {}),
    },
    ...(instanceId !== undefined ? { instance: instanceId } : {}),
    ...(binding.adapter !== undefined ? { adapterConfig: binding.adapter } : {}),
  });

  const startOne = async (
    componentName: string,
    instanceId: string | undefined,
    binding: AnyBinding,
  ): Promise<ComponentState> => {
    const compEmit = emitter.scope({
      adapter: opts.adapter.name, envKey: opts.envKey,
      component: componentName, instance: instanceId,
    });
    const compStart = Date.now();
    const spec = buildSpec(componentName, instanceId, binding);
    const { containerId, ports, owned } = await opts.adapter.start(spec, compEmit);
    const state = buildComponentRuntime(opts.adapter, componentName, instanceId, binding, containerId, ports, owned);
    if (binding.blueprint.readiness) {
      await runProbe(binding.blueprint.readiness, state.interface, undefined, compEmit);
    }
    finalizeApi(state);
    components.set(stateKey(componentName, instanceId), state);
    compEmit({
      type: "environment.component_ready",
      done: (done += 1), total, durationMs: Date.now() - compStart,
    });
    return state;
  };

  try {
    for (const [name, slot] of Object.entries(env)) {
      if (isSingleBinding(slot)) {
        await startOne(name, undefined, slot);
      } else {
        const entries = Object.entries(slot as Record<string, AnyBinding>);
        await Promise.all(entries.map(([instanceId, binding]) => startOne(name, instanceId, binding)));
      }
    }
  } catch (e) {
    rootEmit({ type: "environment.failed", phase: "start", error: e });
    throw e;
  }
  rootEmit({ type: "environment.ready", durationMs: Date.now() - envStart });

  const resolveState = (name: string, instance?: string): ComponentState => {
    const key = stateKey(name, instance);
    const s = components.get(key);
    if (!s) throw { kind: "component_not_found", name, instance };
    return s;
  };

  const chaosScope = (name: string, instance?: string) =>
    emitter.scope({ adapter: opts.adapter.name, envKey: opts.envKey, component: name, instance });

  const chaosStop = async (name: string, instance?: string): Promise<void> => {
    const s = resolveState(name, instance);
    if (s.status === "stopped") return;
    const chaosEmit = chaosScope(name, instance);
    chaosEmit({ type: "chaos.stopping" });
    s.signal.abort();
    const id = s.containerId;
    chaosEmit({ type: "container.stopping", containerId: id });
    try { await opts.adapter.stop(id); } catch (e) { console.error(e); }
    chaosEmit({ type: "container.stopped", containerId: id });
    s.containerId = "";
    s.status = "stopped";

    // Poll exists() in case the adapter's stop is not synchronous on removal.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if (!(await opts.adapter.exists(id))) {
          chaosEmit({ type: "chaos.stopped" });
          return;
        }
      } catch { /* transient — keep polling */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw { kind: "chaos_stop_unverified", name, instance, containerId: id };
  };

  const chaosStart = async (name: string, instance?: string): Promise<void> => {
    const s = resolveState(name, instance);
    if (s.status !== "stopped") throw { kind: "invalid_chaos", reason: "not_stopped" };
    const chaosEmit = chaosScope(name, instance);
    chaosEmit({ type: "chaos.starting" });
    const spec = buildSpec(s.componentName, s.instanceId, s.binding);
    const { containerId, ports } = await opts.adapter.start(spec, chaosEmit);
    s.containerId = containerId;
    s.ports = ports;
    s.interface = buildIface(s.binding, ports);
    s.eventBus.clear();
    s.signal = new AbortController();
    void (async () => {
      try {
        for await (const line of opts.adapter.logs(s.containerId, s.signal.signal)) {
          const parsed = s.binding.logParser?.(line);
          if (parsed) s.eventBus.ingest(parsed, { component: s.componentName });
        }
      } catch (e) {
        console.error(`[orchestrator] log task failed for ${s.componentName}:`, e);
      }
    })();
    if (s.binding.blueprint.readiness) {
      await runProbe(s.binding.blueprint.readiness, s.interface, undefined, chaosEmit);
    }
    s.api = buildApi(s.binding, s.interface);
    const live = s.running as unknown as Record<string, unknown>;
    live.ports = ports;
    live.interface = s.interface;
    live.api = s.api;
    s.status = "running";
    chaosEmit({ type: "chaos.started" });
  };

  const chaosRestart = async (name: string, instance?: string): Promise<void> => {
    await chaosStop(name, instance);
    await chaosStart(name, instance);
  };

  return finalizeRuntime(env, components, opts, emitter, chaosStop, chaosStart, chaosRestart);
};

export const attachEnvironment = async <E extends Environment>(
  env: E,
  opts: OrchestratorOptions,
  snapshot: AttachSnapshot,
): Promise<Runtime<E>> => {
  const emitter = createEmitter(opts.observer);
  const rootEmit = emitter.scope({ adapter: opts.adapter.name, envKey: opts.envKey });
  const envStart = Date.now();
  rootEmit({ type: "environment.starting", componentCount: countBindings(env) });

  const connectStart = Date.now();
  rootEmit({ type: "substrate.connecting" });
  try {
    await opts.adapter.connect();
  } catch (e) {
    rootEmit({ type: "substrate.connect_failed", error: e });
    rootEmit({ type: "environment.failed", phase: "connect", error: e });
    throw e;
  }
  rootEmit({ type: "substrate.connected", latencyMs: Date.now() - connectStart });
  const components = new Map<string, ComponentState>();

  const attachOne = async (
    componentName: string,
    instanceId: string | undefined,
    binding: AnyBinding,
    snap: ComponentSnapshot,
  ): Promise<void> => {
    if (!(await opts.adapter.exists(snap.containerId))) {
      throw { kind: "container_gone", containerId: snap.containerId, componentName, instanceId };
    }
    // Attach mode never owns the container: the process that started it
    // (or the operator, for compose / pre-running pods) holds the lifecycle.
    // `runtime.stop()` here detaches without removing.
    const state = buildComponentRuntime(
      opts.adapter, componentName, instanceId, binding, snap.containerId, { ...snap.ports }, false,
    );
    finalizeApi(state);
    components.set(stateKey(componentName, instanceId), state);
  };

  try {
    for (const [componentName, slotSnap] of Object.entries(snapshot.components)) {
      const slot = env[componentName];
      if (slot === undefined) throw { kind: "snapshot_unknown_component", componentName };
      if (slotSnap.kind === "single") {
        if (!isSingleBinding(slot)) throw { kind: "snapshot_shape_mismatch", componentName };
        await attachOne(componentName, undefined, slot, slotSnap.snapshot);
      } else {
        if (isSingleBinding(slot)) throw { kind: "snapshot_shape_mismatch", componentName };
        const map = slot as Record<string, AnyBinding>;
        for (const [instanceId, compSnap] of Object.entries(slotSnap.instances)) {
          const binding = map[instanceId];
          if (!binding) throw { kind: "snapshot_unknown_instance", componentName, instanceId };
          await attachOne(componentName, instanceId, binding, compSnap);
        }
      }
    }
  } catch (e) {
    rootEmit({ type: "environment.failed", phase: "attach", error: e });
    throw e;
  }
  rootEmit({ type: "environment.ready", durationMs: Date.now() - envStart });

  const notSupported = async (): Promise<void> => {
    throw { kind: "chaos_not_supported_in_attach" };
  };
  return finalizeRuntime(env, components, opts, emitter, notSupported, notSupported, notSupported);
};

const finalizeRuntime = <E extends Environment>(
  env: E,
  components: Map<string, ComponentState>,
  opts: OrchestratorOptions,
  emitter: Emitter,
  chaosStop: (name: string, instance?: string) => Promise<void>,
  chaosStart: (name: string, instance?: string) => Promise<void>,
  chaosRestart: (name: string, instance?: string) => Promise<void>,
): Runtime<E> => {
  const snapshot = (): RuntimeSnapshot => Object.freeze({
    status: "running" as const,
    components: Object.freeze(
      [...components.values()].map((c) => Object.freeze({
        name: c.componentName,
        instance: c.instanceId ?? c.componentName,
        containerId: c.containerId || undefined,
        running: c.status === "running",
        ports: Object.freeze({ ...c.ports }),
      })),
    ),
  });

  const metadata = (): EnvironmentMetadata => {
    const out: Record<string, SlotSnapshot> = {};
    const multiBuckets = new Map<string, Record<string, ComponentSnapshot>>();
    for (const c of components.values()) {
      const snap: ComponentSnapshot = {
        containerId: c.containerId,
        ports: { ...c.ports },
        ...(c.binding.version !== undefined ? { version: c.binding.version } : {}),
        // Emit `owned` ONLY when false. Owned components omit the field so
        // older readers (which treat absent as fully owned) stay correct,
        // and so existing metadata files remain byte-stable.
        ...(c.owned === false ? { owned: false } : {}),
      };
      if (c.instanceId === undefined) {
        out[c.componentName] = { kind: "single", snapshot: snap };
      } else {
        let bucket = multiBuckets.get(c.componentName);
        if (!bucket) { bucket = {}; multiBuckets.set(c.componentName, bucket); }
        bucket[c.instanceId] = snap;
      }
    }
    for (const [name, instances] of multiBuckets) {
      out[name] = { kind: "multi", instances };
    }
    return {
      schemaVersion: 1,
      envKey: opts.envKey,
      savedAt: new Date().toISOString(),
      components: out,
    };
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const c of components.values()) {
      if (c.status === "stopped") continue;
      c.signal.abort();
      if (c.owned && c.containerId) {
        const stopEmit = emitter.scope({
          adapter: opts.adapter.name, envKey: opts.envKey,
          component: c.componentName, instance: c.instanceId,
        });
        stopEmit({ type: "container.stopping", containerId: c.containerId });
        try { await opts.adapter.stop(c.containerId); } catch (e) { console.error(e); }
        stopEmit({ type: "container.stopped", containerId: c.containerId });
      }
      c.status = "stopped";
    }
    await opts.adapter.disconnect();
  };

  const runtime: Record<string, unknown> = {};
  for (const [name, slot] of Object.entries(env)) {
    if (isSingleBinding(slot)) {
      const s = components.get(stateKey(name, undefined));
      if (s) runtime[name] = s.running;
    } else {
      const inner: Record<string, unknown> = {};
      for (const instanceId of Object.keys(slot as Record<string, AnyBinding>)) {
        const s = components.get(stateKey(name, instanceId));
        if (s) inner[instanceId] = s.running;
      }
      runtime[name] = inner;
    }
  }
  runtime.chaos = { stop: chaosStop, start: chaosStart, restart: chaosRestart };
  runtime.snapshot = snapshot;
  runtime.metadata = metadata;
  runtime.stop = stop;

  return runtime as Runtime<E>;
};
