/**
 * Adapter — the runtime SPI.
 *
 * The IO boundary, and the only IO boundary. Docker, Kubernetes, podman,
 * in-memory all implement this. Seven required methods: three lifecycle
 * (`connect`, `disconnect`, `teardown`) and four per-container (`start`,
 * `stop`, `logs`, `exists`) — plus one optional, `reconnect`, for adapters
 * whose reported ports do not outlive the process that opened them (D-046).
 *
 * Substrate seam: the Adapter is the single point in the system where
 * real-vs-fake (and Docker-vs-Kubernetes-vs-in-memory) is decided. Bindings
 * declare what to run via `image: string`; adapters interpret that string
 * against the substrate they own. The Docker adapter pulls and runs in deploy
 * mode; in attach mode it discovers and observes an already-running
 * docker-compose project without creating or removing anything. The
 * in-memory adapter resolves the image against its factory registry.
 * Test code, Blueprints, and Bindings stay substrate-agnostic by
 * construction.
 *
 * `teardown` does label-based discovery of stragglers from previous crashed
 * runs (label = `cyanotype=1`). The orchestrator calls it once at suite-level
 * teardown.
 *
 * Concerns the adapter does NOT own (they live in the orchestrator):
 *   - port allocation (the adapter receives "auto" / a fixed port; it just
 *     reports back what was actually bound)
 *   - mount file writing (the adapter receives content strings; it writes
 *     tmpfiles and bind-mounts internally)
 *   - cross-process metadata
 *   - probes (declared on the Blueprint)
 *   - log parsing into typed events (the Binding's `logParser` is run by
 *     the orchestrator; the Adapter only emits raw lines via `logs()`)
 *
 * `start` takes an optional `emit` — the framework-lifecycle observer stream
 * (`observer.ts`). It is the channel for substrate-internal telemetry that
 * only the adapter can see: image pull progress, container create/start
 * sub-steps. Absent `emit` = no observability, zero cost.
 */

import type { Emit } from "./observer.js";

export type Adapter = {
  readonly name: string;

  /** Set up session state (verify daemon, allocate connection pool). No-op for stateless adapters. */
  connect(): Promise<void>;

  /** Release session resources (close pools, etc.). */
  disconnect(): Promise<void>;

  /**
   * Find labeled stragglers from previous crashed runs and remove them.
   * Called by the orchestrator at suite-level global teardown.
   */
  teardown(): Promise<void>;

  /**
   * Start one container. Returns the assigned container ID and resolved port
   * map. `emit`, when supplied, receives substrate-internal lifecycle events
   * (image pull progress, container provisioning sub-steps).
   */
  start(spec: StartSpec, emit?: Emit): Promise<Started>;

  /** Stop and remove one container. Idempotent: should not throw if already gone. */
  stop(containerId: string): Promise<void>;

  /**
   * Follow **live** stdout/stderr (multiplexed) as an async iterable of lines.
   * Does not replay container history — only lines produced after the stream
   * opens (Docker `tail: 0`, kubectl `--tail=0`). Honours `signal`; the
   * adapter cleans up the underlying stream when the signal aborts OR the
   * consumer breaks out of iteration.
   */
  logs(containerId: string, signal?: AbortSignal): AsyncIterable<string>;

  /** Whether a container with this id currently exists (running or stopped). */
  exists(containerId: string): Promise<boolean>;

  /**
   * OPTIONAL, and the only optional method (D-046). Re-establish THIS process's
   * connection to a container another process started, returning ports valid
   * here.
   *
   * `Started.ports` is not always durable. Where it is a real host binding
   * (Docker, Compose) it outlives the process that opened it, so a second
   * process attaching from persisted metadata can use the recorded numbers. The
   * Kubernetes deploy adapter instead reports `kubectl port-forward` locals,
   * which die with their parent — so the recorded numbers are closed ports, and
   * an attaching process would burn its whole readiness budget against them.
   *
   * PRESENCE MEANS CAPABILITY, NOT DURABILITY. Implementing this says "I can
   * re-establish ports for another process". Omitting it says only that this
   * adapter cannot — which is true both for adapters whose ports are already
   * durable and for adapters that simply have no way to re-open them. The
   * distinction is not currently representable; see D-046.
   *
   * The returned `containerId` may differ from the one supplied. Today no
   * adapter changes it, but the shape is deliberate: resolving a component to
   * its CURRENT container (after a chaos restart replaced it) is the natural
   * extension, and it should not require another SPI change.
   *
   * There is no `owned` in the return. A process that reconnects created
   * nothing and must never claim ownership — `teardown()` acts on what an
   * adapter claims it created, so a claim here would delete another process's
   * workloads. Leaving the field out makes that unrepresentable rather than
   * merely forbidden.
   */
  reconnect?(spec: ReconnectSpec): Promise<Reconnected>;
};

