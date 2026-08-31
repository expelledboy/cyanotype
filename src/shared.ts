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
    catch (cause) {
      throw {
        kind: "metadata_corrupt",
        path: filePath,
        cause,
        hint:
          `The state file at ${filePath} did not parse as JSON; \`cause\` carries the parse ` +
          `error. Two causes, and the order to try them in matters. A claim file is created ` +
          `empty and written a moment later, so a worker that loses the claim race and reads ` +
          `in that window sees zero bytes — that is a healthy concurrent run and clears by ` +
          `itself. A run killed mid-write leaves the same file truncated permanently. Re-run ` +
          `first. Only if it survives a re-run is the file genuinely damaged: then delete it, ` +
          `and stop any containers labelled cyanotype=1 that the dead run left behind. Do not ` +
          `delete on the first occurrence — during the transient window that removes another ` +
          `worker's live claim and lets two processes start the same environment.`,
      };
    }
    // `parsed` is whatever JSON.parse returned: a file containing `null`, a
    // number or a string parses fine and is not an object. Reading a property
    // off it threw a raw TypeError that escaped untagged, past this guard.
    if (parsed === null || typeof parsed !== "object"
      || (parsed as { schemaVersion?: number }).schemaVersion !== 1) {
      throw {
        kind: "metadata_corrupt",
        path: filePath,
        cause: "schemaVersion_mismatch",
        hint:
          `The state file at ${filePath} did not read back as an object carrying ` +
          `schemaVersion 1 — that check also covers a file that parsed as null, a number or ` +
          `a string. No released Cyanotype has written any other schemaVersion, so this is ` +
          `most likely not Cyanotype's file or it was truncated. Delete it and re-run: ` +
          `ensure() in mode "start" or "startOrAttach" writes a fresh one, and mode "attach" ` +
          `never builds one. Containers Cyanotype started carry the label cyanotype=1.`,
      };
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
    if (existing !== null) {
      throw {
        kind: "start_metadata_exists",
        envKey,
        hint:
          `mode: "start" refuses to touch an environment that already exists, so it can ` +
          `never adopt containers it did not create. A state file is present; what it ` +
          `describes depends on its state. A "running" file means containers are up — use ` +
          `mode: "startOrAttach" to reuse them. A "starting" file means another worker is ` +
          `mid-claim and there may be no containers yet, so waiting is usually right. Only ` +
          `if it is neither is it leftover state: delete the <envKey>.json under the ` +
          `stateDir you passed to createSharedEnvs, stop any containers Cyanotype started ` +
          `(they carry the label cyanotype=1), then re-run.`,
      };
    }
    if (!tryClaim(envKey)) {
      throw {
        kind: "start_metadata_exists",
        envKey,
        hint:
          `Another process claimed "${envKey}" first — the claim is atomic so exactly one ` +
          `starts it. If you meant to share that environment use mode: "startOrAttach", which ` +
          `waits for the winner and attaches.`,
      };
    }
    try {
      return await doStart(envKey);
    } catch (err) {
      deleteFile(envKey);
      throw err;
    }
  };

  const freshAttach = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    const meta = readMetadataMaybe(envKey);
    if (meta === null) {
      throw {
        kind: "attach_no_metadata",
        envKey,
        hint:
          `Attaching only ever joins an environment something else already started, and no ` +
          `state file for "${envKey}" exists under the stateDir this handle was given. That ` +
          `starter need not be another process — a second createSharedEnvs handle in this ` +
          `one shares the stateDir but not the cache, so it qualifies too. Start it first, ` +
          `or call ensure() with mode: "startOrAttach", so this process starts it when ` +
          `nobody else has. Changing mode does nothing for attach(), which always takes ` +
          `this path. Check the stateDir is the one you expect before assuming the starter ` +
          `failed.`,
      };
    }
    if (meta.state !== "running") {
      throw {
        kind: "attach_state_not_running",
        envKey,
        state: meta.state,
        hint:
          `The state file for "${envKey}" says \`state\` is "${meta.state}", not "running", ` +
          `and attaching never waits. Whether a starter is still working or died holding the ` +
          `claim is not checked here — this path has no staleness test, so an abandoned claim ` +
          `looks identical to a live one. ensure() with mode: "startOrAttach" handles both, ` +
          `but differently: it polls a fresh claim for up to ~30s (300 tries, 100ms apart) and ` +
          `attaches when the starter finishes, whereas a claim older than 90s it deletes and ` +
          `rebuilds from scratch. Those thresholds do not overlap, so an abandoned claim is ` +
          `never reclaimed within the call that meets it — re-run once it has aged past 90s. ` +
          `Changing mode does nothing for attach(), which always takes this path.`,
      };
    }
    // Before `exists()`, deliberately. Asking this adapter about a container id
    // from another substrate is meaningless, and the `false` it returns would
    // surface as `attach_dead_container` — a confident, wrong diagnosis that
    // sends the reader looking for a rebuilt stack.
    if (isSubstrateMismatch(meta)) {
      throw {
        kind: "attach_substrate_mismatch",
        envKey,
        expected: options.adapter.name,
        hint:
          `This environment was started on substrate "${meta.adapter}" but this handle was ` +
          `given "${options.adapter.name}", and container ids only mean something to the ` +
          `adapter that issued them, so attaching refuses rather than guessing. Point this ` +
          `handle back at the original adapter to reuse it, or call ensure() with ` +
          `mode: "startOrAttach" to build a fresh one here. To clear the old environment ` +
          `instead, do it from the substrate named in \`found\` — this adapter cannot ` +
          `address those containers at all. Whether they carry the label cyanotype=1 depends ` +
          `on how that run got them: containers Cyanotype started carry it, but if that run ` +
          `was itself attaching to a stack you own, they are yours and unlabelled. Then ` +
          `delete the <envKey>.json under your stateDir.`,
        found: meta.adapter,
      };
    }
    const sample = pickSampleContainerId(meta);
    if (sample && !(await options.adapter.exists(sample))) {
      throw {
        kind: "attach_dead_container",
        envKey,
        containerId: sample,
        hint:
          `The adapter reported the sampled container in \`containerId\` as absent, so ` +
          `attaching stopped rather than hand back a runtime pointing at nothing. What ` +
          `"absent" means is the adapter's definition, and it is not always "gone": in ` +
          `Docker attach mode a compose container that merely STOPPED reports absent by ` +
          `design, and in Kubernetes attach mode a container this process did not itself ` +
          `start reports absent — so a second worker attaching cross-process sees this for a ` +
          `healthy pod. Check whether that container is actually running before treating it ` +
          `as lost. If Cyanotype started it (containers it starts carry the label ` +
          `cyanotype=1) it really is gone: stop any siblings still running, delete the ` +
          `<envKey>.json under the stateDir you passed to createSharedEnvs, and re-run with ` +
          `mode: "start" or "startOrAttach" — re-running in mode: "attach" only yields ` +
          `attach_no_metadata. If you own the stack, bring the stopped service back up ` +
          `instead. Only one container is sampled, so siblings may still hold fixed host ` +
          `ports; stop them before rebuilding or the rebuild collides.`,
      };
    }
    // In pure attach mode there is nothing to rebuild — surface the version
    // drift instead of silently attaching to a stale environment.
    if (isVersionStale(envKey, meta)) {
      throw {
        kind: "attach_version_stale",
        envKey,
        hint:
          `A Binding's version differs from the one recorded when these containers started. ` +
          `version is a declared cache key, so this says the declaration moved on — not that ` +
          `the running image was checked and found different. Attaching refuses rather than ` +
          `testing something the code no longer describes; ensure() with ` +
          `mode: "startOrAttach" stops the containers Cyanotype owns and rebuilds. By hand: ` +
          `delete the <envKey>.json under the stateDir you passed to createSharedEnvs, stop ` +
          `the containers Cyanotype started (they carry the label cyanotype=1), and re-run ` +
          `with mode: "start" or "startOrAttach" — re-running in mode: "attach" finds no ` +
          `state file and raises attach_no_metadata instead.`,
      };
    }
    return doAttach(envKey, meta);
  };

  const startOrAttach = async <K extends keyof R & string>(envKey: K): Promise<Runtime<R[K]>> => {
    let attempt = 0;
    const loopStart = Date.now();
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
    throw {
      kind: "ensure_loop_exhausted",
      envKey,
      attempts: MAX_ATTEMPTS,
      elapsedMs: Date.now() - loopStart,
      hint:
        `Gave up after ${MAX_ATTEMPTS} attempts to settle "${envKey}". Read \`elapsedMs\` ` +
        `first — it separates two very different failures, because only the branch that ` +
        `waits on a starting claim sleeps (100ms); every other branch retries immediately. ` +
        `Near 30s means another process holds a "starting" claim and never reached ` +
        `"running": it is hung or was killed without clearing the claim. A claim is treated ` +
        `as stale only once it is 90s old, which outlasts this loop, so re-running after ` +
        `that reclaims it automatically. Far below 30s means the loop was spinning, not ` +
        `waiting — invalidating and re-reading the state file every attempt, which happens ` +
        `when another process keeps rewriting it, or when something the environment depends ` +
        `on keeps failing the same check. To clear a claim by hand: delete the ` +
        `<envKey>.json under the stateDir you passed to createSharedEnvs and stop the ` +
        `containers Cyanotype started (they carry the label cyanotype=1), then re-run.`,
    };
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
          `use("${envKey}") returns the runtime a previous ensure() or attach() call cached ` +
          `on this handle, and nothing is cached for "${envKey}". The cache is filled only ` +
          `when one of those calls SUCCEEDS, and stopAll() empties it — so this also fires ` +
          `after a call that threw, and after teardown, not only when neither was ever ` +
          `called. Call await shared.ensure("${envKey}") first — typically in a beforeAll — ` +
          `then use() anywhere that imports the same createSharedEnvs handle in this ` +
          `process. use() never starts anything itself, so it cannot recover on its own.`,
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
