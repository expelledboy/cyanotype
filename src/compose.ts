/**
 * reconcileComposeStack — own the docker-compose staleness/rebuild cycle:
 * fingerprint a set of inputs, compare against a persisted record, run
 * `docker compose up -d --build` when stale, invoke a post-rebuild hook,
 * re-fingerprint.
 *
 * Reconciles the compose stack only — does not attach an `Environment`. After
 * it returns, the caller's next step is the usual `createSharedEnvs` /
 * `attachEnvironment` against the now-fresh stack.
 *
 * The `stack.*` observer phase (see `observer.ts`) is emitted when an
 * `Observer` is supplied, via `createEmitter` exactly as the orchestrator and
 * `createSharedEnvs` do.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEmitter, type Observer } from "./observer.js";

const DEFAULT_STATE_DIR = ".cyanotype-env";

/**
 * One fingerprint input. `file` hashes the SHA-256 of a file's contents (a
 * missing file fingerprints as the sentinel `"<missing>"` rather than
 * throwing — an absent input is itself a meaningful, stable state). `value`
 * hashes a caller-supplied string verbatim (image tags, env vars, image IDs).
 */
export type FingerprintInput =
  | { readonly name: string; readonly file: string }
  | { readonly name: string; readonly value: string };

/**
 * The set of inputs to hash for staleness. Either a static list of named
 * inputs, or a function returning a record of named field values — the
 * function form lets the caller pull in async-derived values (image IDs from
 * `docker image inspect`, etc.).
 */
export type FingerprintSpec =
  | readonly FingerprintInput[]
  | (() => Promise<Readonly<Record<string, string>>>);

export type ReconcileComposeOptions = {
  /** Compose project name (`docker compose -p <project>`). */
  readonly project: string;
  /** Path to the compose YAML file. */
  readonly composeFile: string;
  /** Inputs to hash for staleness. */
  readonly fingerprint: FingerprintSpec;
  /**
   * Async hook invoked after a rebuild and before re-fingerprinting — the
   * place to run `deriveCompose` or other post-rebuild derivation so its
   * output is captured by the persisted fingerprint.
   */
  readonly onStale?: () => Promise<void>;
  /** Framework-lifecycle observer. See `observer.ts`. */
  readonly observer?: Observer;
  /** Persisted-fingerprint directory. Defaults to `.cyanotype-env`. */
  readonly stateDir?: string;
  /**
   * Manual escape hatch: when `true`, skip the fingerprint compare and the
   * running-stack check and go straight to the rebuild path. Intended for
   * environment-variable or CI-flag overrides (e.g. a `--rebuild` switch).
   *
   * Does not skip `onStale`, does not skip fingerprint persistence — the
   * post-rebuild fingerprint is still written so the next run can short-
   * circuit normally. The emitted `stack.stale` event reports
   * `changedFields: ["<forced>"]` so reporters render coherently.
   */
  readonly force?: boolean;
};

export type ReconcileComposeResult = {
  /** Whether `docker compose up -d --build` actually ran. */
  readonly rebuilt: boolean;
  /** Fingerprint field names that differed from the stored record. */
  readonly changedFields: readonly string[];
  /** Wall-clock duration of the rebuild, or 0 when fresh. */
  readonly durationMs: number;
};

/** A computed fingerprint: a record of `field name → SHA-256 (or sentinel)`. */
export type Fingerprint = Readonly<Record<string, string>>;

type StoredFingerprint = {
  readonly schemaVersion: 1;
  readonly project: string;
  readonly savedAt: string;
  readonly fields: Fingerprint;
};

const MISSING = "<missing>";

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const sha256FileMaybe = (filePath: string): string => {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return MISSING;
    throw e;
  }
};

/** Compute the fingerprint record from a `FingerprintSpec`. Pure-ish: the */
/** only IO is file reads (and the caller's function, if that form is used). */
export const computeFingerprint = async (spec: FingerprintSpec): Promise<Fingerprint> => {
  if (typeof spec === "function") {
    const fields = await spec();
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields)) out[name] = sha256(value);
    return out;
  }
  const out: Record<string, string> = {};
  for (const input of spec) {
    out[input.name] =
      "file" in input ? sha256FileMaybe(input.file) : sha256(input.value);
  }
  return out;
};

/**
 * Field names whose hash differs between `stored` and `current`. A field
 * present on one side only counts as changed. A `null` stored record (no
 * persisted fingerprint) reports every current field as changed.
 */
export const changedFingerprintFields = (
  stored: Fingerprint | null,
  current: Fingerprint,
): string[] => {
  if (stored === null) return Object.keys(current).sort();
  const names = new Set([...Object.keys(stored), ...Object.keys(current)]);
  const changed: string[] = [];
  for (const name of names) {
    if (stored[name] !== current[name]) changed.push(name);
  }
  return changed.sort();
};

const fingerprintPath = (stateDir: string, project: string): string =>
  path.join(stateDir, `${project}-stack-fingerprint.json`);

