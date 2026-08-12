/**
 * Adapter — the runtime SPI.
 *
 * The IO boundary, and the only IO boundary. Docker, Kubernetes, podman,
 * in-memory all implement this. Seven methods: three lifecycle (`connect`,
 * `disconnect`, `teardown`) and four per-container (`start`, `stop`,
 * `logs`, `exists`).
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
