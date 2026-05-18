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

import type { Adapter, StartSpec } from "./adapter";
import type { Environment } from "./environment";
import type { Runtime, RuntimeSnapshot, Running } from "./runtime";
import type { Binding } from "./binding";
import type { InterfaceRecord } from "./interface";
import type { EventBusInternals, EventCatalog } from "./events";
import { createEventBus } from "./events";
import { createHelpers } from "./helpers";
import { createHttpClient } from "./protocol";
import { runProbe } from "./probe";
import type { EnvironmentMetadata, SlotSnapshot, ComponentSnapshot } from "./metadata";

export type OrchestratorOptions = {
  readonly adapter: Adapter;
  readonly sessionId: string;
  readonly envKey: string;
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
  await opts.adapter.connect();
  const components = new Map<string, ComponentState>();

  const buildSpec = (componentName: string, instanceId: string | undefined, binding: AnyBinding): StartSpec => ({
    image: binding.image,
    env: binding.env ?? {},
    ports: binding.ports ?? {},
    mounts: binding.mounts ?? {},
    labels: {
      ...(binding.labels ?? {}),
      speculum: "1",
      "speculum.session": opts.sessionId,
      "speculum.env": opts.envKey,
      "speculum.component": componentName,
      ...(instanceId !== undefined ? { "speculum.instance": instanceId } : {}),
    },
    ...(instanceId !== undefined ? { instance: instanceId } : {}),
  });

  const startOne = async (
    componentName: string,
    instanceId: string | undefined,
    binding: AnyBinding,
  ): Promise<ComponentState> => {
    const spec = buildSpec(componentName, instanceId, binding);
    const { containerId, ports } = await opts.adapter.start(spec);
    const state = buildComponentRuntime(opts.adapter, componentName, instanceId, binding, containerId, ports);
    if (binding.blueprint.readiness) await runProbe(binding.blueprint.readiness, state.interface);
    finalizeApi(state);
    components.set(stateKey(componentName, instanceId), state);
    return state;
  };

  for (const [name, slot] of Object.entries(env)) {
    if (isSingleBinding(slot)) {
      await startOne(name, undefined, slot);
    } else {
      const entries = Object.entries(slot as Record<string, AnyBinding>);
      await Promise.all(entries.map(([instanceId, binding]) => startOne(name, instanceId, binding)));
    }
  }

  const resolveState = (name: string, instance?: string): ComponentState => {
    const key = stateKey(name, instance);
    const s = components.get(key);
    if (!s) throw { kind: "component_not_found", name, instance };
    return s;
  };

  const chaosStop = async (name: string, instance?: string): Promise<void> => {
    const s = resolveState(name, instance);
    if (s.status === "stopped") return;
    s.signal.abort();
    const id = s.containerId;
    try { await opts.adapter.stop(id); } catch (e) { console.error(e); }
    s.containerId = "";
    s.status = "stopped";

    // Poll exists() in case the adapter's stop is not synchronous on removal.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if (!(await opts.adapter.exists(id))) return;
      } catch { /* transient — keep polling */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw { kind: "chaos_stop_unverified", name, instance, containerId: id };
  };

  const chaosStart = async (name: string, instance?: string): Promise<void> => {
    const s = resolveState(name, instance);
    if (s.status !== "stopped") throw { kind: "invalid_chaos", reason: "not_stopped" };
    const spec = buildSpec(s.componentName, s.instanceId, s.binding);
    const { containerId, ports } = await opts.adapter.start(spec);
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
    if (s.binding.blueprint.readiness) await runProbe(s.binding.blueprint.readiness, s.interface);
    s.api = buildApi(s.binding, s.interface);
    const live = s.running as unknown as Record<string, unknown>;
    live.ports = ports;
    live.interface = s.interface;
    live.api = s.api;
    s.status = "running";
  };

  const chaosRestart = async (name: string, instance?: string): Promise<void> => {
    await chaosStop(name, instance);
    await chaosStart(name, instance);
  };

  return finalizeRuntime(env, components, opts, chaosStop, chaosStart, chaosRestart, false);
};

export const attachEnvironment = async <E extends Environment>(
  env: E,
  opts: OrchestratorOptions,
  snapshot: AttachSnapshot,
): Promise<Runtime<E>> => {
  await opts.adapter.connect();
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
    const state = buildComponentRuntime(
      opts.adapter, componentName, instanceId, binding, snap.containerId, { ...snap.ports },
    );
    finalizeApi(state);
    components.set(stateKey(componentName, instanceId), state);
  };

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

  const notSupported = async (): Promise<void> => {
    throw { kind: "chaos_not_supported_in_attach" };
  };
  return finalizeRuntime(env, components, opts, notSupported, notSupported, notSupported, true);
};

const finalizeRuntime = <E extends Environment>(
  env: E,
  components: Map<string, ComponentState>,
  opts: OrchestratorOptions,
  chaosStop: (name: string, instance?: string) => Promise<void>,
  chaosStart: (name: string, instance?: string) => Promise<void>,
  chaosRestart: (name: string, instance?: string) => Promise<void>,
  detachOnly: boolean,
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
      const snap: ComponentSnapshot = { containerId: c.containerId, ports: { ...c.ports } };
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
      if (!detachOnly) {
        try { if (c.containerId) await opts.adapter.stop(c.containerId); } catch (e) { console.error(e); }
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
