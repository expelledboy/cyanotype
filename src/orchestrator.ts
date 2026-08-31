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
import { invariant } from "./invariants.js";
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
  /**
   * Ceiling on the TOTAL time `attachEnvironment` spends on readiness probes,
   * across all components.
   *
   * Attach probes components one at a time, so without this the worst case is
   * the sum of every Blueprint's own probe timeout — six components at the 30s
   * default is three minutes before a dead stack is reported. Omitted (the
   * default) means no aggregate ceiling: each Blueprint's `timeoutMs` is
   * honoured in full, which is the right call when those values were chosen
   * deliberately and the wrong one on a shared CI runner.
   */
  readonly attachReadinessTimeoutMs?: number;
  /**
   * How component slots are brought up.
   *
   * `"sequential"` (default) starts one slot at a time in declaration order, so
   * total startup is the SUM of every slot's readiness time. `"concurrent"`
   * starts them all at once, making it the length of the longest dependency
   * chain instead — readiness probes poll, so a component whose dependency is
   * still coming up simply retries until it is there.
   *
   * Sequential remains the default because the ordering it provides, while
   * incidental — it is object key order, not a declared dependency graph — is
   * what existing environments have been running against. Opt in when your
   * components tolerate starting before their dependencies, which is the normal
   * case for anything that retries its connections.
   */
  readonly startup?: "sequential" | "concurrent";
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

/** Source attribution stamped onto every ingested event. Omits `instance` for single-instance slots. */
/**
 * I8: an event's `instance` must be present exactly when the component has one.
 * `EventFilter.instance` was a public filter that could never match in a real
 * environment because this stamp was dropped — the failure was a wait that
 * timed out with no indication why.
 */
