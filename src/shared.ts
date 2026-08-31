/**
 * SharedEnvs — multi-environment registry with multi-worker coordination.
 *
 * `createSharedEnvs(registry, options)` returns a handle with `ensure`,
 * `attach`, `use`, and `stopAll`. Cross-process coordination uses an atomic
 * `O_CREAT|O_EXCL` file claim with a staged-state lifecycle ("starting" →
 * "running") and a 90-second staleness threshold for crashed-mid-start
 * recovery. Dead-container detection uses `Adapter.exists()` rather than
 * error-message string-matching.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adapter } from "./adapter.js";
import { invariant } from "./invariants.js";
import type { Environment } from "./environment.js";
import type { Runtime } from "./runtime.js";
import type { EnvironmentMetadata } from "./metadata.js";
import { startEnvironment, attachEnvironment, type AttachSnapshot } from "./orchestrator.js";
import type { Observer } from "./observer.js";

export type SharedMode = "start" | "attach" | "startOrAttach";

export type SharedOptions = {
  readonly adapter: Adapter;
  readonly stateDir: string;
  readonly mode?: SharedMode;
  readonly getTargetEnv?: () => string;
  /** Framework-lifecycle observer, forwarded to the orchestrator. See `observer.ts`. */
  readonly observer?: Observer;
  /**
   * Ceiling on the total time spent probing readiness when attaching, across
   * all components. Forwarded to the orchestrator; see
   * `OrchestratorOptions.attachReadinessTimeoutMs` for why the aggregate is
   * worth bounding separately from each Blueprint's own probe timeout.
   */
  readonly attachReadinessTimeoutMs?: number;
  /**
   * Forwarded to the orchestrator. `"concurrent"` starts every component slot
   * at once instead of one at a time; see `OrchestratorOptions.startup`.
   */
  readonly startup?: "sequential" | "concurrent";
};

export type SharedHarness<R extends Record<string, Environment>> = {
  readonly ensure: <K extends keyof R & string>(key: K) => Promise<Runtime<R[K]>>;
  readonly attach: <K extends keyof R & string>(key: K) => Promise<Runtime<R[K]>>;
  readonly use: <K extends keyof R & string>(key: K) => Runtime<R[K]>;
  readonly stopAll: () => Promise<void>;
};

type StartingFile = { readonly schemaVersion: 1; readonly envKey: string; readonly state: "starting"; readonly pid: number; readonly startedAt: number };
type RunningFile = EnvironmentMetadata & { readonly state: "running" };
type MetadataFile = StartingFile | RunningFile;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const STALE_MS = 90_000;
const POLL_MS = 100;
const MAX_ATTEMPTS = 300;