/**
 * What `reconnect` is given. Every field is something the caller genuinely
 * holds at attach time — deliberately not a synthesised `StartSpec`, whose
 * `env` and `mounts` would have to be invented and would then be read as fact.
 */
export type ReconnectSpec = {
  /** The container id the metadata recorded. */
  readonly containerId: string;
  /**
   * `cyanotype.env` — the environment key, stamped as a label and stable
   * ACROSS processes. `cyanotype.session` is not: it identifies the adapter
   * instance that created the container, so a later process never matches it.
   */
  readonly envKey: string;
  readonly component: string;
  readonly instance?: string;
  /** The port names to re-establish — the keys of the Binding's `ports`. */
  readonly ports: readonly string[];
  /** The Binding's adapter-specific config, for adapters that need it to resolve. */
  readonly adapterConfig?: AdapterConfig;
};

export type Reconnected = {
  /** The container these ports reach. May differ from the id supplied. */
  readonly containerId: string;
  /** Container port name → host port valid in THIS process. */
  readonly ports: Record<string, number>;
};

/**
 * Open interface for adapter-specific Binding configuration. Adapters
 * augment this via `declare module "../adapter.js" { interface AdapterConfig { ... } }`
 * to slot in their own typed sub-key (e.g. `k8s`). Type-safe and
 * adapter-extensible without forcing a generic onto `Binding`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: open interface for declaration merging
export interface AdapterConfig {}

export type StartSpec = {
  readonly image: string;
  /**
   * The `Binding.version` string. Carried through so attach-mode adapters
   * can compare the expected image identity against a discovered container.
   * Optional: the orchestrator always sets it from the Binding, but a
   * hand-built `StartSpec` (e.g. in adapter unit tests) may omit it.
   */
  readonly version?: string;
  readonly env: Record<string, string>;
  /** Container port name → host port binding ("auto" or a specific number). */
  readonly ports: Record<string, "auto" | number>;
  /** Container path → file content. Adapter materialises tmpfiles + bind mounts. */
  readonly mounts: Record<string, string>;
  /**
   * Labels for teardown discovery. The orchestrator always sets `cyanotype=1`
   * and `cyanotype.session`. Adapters can add their own keys.
   */
  readonly labels: Record<string, string>;
  /**
   * Multi-instance identity, when this Binding is one of several instances
   * of the same component (e.g. `redis.primary` vs `redis.replica`). The
   * orchestrator surfaces this as a first-class typed field so factories
   * read `spec.instance` directly instead of `spec.labels["cyanotype.instance"]`.
   * Adapters still mirror it into labels for teardown discovery.
   */
  readonly instance?: string;
  /** Adapter-specific per-Binding config; merged interface — see `AdapterConfig`. */
  readonly adapterConfig?: AdapterConfig;
};

export type Started = {
  readonly containerId: string;
  /** Container port name → resolved host port number. */
  readonly ports: Record<string, number>;
  /**
   * Whether the orchestrator owns this container's lifecycle. `true` for
   * substrates the orchestrator provisions itself (Docker deploy mode, the
   * in-memory adapter, fresh Kubernetes pods). `false` when the adapter
   * adopted a pre-existing container the operator owns (Docker attach to a
   * docker-compose project, Kubernetes attach to a pre-running namespace).
   * Drives both `runtime.stop()` (per-component) and `stopAllInMeta`
   * (cross-process invalidation): non-owned containers are detached, not
   * removed.
   */
  readonly owned: boolean;
};