const eventMeta = (componentName: string, instanceId: string | undefined) =>
  instanceId === undefined
    ? { component: componentName }
    : { component: componentName, instance: instanceId };

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
        if (parsed) eventBus.ingest(parsed, eventMeta(componentName, instanceId));
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
    done += 1;
    compEmit({
      type: "environment.component_ready",
      done, total, durationMs: Date.now() - compStart,
    });
    return state;
  };

  try {
    const startSlot = async ([name, slot]: [string, unknown]): Promise<void> => {
      if (isSingleBinding(slot)) {
        await startOne(name, undefined, slot);
        return;
      }
      const entries = Object.entries(slot as Record<string, AnyBinding>);
      await Promise.all(entries.map(([instanceId, binding]) => startOne(name, instanceId, binding)));
    };

    const slots = Object.entries(env);
    if (opts.startup === "concurrent") {
      // allSettled, not all: a rejection from `all` would leave the other slots
      // starting in the background with nobody holding their handles, which is
      // how a failed start leaks containers.
      const results = await Promise.allSettled(slots.map(startSlot));
      const failed = results.find((r) => r.status === "rejected");
      if (failed && failed.status === "rejected") throw failed.reason;
    } else {
      for (const entry of slots) await startSlot(entry);
    }
  } catch (e) {
    rootEmit({ type: "environment.failed", phase: "start", error: e });
    throw e;
  }
  rootEmit({ type: "environment.ready", durationMs: Date.now() - envStart });

  const resolveState = (name: string, instance?: string): ComponentState => {
    const key = stateKey(name, instance);
    const s = components.get(key);
    if (!s) {
      // Report the addressable form, NOT `components.keys()`. Those are internal
      // map keys joined with a colon (`redis:primary`), while every user-facing
      // key in the library — composite route keys, derive binding keys — is
      // dot-joined (`redis.primary`). Printing the colon form invited copying it
      // into `createCompositeAdapter({ routes })`, where it matches nothing and
      // silently falls through to the default substrate instead of erroring.
      const addressable = Array.from(components.values()).map((c) =>
        c.instanceId === undefined ? c.componentName : `${c.componentName}.${c.instanceId}`);
      throw {
        kind: "component_not_found",
        name,
        instance,
        known: addressable,
        hint:
          `No component "${instance === undefined ? name : `${name}.${instance}`}" in this ` +
          `environment. Known: ${addressable.join(", ")}. For a multi-instance component the ` +
          `instance is required (chaos.stop("redis", "primary")); for a single-instance one it ` +
          `must be omitted. ChaosArgs normally makes that a compile error, so reaching this at ` +
          `runtime usually means a dynamic or cast call site. These names are also the form ` +
          `composite route keys and derive binding keys take.`,
      };
    }
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
    // Do NOT swallow. D-034 replaced the Docker adapter's silent no-op with a
    // thrown `chaos_unsupported_in_attach_mode` precisely to make "chaos call
    // without allowChaos" a test-author error "surfaced loudly"; logging it to
    // console.error buried it, and 5s later `chaos_stop_unverified` blamed the
    // substrate for a stop the adapter had openly refused.
    //
    // The SPI documents stop() as idempotent — it must not throw if the
    // container is already gone (adapter.ts) — so a throw is a real failure.
    // Status therefore stays as it was: the component was not stopped, and
    // marking it "stopped" anyway is what let a later chaos.start() look like
    // it had resumed something.
    await opts.adapter.stop(id);
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
    throw {
      kind: "chaos_stop_unverified",
      name, instance, containerId: id,
      hint:
        `The adapter's stop() returned without error, but for 5s afterwards exists() never ` +
        `reported the container gone — it kept finding it, or kept erroring, and the poll ` +
        `cannot tell those apart. chaos.stop() therefore cannot promise the component is ` +
        `down, and asserting on a failure mode that may not have been injected would be ` +
        `worse than failing here. A stop the adapter refuses now propagates instead of ` +
        `reaching this, so reaching it means the substrate accepted the stop and the ` +
        `container outlived it — check the daemon or cluster.`,
    };
  };

  const chaosStart = async (name: string, instance?: string): Promise<void> => {
    const s = resolveState(name, instance);
    if (s.status !== "stopped") {
      throw {
        kind: "invalid_chaos",
        reason: "not_stopped",
        component: s.componentName,
        instance: s.instanceId,
        status: s.status,
        hint:
          `chaos.start() resumes a component that chaos.stop() stopped, but this one is ` +
          `"${s.status}". Use chaos.restart() to cycle a running component, or await the ` +
          `chaos.stop() first. A stop marks the component stopped even when the substrate ` +
          `errors, so reaching this means none ran, or its promise was never awaited.`,
      };
    }
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
          if (parsed) s.eventBus.ingest(parsed, eventMeta(s.componentName, s.instanceId));
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

  // Aggregate ceiling across every component's probe — see
  // `OrchestratorOptions.attachReadinessTimeoutMs`. One controller for the
  // whole attach; each probe honours it via the signal it already accepts.
  // Started AFTER connect: the budget is for probing, and the `finally` that
  // clears it is only reachable once the connect path has succeeded.
  const readinessDeadline = new AbortController();
  const readinessTimer =
    opts.attachReadinessTimeoutMs !== undefined
      ? setTimeout(() => readinessDeadline.abort(), opts.attachReadinessTimeoutMs)
      : undefined;

  const attachOne = async (
    componentName: string,
    instanceId: string | undefined,
    binding: AnyBinding,
    snap: ComponentSnapshot,
  ): Promise<void> => {
    if (!(await opts.adapter.exists(snap.containerId))) {
      throw {
        kind: "container_gone",
        containerId: snap.containerId, componentName, instanceId,
        hint:
          `The persisted environment lists a container for ` +
          `"${instanceId === undefined ? componentName : `${componentName}.${instanceId}`}" ` +
          `that no longer exists — removed outside Cyanotype, or replaced by a chaos restart ` +
          `in another process whose new id this state file never saw. Stop the containers ` +
          `labelled cyanotype=1, delete the <envKey>.json under your stateDir, and re-run.`,
      };
    }
    // Attach mode never owns the container: the process that started it
    // (or the operator, for compose / pre-running pods) holds the lifecycle.
    // `runtime.stop()` here detaches without removing.
    const state = buildComponentRuntime(
      opts.adapter, componentName, instanceId, binding, snap.containerId, { ...snap.ports }, false,
    );
    // D-034: the process that called `attachEnvironment` did not start these
    // containers, so its `runtime.stop` must not stop them. Upheld today by the
    // literal `false` above — this pins it against a future refactor that
    // threads the snapshot's `owned` through instead.
    invariant( () => state.owned === false, "attach never produces an owned component",
      () => ({ component: componentName, instance: instanceId, containerId: snap.containerId }));
    // `exists()` above proves the container is present, not that it serves.
    // Attaching to a warm stack is the case readiness was written for: the
    // component may be mid-restart, or a sibling worker may have written
    // metadata the instant its containers came up. Probe before handing the
    // caller an api.
    if (binding.blueprint.readiness) {
      const compEmit = emitter.scope({
        adapter: opts.adapter.name, envKey: opts.envKey,
        component: componentName, instance: instanceId,
      });
      try {
        await runProbe(
          binding.blueprint.readiness, state.interface, readinessDeadline.signal, compEmit,
        );
      } catch (cause) {
        // buildComponentRuntime has already detached a log-follow task; this is
        // the first attach failure that can happen after it starts, so close it
        // here or the stream outlives the failed attach.
        state.signal.abort();
        // runProbe's `probe_timeout` carries the probe and last error but no
        // component identity, and attach probes several components in a row.
        throw {
          kind: "attach_probe_failed",
          componentName, instanceId, cause,
          hint:
            `Attached to ` +
            `"${instanceId === undefined ? componentName : `${componentName}.${instanceId}`}" ` +
            `but its Blueprint readiness probe never passed, so the container is running ` +
            `without serving. Attach probes deliberately (D-036) rather than handing back a ` +
            `runtime that fails inside your first assertion. Check that component's logs; ` +
            `cause carries the probe's own failure — probe_timeout with the last error it ` +
            `saw, or probe_aborted if attachReadinessTimeoutMs capped the whole attach.`,
        };
      }
    }
    finalizeApi(state);
    components.set(stateKey(componentName, instanceId), state);
  };

  try {
    for (const [componentName, slotSnap] of Object.entries(snapshot.components)) {
      const slot = env[componentName];
      if (slot === undefined) {
        throw {
          kind: "snapshot_unknown_component",
          componentName,
          hint:
            `The persisted environment contains "${componentName}", but the Environment in ` +
            `this code does not -- the definition changed since those containers started. ` +
            `Add it back to the Environment to re-attach to those containers. Otherwise discard the environment: Cyanotype cannot re-attach across that change and does not rebuild automatically. Delete the environment's state file (the <envKey>.json under the stateDir you passed to createSharedEnvs) and stop the containers Cyanotype started -- they carry the label cyanotype=1 -- then re-run. shared.stopAll() will NOT do this: it stops what THIS process started, and those containers belong to an earlier one.`,
        };
      }
      if (slotSnap.kind === "single") {
        if (!isSingleBinding(slot)) {
          throw {
            kind: "snapshot_shape_mismatch",
            componentName,
            persisted: "single",
            current: "multi-instance",
            hint:
              `"${componentName}" was persisted as a single-instance component but is now ` +
              `multi-instance. Cyanotype cannot re-attach across that change and does not rebuild automatically. Delete the environment's state file (the <envKey>.json under the stateDir you passed to createSharedEnvs) and stop the containers Cyanotype started -- they carry the label cyanotype=1 -- then re-run. shared.stopAll() will NOT do this: it stops what THIS process started, and those containers belong to an earlier one.`,
          };
        }
        await attachOne(componentName, undefined, slot, slotSnap.snapshot);
      } else {
        if (isSingleBinding(slot)) {
          throw {
            kind: "snapshot_shape_mismatch",
            componentName,
            persisted: "multi-instance",
            current: "single",
            hint:
              `"${componentName}" was persisted as multi-instance but is now single-instance. Cyanotype cannot re-attach across that change and does not rebuild automatically. Delete the environment's state file (the <envKey>.json under the stateDir you passed to createSharedEnvs) and stop the containers Cyanotype started -- they carry the label cyanotype=1 -- then re-run. shared.stopAll() will NOT do this: it stops what THIS process started, and those containers belong to an earlier one.`,
          };
        }
        const map = slot as Record<string, AnyBinding>;
        for (const [instanceId, compSnap] of Object.entries(slotSnap.instances)) {
          const binding = map[instanceId];
          if (!binding) {
            throw {
              kind: "snapshot_unknown_instance",
              componentName,
              instanceId,
              known: Object.keys(map),
              hint:
                `The persisted environment has "${componentName}.${instanceId}", but this code ` +
                `defines only [${Object.keys(map).join(", ")}]. An instance was renamed or ` +
                `removed. Cyanotype cannot re-attach across that change and does not rebuild automatically. Delete the environment's state file (the <envKey>.json under the stateDir you passed to createSharedEnvs) and stop the containers Cyanotype started -- they carry the label cyanotype=1 -- then re-run. shared.stopAll() will NOT do this: it stops what THIS process started, and those containers belong to an earlier one.`,
            };
          }
          await attachOne(componentName, instanceId, binding, compSnap);
        }
      }
    }
  } catch (e) {
    // Attach owns no containers, so there is nothing to stop — but every
    // component attached before the failure is following logs. Close those
    // streams; the caller is never handed a runtime to stop them through.
    for (const s of components.values()) s.signal.abort();
    rootEmit({ type: "environment.failed", phase: "attach", error: e });
    throw e;
  } finally {
    clearTimeout(readinessTimer);
  }
  rootEmit({ type: "environment.ready", durationMs: Date.now() - envStart });

  const notSupported = async (): Promise<void> => {
    throw {
      kind: "chaos_not_supported_in_attach",
      hint:
        `Chaos is unavailable on a runtime built by attaching: it owns none of its containers, ` +
        `so the process or operator that started them controls their lifecycle (D-034), and ` +
        `stopping or restarting one here would disrupt everyone else attached to it. Run ` +
        `chaos from the process that started the environment, or give this process its own ` +
        `envKey so it starts, and owns, a separate set of containers.`,
    };
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
      adapter: opts.adapter.name,
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
        // I6: D-034's central promise. Chaos is the *only* path allowed to stop
        // a non-owned container, and this is not it — suite teardown reaching
        // `adapter.stop` here is what once ran `docker stop` against an
        // operator's compose stack at the end of every run.
        invariant( () => c.owned === true, "teardown stops only owned containers",
          () => ({ component: c.componentName, instance: c.instanceId, containerId: c.containerId }));
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