export const createSharedEnvs = <R extends Record<string, Environment>>(
  registry: R,
  options: SharedOptions,
): SharedHarness<R> => {
  fs.mkdirSync(options.stateDir, { recursive: true });
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous runtime cache
  const cache = new Map<string, Runtime<any>>();
  const owned = new Set<string>();
  const mode: SharedMode = options.mode ?? "startOrAttach";

  const metadataPath = (envKey: string): string => path.join(options.stateDir, `${envKey}.json`);

  const assertTarget = (envKey: string): void => {
    if (!options.getTargetEnv) return;
    const expected = options.getTargetEnv();
    if (envKey !== expected) {
      throw {
        kind: "wrong_target_env",
        requested: envKey,
        expected,
        hint:
          `This process is targeting "${expected}" (from getTargetEnv), but "${envKey}" was ` +
          `requested. One process serves one environment so parallel workers do not start ` +
          `each other's containers. Either request "${expected}", or change getTargetEnv.`,
      };
    }
  };

  const getEnv = <K extends keyof R & string>(envKey: K): R[K] => {
    const env = registry[envKey];
    if (!env) {
      throw {
        kind: "unknown_env",
        envKey,
        known: Object.keys(registry),
        hint:
          `"${envKey}" is not in the registry passed to createSharedEnvs. Known keys: ` +
          `${Object.keys(registry).join(", ") || "(none)"}. Check for a typo, or add it.`,
      };
    }
    return env;
  };

  const tryClaim = (envKey: string): boolean => {
    let fd: number;
    try {
      fd = fs.openSync(metadataPath(envKey), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    const payload: StartingFile = { schemaVersion: 1, envKey, state: "starting", pid: process.pid, startedAt: Date.now() };
    // I10: the archetype CONVENTIONS.md names — the `O_CREAT|O_EXCL` claim
    // reported success, so the file must exist and be ours. If it is not, two
    // processes both believe they own the environment and race to start it.
    invariant( () => typeof payload.pid === "number" && payload.envKey === envKey,
      "a won claim describes this process and this env",
      () => ({ envKey, payload }));
    fs.writeSync(fd, JSON.stringify(payload));
    fs.closeSync(fd);
    return true;
  };

  const readMetadataMaybe = (envKey: string): MetadataFile | null => {
    const filePath = metadataPath(envKey);
    let raw: string;
    try { raw = fs.readFileSync(filePath, "utf8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (cause) { throw { kind: "metadata_corrupt", path: filePath, cause }; }
    if ((parsed as { schemaVersion?: number }).schemaVersion !== 1) {
      throw { kind: "metadata_corrupt", path: filePath, cause: "schemaVersion_mismatch" };
    }
    return parsed as MetadataFile;
  };

  const deleteFile = (envKey: string): void => {
    try { fs.unlinkSync(metadataPath(envKey)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  };

  const writeMetadataRunning = (envKey: string, meta: EnvironmentMetadata): void => {
    const filePath = metadataPath(envKey);
    const tmp = `${filePath}.tmp`;
    const payload: RunningFile = { ...meta, state: "running" };
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, filePath);
  };

  /**
   * Compare each component's stored `version` against the live registry
   * `Binding.version`. If any component's stored `version` is present AND
   * differs from the binding, the environment is stale: the caller
   * invalidates and re-races, exactly like the dead-container path. An
   * absent stored `version` skips the check — metadata written before the
   * field existed never false-invalidates.
   */
  /**
   * The stored environment belongs to a different substrate.
   *
   * Absent `adapter` means metadata written before this field existed — skip,
   * never false-invalidate (same rule `version` follows, D-027).
   */
  const isSubstrateMismatch = (meta: EnvironmentMetadata): boolean =>
    meta.adapter !== undefined && meta.adapter !== options.adapter.name;

  const isVersionStale = <K extends keyof R & string>(envKey: K, meta: EnvironmentMetadata): boolean => {
    const env = registry[envKey] as Environment;
    for (const [componentName, slot] of Object.entries(meta.components)) {
      const binding = env[componentName];
      if (binding === undefined) continue;
      if (slot.kind === "single") {
        const stored = slot.snapshot.version;
        const current = (binding as { version?: string }).version;
        if (stored !== undefined && current !== undefined && stored !== current) return true;
      } else {
        const map = binding as Record<string, { version?: string }>;
        for (const [instanceId, compSnap] of Object.entries(slot.instances)) {
          const stored = compSnap.version;
          const current = map[instanceId]?.version;
          if (stored !== undefined && current !== undefined && stored !== current) return true;
        }
      }
    }
    return false;
  };

  const pickSampleContainerId = (meta: EnvironmentMetadata): string | null => {
    for (const slot of Object.values(meta.components)) {
      if (slot.kind === "single") return slot.snapshot.containerId;
      const first = Object.values(slot.instances)[0];
      if (first) return first.containerId;
    }
    return null;
  };

  /**
   * Stop every container referenced by a metadata snapshot, swallowing
   * per-container errors. Used when invalidating a still-running environment
   * (e.g. version drift) so the host ports it bound are released before the
   * next loop iteration tries to rebind them.
   */
  const stopAllInMeta = async (meta: EnvironmentMetadata): Promise<void> => {
    const ids: string[] = [];
    for (const slot of Object.values(meta.components)) {
      if (slot.kind === "single") {
        // Absent `owned` = `true` (pre-0.4.0 metadata = fully owned).
        if ((slot.snapshot.owned ?? true) === false) continue;
        ids.push(slot.snapshot.containerId);
      } else {
        for (const c of Object.values(slot.instances)) {
          if ((c.owned ?? true) === false) continue;
          ids.push(c.containerId);
        }
      }
    }
    for (const id of ids) {
      if (!id) continue;
      try { await options.adapter.stop(id); } catch { /* best-effort */ }
    }
  };

  const orchOpts = (envKey: string) => ({
    adapter: options.adapter,
    sessionId: `${process.pid}-${Date.now()}`,
    envKey,
    ...(options.observer !== undefined ? { observer: options.observer } : {}),
    ...(options.attachReadinessTimeoutMs !== undefined
      ? { attachReadinessTimeoutMs: options.attachReadinessTimeoutMs }
      : {}),
    ...(options.startup !== undefined ? { startup: options.startup } : {}),
  });

  const doStart = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    const runtime = await startEnvironment(getEnv(envKey), orchOpts(envKey));
    writeMetadataRunning(envKey, runtime.metadata());
    cache.set(envKey, runtime); owned.add(envKey);
    return runtime;
  };

  const doAttach = async <K extends keyof R & string>(envKey: K, meta: EnvironmentMetadata): Promise<Runtime<R[K]>> => {
    const snap: AttachSnapshot = { components: meta.components };
    const runtime = await attachEnvironment(getEnv(envKey), orchOpts(envKey), snap);
    cache.set(envKey, runtime);
    return runtime;
  };

  const freshStart = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    const existing = readMetadataMaybe(envKey);
    if (existing !== null) throw { kind: "start_metadata_exists", envKey };
    if (!tryClaim(envKey)) throw { kind: "start_metadata_exists", envKey };
    try {
      return await doStart(envKey);
    } catch (err) {
      deleteFile(envKey);
      throw err;
    }
  };

  const freshAttach = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    const meta = readMetadataMaybe(envKey);
    if (meta === null) throw { kind: "attach_no_metadata", envKey };
    if (meta.state !== "running") throw { kind: "attach_state_not_running", envKey, state: meta.state };
    // Before `exists()`, deliberately. Asking this adapter about a container id
    // from another substrate is meaningless, and the `false` it returns would
    // surface as `attach_dead_container` — a confident, wrong diagnosis that
    // sends the reader looking for a rebuilt stack.
    if (isSubstrateMismatch(meta)) {
      throw {
        kind: "attach_substrate_mismatch",
        envKey,
        expected: options.adapter.name,
        found: meta.adapter,
      };
    }
    const sample = pickSampleContainerId(meta);
    if (sample && !(await options.adapter.exists(sample))) {
      throw { kind: "attach_dead_container", envKey };
    }
    // In pure attach mode there is nothing to rebuild — surface the version
    // drift instead of silently attaching to a stale environment.
    if (isVersionStale(envKey, meta)) {
      throw { kind: "attach_version_stale", envKey };
    }
    return doAttach(envKey, meta);
  };

  const startOrAttach = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      if (tryClaim(envKey)) {
        try {
          return await doStart(envKey);
        } catch (err) {
          deleteFile(envKey);
          throw err;
        }
      }
      const meta = readMetadataMaybe(envKey);
      if (meta === null) continue;
      if (meta.state === "starting") {
        const ageMs = Date.now() - meta.startedAt;
        if (ageMs > STALE_MS) { deleteFile(envKey); continue; }
        await sleep(POLL_MS);
        continue;
      }
      // Substrate switch (a changed CYANOTYPE_ADAPTER, typically). Rebuild
      // rather than error — D-027's rule for `startOrAttach`. Unlike a version
      // bump, do NOT call stopAllInMeta first: those containers belong to
      // another substrate and this adapter cannot stop them. They are left to
      // their own substrate's teardown, which is also what happened before this
      // check existed.
      if (isSubstrateMismatch(meta)) {
        deleteFile(envKey);
        continue;
      }
      const sample = pickSampleContainerId(meta);
      if (sample && !(await options.adapter.exists(sample))) {
        deleteFile(envKey);
        continue;
      }
      // A binding-version bump invalidates the stored environment. The
      // containers are still alive (sample.exists() passed above), so stop
      // them first to release host ports before the next iteration rebuilds
      // from scratch — otherwise doStart races into "port already allocated".
      if (isVersionStale(envKey, meta)) {
        await stopAllInMeta(meta);
        deleteFile(envKey);
        continue;
      }
      return doAttach(envKey, meta);
    }
    throw { kind: "ensure_loop_exhausted", envKey, attempts: MAX_ATTEMPTS };
  };

  const ensure = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    const cached = cache.get(envKey);
    if (cached) return cached as Runtime<R[K]>;
    assertTarget(envKey);
    // WHY: startOrAttach / freshAttach call adapter.exists() before the orchestrator
    // gets a chance to connect; connect first. Adapters declare connect as idempotent.
    await options.adapter.connect();
    if (mode === "start") return freshStart(envKey);
    if (mode === "attach") return freshAttach(envKey);
    return startOrAttach(envKey);
  };

  const attach = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    const cached = cache.get(envKey);
    if (cached) return cached as Runtime<R[K]>;
    assertTarget(envKey);
    await options.adapter.connect();
    return freshAttach(envKey);
  };

  const use = <K extends keyof R & string>(envKey: K): Runtime<R[K]> => {
    const cached = cache.get(envKey);
    if (!cached) {
      throw {
        kind: "use_not_ensured",
        envKey,
        hint:
          `use("${envKey}") returns the runtime a previous ensure() built, and nothing has ` +
          `ensured "${envKey}" in this process yet. Call await shared.ensure("${envKey}") first ` +
          `— typically in a beforeAll — then use() elsewhere in the same file.`,
      };
    }
    return cached as Runtime<R[K]>;
  };

  const stopAll = async (): Promise<void> => {
    const errors: unknown[] = [];
    const hadAny = cache.size > 0;

    // Phase 1: stop owned runtimes in the cache. Each runtime.stop may
    // disconnect the adapter as a side effect.
    for (const [, runtime] of cache) {
      try { await runtime.stop(); } catch (e) { errors.push(e); }
    }
    for (const envKey of owned) deleteFile(envKey);
    cache.clear();
    owned.clear();

    // Phase 2: only if this session actually started anything, reconnect
    // and force-clean any session-labelled stragglers (orphans from chaos
    // restarts, crash-mid-start, etc.) via the adapter's label-scan
    // teardown. Then disconnect cleanly.
    //
    // Guarded by `hadAny` so a `bun test` run that never started a
    // Docker-backed env (e.g. `bun test tests/core/` with in-memory only)
    // doesn't pay a Docker connect/teardown cycle.
    if (hadAny) {
      try {
        await options.adapter.connect();
        await options.adapter.teardown();
      } catch (e) {
        errors.push(e);
      } finally {
        try { await options.adapter.disconnect(); } catch (e) { errors.push(e); }
      }
    }

    if (errors.length > 0) throw errors[0];
  };

  return { ensure, attach, use, stopAll };
};
