/**
 * Derive — pure functions that walk Docker Compose or Kubernetes manifests
 * and return a validated Cyanotype adapter-override config object keyed by
 * binding name (`component` or `component.instance`).
 *
 * These are re-exported from the shipped CLI and importable directly for
 * custom derive pipelines (Terraform state, Helm output, etc.).
 */

import { parseAllDocuments, parse as parseYaml } from "yaml";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { K8sAdapterConfigSchema } from "../adapters/kubernetes.js";
import { ComposeAdapterConfigSchema } from "../adapters/docker.js";
import type { AdapterConfig } from "../adapter.js";

type Doc = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const loadDocs = (path: string): Doc[] => {
  const st = statSync(path);
  const files = st.isDirectory()
    ? readdirSync(path)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join(path, f))
    : [path];
  const out: Doc[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const doc of parseAllDocuments(text)) {
      const v = doc.toJS();
      if (v && typeof v === "object") out.push(v as Doc);
    }
  }
  return out;
};

const getIn = (o: unknown, ...keys: string[]): unknown => {
  let cur: unknown = o;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as object))
      cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
};

const selectorMatches = (
  selector: Record<string, string>,
  labels: Record<string, string>,
): boolean => {
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
};

/**
 * `component`, or `component.instance` when the instance label carries a value.
 *
 * Absence is checked for falsiness, not `undefined`. YAML parses a valueless
 * `cyanotype.instance:` as null and Compose's array label form (`- cyanotype.instance`,
 * no `=`) as the empty string; testing `=== undefined` let both through and
 * produced the keys `redis.null` and `redis.` — which then read as an expected
 * key MISSING, while the labels the author is sent to inspect look correct.
 * Instance names are non-empty strings, so no legitimate value is falsy.
 */
const bindingKey = (component: string, instance: string | undefined | null): string =>
  instance ? `${component}.${instance}` : component;

// ---------------------------------------------------------------------------
// K8s derive
// ---------------------------------------------------------------------------

/**
 * Walk Kubernetes manifests at `k8sPath` (file or directory) and return a
 * validated adapter-override config object.
 */
