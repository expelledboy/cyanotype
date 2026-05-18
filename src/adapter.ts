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
 * against the substrate they own. The Docker adapter pulls and runs; the
 * in-memory adapter resolves the image against its factory registry.
 * Test code, Blueprints, and Bindings stay substrate-agnostic by
 * construction.
 *
 * `teardown` does label-based discovery of stragglers from previous crashed
 * runs (label = `speculum=1`). The orchestrator calls it once at suite-level
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
 */

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

  /** Start one container. Returns the assigned container ID and resolved port map. */
  start(spec: StartSpec): Promise<Started>;

  /** Stop and remove one container. Idempotent: should not throw if already gone. */
  stop(containerId: string): Promise<void>;

  /**
   * Follow stdout (and stderr, multiplexed) as an async iterable of lines.
   * Honours `signal`; the adapter cleans up the underlying process when
   * the signal aborts OR the consumer breaks out of iteration.
   */
  logs(containerId: string, signal?: AbortSignal): AsyncIterable<string>;

  /** Whether a container with this id currently exists (running or stopped). */
  exists(containerId: string): Promise<boolean>;
};

export type StartSpec = {
  readonly image: string;
  readonly env: Record<string, string>;
  /** Container port name → host port binding ("auto" or a specific number). */
  readonly ports: Record<string, "auto" | number>;
  /** Container path → file content. Adapter materialises tmpfiles + bind mounts. */
  readonly mounts: Record<string, string>;
  /**
   * Labels for teardown discovery. The orchestrator always sets `speculum=1`
   * and `speculum.session`. Adapters can add their own keys.
   */
  readonly labels: Record<string, string>;
  /**
   * Multi-instance identity, when this Binding is one of several instances
   * of the same component (e.g. `redis.primary` vs `redis.replica`). The
   * orchestrator surfaces this as a first-class typed field so factories
   * read `spec.instance` directly instead of `spec.labels["speculum.instance"]`.
   * Adapters still mirror it into labels for teardown discovery.
   */
  readonly instance?: string;
};

export type Started = {
  readonly containerId: string;
  /** Container port name → resolved host port number. */
  readonly ports: Record<string, number>;
};