/** Load the persisted fingerprint, or `null` when absent / unreadable. */
export const readStoredFingerprint = (
  stateDir: string,
  project: string,
): Fingerprint | null => {
  let raw: string;
  try {
    raw = fs.readFileSync(fingerprintPath(stateDir, project), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: StoredFingerprint;
  try {
    parsed = JSON.parse(raw) as StoredFingerprint;
  } catch (cause) {
    throw { kind: "stack_fingerprint_corrupt", path: fingerprintPath(stateDir, project), cause };
  }
  if (parsed.schemaVersion !== 1 || typeof parsed.fields !== "object") {
    throw { kind: "stack_fingerprint_corrupt", path: fingerprintPath(stateDir, project), cause: "schema_mismatch" };
  }
  return parsed.fields;
};

/** Atomically persist a fingerprint (tmp-write + rename, like `shared.ts`). */
export const writeStoredFingerprint = (
  stateDir: string,
  project: string,
  fields: Fingerprint,
): void => {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = fingerprintPath(stateDir, project);
  const tmp = `${filePath}.tmp`;
  const payload: StoredFingerprint = {
    schemaVersion: 1,
    project,
    savedAt: new Date().toISOString(),
    fields,
  };
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
};

const decode = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return "";
  return await new Response(stream).text();
};

/**
 * Run a subprocess to completion via `Bun.spawn`, mirroring how the Docker /
 * kubectl adapters shell out. Returns trimmed stdout; throws a tagged error
 * on a non-zero exit.
 */
const spawnTo = async (
  kind: string,
  cmd: readonly string[],
): Promise<string> => {
  const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    decode(proc.stdout),
    decode(proc.stderr),
    proc.exited,
  ]);
  if (code !== 0) {
    throw { kind, command: cmd.join(" "), exitCode: code, stderr: err.trim() };
  }
  return out.trim();
};

/** Count running compose services for `project` via `docker compose ps -q`. */
const composeServiceCount = async (
  project: string,
  composeFile: string,
): Promise<number> => {
  const out = await spawnTo("stack_compose_ps_failed", [
    "docker", "compose", "-p", project, "-f", composeFile, "ps", "-q",
  ]);
  return out.split("\n").filter((l) => l.trim().length > 0).length;
};

const composeRunning = async (project: string, composeFile: string): Promise<boolean> => {
  try {
    return (await composeServiceCount(project, composeFile)) > 0;
  } catch {
    return false;
  }
};

/**
 * Reconcile a docker-compose stack against a fingerprint of its inputs.
 *
 * Computes the current fingerprint, compares it to
 * `<stateDir>/<project>-stack-fingerprint.json`, and — when stale, when no
 * fingerprint is stored, or when the stack is not running — runs
 * `docker compose -p <project> up -d --build`, invokes `onStale`, then
 * re-computes and persists the fingerprint.
 */
export const reconcileComposeStack = async (
  options: ReconcileComposeOptions,
): Promise<ReconcileComposeResult> => {
  const { project, composeFile, fingerprint, onStale } = options;
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const emit = createEmitter(options.observer).scope({ adapter: "compose", envKey: project });

  try {
    emit({ type: "stack.checking", stackName: project });

    const current = await computeFingerprint(fingerprint);
    const stored = readStoredFingerprint(stateDir, project);
    const force = options.force === true;
    const running = force ? false : await composeRunning(project, composeFile);
    const changedFields = force ? [] : changedFingerprintFields(stored, current);
    const stale = force || stored === null || changedFields.length > 0 || !running;

    let rebuilt = false;
    let durationMs = 0;

    if (!stale) {
      emit({ type: "stack.fresh", stackName: project });
    } else {
      // A not-running-but-fingerprint-matched stack still needs a rebuild;
      // surface it as a synthetic changed field so the reason is visible.
      // A forced rebuild renders as `<forced>` for the same reason.
      const reportedFields = force
        ? ["<forced>"]
        : changedFields.length > 0 ? changedFields : ["<not-running>"];
      emit({ type: "stack.stale", stackName: project, changedFields: reportedFields });

      emit({ type: "stack.rebuilding", stackName: project });
      const startedAt = Date.now();
      await spawnTo("stack_compose_up_failed", [
        "docker", "compose", "-p", project, "-f", composeFile, "up", "-d", "--build",
      ]);
      if (onStale) await onStale();
      durationMs = Date.now() - startedAt;
      rebuilt = true;
      emit({ type: "stack.rebuilt", stackName: project, durationMs });

      writeStoredFingerprint(stateDir, project, await computeFingerprint(fingerprint));
    }

    const serviceCount = await composeServiceCount(project, composeFile);
    emit({ type: "stack.attached", stackName: project, serviceCount });

    return { rebuilt, changedFields, durationMs };
  } catch (error) {
    emit({ type: "stack.failed", stackName: project, error });
    throw error;
  }
};