export const deriveK8s = (k8sPath: string): Record<string, unknown> => {
  const docs = loadDocs(k8sPath);
  const deployments = docs.filter((d) => d.kind === "Deployment");
  const services = docs.filter((d) => d.kind === "Service");

  const out: Record<string, unknown> = {};
  for (const svc of services) {
    const svcName = getIn(svc, "metadata", "name") as string | undefined;
    const ns = getIn(svc, "metadata", "namespace") as string | undefined;
    const selector = getIn(svc, "spec", "selector") as
      | Record<string, string>
      | undefined;
    if (!svcName || !ns || !selector) continue;
    const dep = deployments.find((d) => {
      const labels =
        (getIn(d, "spec", "template", "metadata", "labels") as
          | Record<string, string>
          | undefined) ?? {};
      const depNs = getIn(d, "metadata", "namespace") as string | undefined;
      return depNs === ns && selectorMatches(selector, labels);
    });
    if (!dep) continue;
    const podLabels =
      (getIn(dep, "spec", "template", "metadata", "labels") as
        | Record<string, string>
        | undefined) ?? {};
    const component = podLabels["cyanotype.component"];
    if (!component) continue;
    const instance = podLabels["cyanotype.instance"];
    const containers =
      (getIn(dep, "spec", "template", "spec", "containers") as Array<
        Record<string, unknown>
      >) ?? [];
    const ports =
      (containers[0]?.ports as
        | Array<{ containerPort: number }>
        | undefined) ?? [];
    // Emit `attach.port` iff the workload declares exactly one container
    // port. Multi-port workloads omit it — the binding's `spec.ports` drives
    // full multi-port resolution in the k8s adapter's `startAttach`. A
    // workload with no declared ports has no useful topology and is skipped.
    if (ports.length === 0) continue;
    const singleContainerPort =
      ports.length === 1 ? ports[0]?.containerPort : undefined;
    const depName = getIn(dep, "metadata", "name") as string | undefined;
    if (!depName) continue;
    const entry = {
      k8s: {
        attach: {
          namespace: ns,
          service: svcName,
          ...(singleContainerPort !== undefined
            ? { port: singleContainerPort }
            : {}),
          deployment: depName,
        },
      },
    };
    K8sAdapterConfigSchema.parse(entry);
    out[bindingKey(component, instance)] = entry;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Compose derive
// ---------------------------------------------------------------------------

type ComposeService = {
  labels?: Record<string, string> | string[];
  ports?: Array<string | { target: number; published?: number | string }>;
};

const parseComposeLabels = (
  raw: Record<string, string> | string[] | undefined,
): Record<string, string> => {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      const idx = entry.indexOf("=");
      if (idx < 0) {
        out[entry] = "";
        continue;
      }
      out[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return out;
  }
  return raw;
};

/**
 * Returns the published container port of a compose service iff the service
 * exposes exactly one port. Multi-port services return `undefined`, signalling
 * that `compose.attach.port` should be omitted from derived output — the
 * binding's own `spec.ports` then drives full multi-port resolution in the
 * docker adapter's `startAttach`. (`attach.port`, when set, overrides
 * `spec.ports` to a single key; emitting a guessed first port for a multi-port
 * service silently truncates resolution to that one port.)
 */
const parseComposeContainerPort = (
  ports: ComposeService["ports"],
): number | undefined => {
  if (ports?.length !== 1) return undefined;
  const first = ports[0]!;
  if (typeof first === "string") {
    const parts = first.split(":");
    const containerPart = parts[parts.length - 1]!;
    const portStr = containerPart.split("/")[0]!;
    const n = parseInt(portStr, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return typeof first.target === "number" ? first.target : undefined;
};

/**
 * Walk a Docker Compose YAML file at `composePath` and return a validated
 * adapter-override config object.
 *
 * Optionally pass `project` to override the compose project name embedded in
 * each entry's `compose.attach.project` field.
 */
export const deriveCompose = (
  composePath: string,
  project?: string,
): Record<string, unknown> => {
  const text = readFileSync(composePath, "utf8");
  const doc = parseYaml(text) as {
    services?: Record<string, ComposeService>;
  } | null;
  if (!doc?.services) return {};

  const out: Record<string, unknown> = {};
  for (const [serviceName, svc] of Object.entries(doc.services)) {
    const labels = parseComposeLabels(
      svc.labels as Record<string, string> | string[] | undefined,
    );
    const component = labels["cyanotype.component"];
    if (!component) continue;
    const instance = labels["cyanotype.instance"];
    const hostPort = parseComposeContainerPort(svc.ports);
    const entry = {
      compose: {
        attach: {
          ...(project !== undefined ? { project } : {}),
          service: serviceName,
          ...(hostPort !== undefined ? { port: hostPort } : {}),
        },
      },
    };
    ComposeAdapterConfigSchema.parse(entry);
    out[bindingKey(component, instance)] = entry;
  }
  return out;
};

// ---------------------------------------------------------------------------
// loadDerivedCompose
// ---------------------------------------------------------------------------

/** Missing file at `path`. */
export type DerivedComposeMissingError = {
  readonly kind: "derived_compose_missing";
  readonly path: string;
  /** Human-readable explanation of what went wrong and how to fix it (D-043). */
  readonly hint: string;
};
/** Parse failure or per-entry schema validation failure. */
export type DerivedComposeInvalidError = {
  readonly kind: "derived_compose_invalid";
  readonly path: string;
  readonly cause: unknown;
  /** Human-readable explanation of what went wrong and how to fix it (D-043). */
  readonly hint: string;
};
/** One or more `expectedKeys` were absent from the loaded map. */
export type DerivedComposeMissingKeysError = {
  readonly kind: "derived_compose_missing_keys";
  readonly path: string;
  readonly missing: readonly string[];
  /** Human-readable explanation of what went wrong and how to fix it (D-043). */
  readonly hint: string;
};

/**
 * Load a `derived-compose.json` (the JSON file produced by
 * `cyanotype derive compose`), validate each entry against
 * `ComposeAdapterConfigSchema`, and assert that every key in `expectedKeys`
 * is present.
 *
 * Synchronous on purpose: callers should invoke this from inside their own
 * ensure-time setup (e.g. a test harness's `beforeAll`, a CLI entry point)
 * rather than at module top level. Calling at import time would surface the
 * file-missing / schema-invalid throws as opaque module-load failures.
 *
 * Throws a discriminated `{ kind: ... }` error:
 *   - `derived_compose_missing` when the file does not exist.
 *   - `derived_compose_invalid` on JSON parse failure or a per-entry
 *     schema-validation failure (the offending Zod error is on `cause`).
 *   - `derived_compose_missing_keys` when one or more `expectedKeys` are
 *     absent from the loaded map (the names are listed on `missing`).
 *
 * Returns the loaded map typed as `Record<string, AdapterConfig>` so a
 * consumer can spread per-binding into `bind({ ..., adapter })`.
 */
export const loadDerivedCompose = (
  path: string,
  expectedKeys: readonly string[],
): Record<string, AdapterConfig> => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw {
        kind: "derived_compose_missing",
        path,
        hint:
          `No derived config at "${path}". Attach mode reads a file your derive step writes: run cyanotype derive compose --compose <your compose file> --out <path> before the suite, or produce the equivalent from your own script. Add --project unless the consumer passes project to createDockerAdapter, or the entries will carry no project and fail later with compose_attach_project_required. Use the compose subcommand: this loader validates compose config, but every field is optional, so k8s-derived output would load cleanly here and only fail much later.`,
      } satisfies DerivedComposeMissingError;
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw {
      kind: "derived_compose_invalid",
      path,
      cause,
      hint:
        `"${path}" is not valid JSON. A derive step writes it — the shipped ` +
        `"cyanotype derive compose" CLI, or your own script — so re-run that step rather than ` +
        `hand-editing, and check nothing truncated the file.`,
    } satisfies DerivedComposeInvalidError;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw {
      kind: "derived_compose_invalid",
      path,
      cause: "expected a JSON object at top level",
      hint:
        `"${path}" parsed as JSON but is not an object. A derive step writes a map of binding ` +
        `key — component, or component.instance — to adapter config; re-run yours rather than ` +
        `hand-editing.`,
    } satisfies DerivedComposeInvalidError;
  }

  const obj = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const result = ComposeAdapterConfigSchema.safeParse(value);
    if (!result.success) {
      throw {
        kind: "derived_compose_invalid",
        path,
        cause: { key, issues: result.error.issues },
        hint:
          `The entry for "${key}" in "${path}" has a compose.attach field of the wrong type or shape — \`cause\` carries the exact field and what was expected (port must be a number, onImageDrift one of warn|fail|ignore). Note an entry with NO compose fields at all is accepted, so this is never "you forgot to emit them": something emitted the wrong type. The shipped derive CLI validates against this same schema before writing, so a failing entry was hand-edited or produced by a derive script of your own.`,
      } satisfies DerivedComposeInvalidError;
    }
  }

  const missing = expectedKeys.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw {
      kind: "derived_compose_missing_keys",
      path,
      missing,
      hint:
        `"${path}" is missing [${missing.join(", ")}]. These are the expectedKeys passed to loadDerivedCompose, so the list and the file disagree — either could be the stale one. If this file came from the shipped cyanotype derive CLI, its keys are each service\u2019s cyanotype.component label, suffixed with .<cyanotype.instance> when that label carries a value, and services with no component label are skipped — so check those labels in the manifest it walked. If your own derive step wrote it, the keys are whatever that script chose and only it can tell you.`,
    } satisfies DerivedComposeMissingKeysError;
  }

  return obj as Record<string, AdapterConfig>;
};
