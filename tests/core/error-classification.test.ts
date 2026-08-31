/**
 * Enforces the invariant-vs-error-vs-hint discipline (D-042, D-043).
 *
 * Every `throw { kind: "..." }` in `src/` must be classified below as either
 * CONSUMER_FACING (reachable by someone using Cyanotype correctly-or-not from
 * their own code — must carry a `hint`) or INTERNAL (reachable only through
 * Cyanotype's own machinery or a custom Adapter implementation — must not,
 * because a hint nobody can act on is noise).
 *
 * Adding an error and leaving it unclassified fails this test. That is the
 * point: the decision is forced at the moment the error is written, when the
 * author still knows who can trigger it.
 *
 * Deciding which list: ask WHO BROKE IT. If a consumer's own code caused it,
 * it is consumer-facing and owes them an explanation. If it means Cyanotype
 * (or an Adapter implementing our SPI) violated its own contract, it is
 * internal — and if it is an agreement between OUR modules that no signature
 * can state, consider `invariant()` instead of an error entirely.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Consumer's own code can cause these. Each MUST carry a `hint`. */
const CONSUMER_FACING = new Set([
  // Their Environment / Binding / Blueprint definition
  "binding_missing_declared_ports", "reserved_component_name", "image_not_registered",
  // Their use of the shared-env handle
  "unknown_env", "wrong_target_env", "use_not_ensured",
  "start_metadata_exists", "attach_no_metadata", "attach_state_not_running",
  "ensure_loop_exhausted", "metadata_corrupt",
  // Their environment drifted from the one Cyanotype persisted
  "attach_dead_container", "attach_version_stale", "attach_substrate_mismatch",
  "attach_reconnect_failed",
  "attach_image_drift", "container_gone",
  "snapshot_unknown_component", "snapshot_shape_mismatch", "snapshot_unknown_instance",
  // Their chaos call
  "component_not_found", "invalid_chaos",
  "chaos_not_supported_in_attach", "chaos_unsupported_in_attach_mode",
  // Their service did not behave — the most-hit errors in the library
  "probe_timeout", "attach_probe_failed", "wait_for_timeout", "sequence_timeout",
  "fetch_error",
  // Their machine, daemon, images
  "docker_connect_failed", "docker_stop_failed", "image_pull_failed",
  "container_start_failed", "port_not_bound", "chaos_stop_unverified",
  // Their derive step and its output
  "derived_compose_missing", "derived_compose_invalid", "derived_compose_missing_keys",
  "stack_fingerprint_corrupt",
  // Their compose stack
  "compose_attach_project_required", "compose_attach_service_not_found",
  "compose_attach_container_not_running",
  // Their cluster's port-forwarding and local sockets
  "k8s_port_forward_timeout", "k8s_port_forward_exited", "k8s_local_port_claim_failed",
  // Their cluster, RBAC, and attach config
  "kubectl_not_found", "k8s_namespace_missing", "k8s_namespace_create_failed",
  "k8s_pod_not_ready", "k8s_pod_apply_failed", "k8s_configmap_apply_failed",
  "k8s_service_apply_failed",
  "k8s_attach_deployment_required", "k8s_attach_service_not_found",
  "k8s_attach_no_ready_endpoints", "k8s_attach_scale_failed",
  // Their composite routing
  "composite_route_key_invalid", "composite_substrates_unreachable",
]);

/**
 * Reachable only via Cyanotype's own machinery, a substrate failure, or a
 * third-party Adapter breaking the SPI contract. No `hint` — the reader cannot
 * act on advice about our internals, and substrate failures carry their own
 * cause.
 */
const INTERNAL = new Set([
  // Reached only through `attach_reconnect_failed`, which wraps it with the
  // component identity and the hint. Bare here so the reader gets one story.
  "k8s_reconnect_pod_not_running",
  // Cyanotype's own machinery, or an Adapter violating our SPI. A consumer
  // cannot act on any of these, so a hint would be noise.
  "invariant_violated",
  "missing_cyanotype_label",     // the orchestrator always sets it (D-004)
  "docker_not_connected",        // connect() ordering, ours to get right
  "probe_aborted",               // our AbortController, not a failure of theirs
  "attach_mode_violation",       // the non-destructive chokepoint refusing a write
  "k8s_attach_endpoint_wait_timeout", "k8s_attach_endpointslice_parse_failed",
]);

const srcFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return srcFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });

/** Each `throw { ... }` block in src/, with its kind and whether it has a hint. */
const throwSites = (): { file: string; kind: string; hasHint: boolean }[] => {
  const out: { file: string; kind: string; hasHint: boolean }[] = [];
  for (const file of srcFiles("src")) {
    // Strip comments first: JSDoc shows example throws (`throw { kind:
    // "zero_ping_failed" }` in probe.ts documents a custom-probe convention)
    // which are not error kinds this library raises.
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // `reject({ kind: ... })` counts as raising an error. Matching only `throw`
    // let three consumer-visible Kubernetes failures — port-forward timeout,
    // port-forward exited, local port claim — escape classification entirely,
    // so they shipped with no hint and nothing noticed.
    for (const m of text.matchAll(/(?:throw|reject\()\s*\{/g)) {
      // Walk to the matching brace so a hint in a NEIGHBOURING throw cannot
      // be miscredited to this one.
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) break; }
      }
      const block = text.slice(m.index, i + 1);
      const kind = block.match(/kind:\s*"([a-z0-9_]+)"/)?.[1];
      if (kind) out.push({ file, kind, hasHint: /\bhint:/.test(block) });
    }
  }
  return out;
};

describe("error classification (D-042, D-043)", () => {
  const sites = throwSites();

  test("there are throw sites to check", () => {
    expect(sites.length).toBeGreaterThan(30);
  });

  test("every thrown kind is classified as consumer-facing or internal", () => {
    const unclassified = [...new Set(
      sites.filter((s) => !CONSUMER_FACING.has(s.kind) && !INTERNAL.has(s.kind))
        .map((s) => `${s.kind} (${s.file})`),
    )];
    expect(unclassified).toEqual([]);
  });

  test("every consumer-facing error carries a hint", () => {
    const missing = sites
      .filter((s) => CONSUMER_FACING.has(s.kind) && !s.hasHint)
      .map((s) => `${s.kind} (${s.file})`);
    expect(missing).toEqual([]);
  });

  test("internal errors do not carry hints", () => {
    const noisy = sites
      .filter((s) => INTERNAL.has(s.kind) && s.hasHint)
      .map((s) => `${s.kind} (${s.file})`);
    expect(noisy).toEqual([]);
  });

  /**
   * `just <recipe>` where <recipe> is a real recipe in this repo's justfile.
   *
   * Matching a bare /just \s+\w+/ fires on the ordinary English adverb — it
   * rejected "renaming just the key" — and a check that cries wolf on prose is
   * one someone eventually disables. Reading the recipe names keeps it exact
   * and needs no maintenance when they change.
   */
  const RECIPE_INVOCATION = (() => {
    const recipes = [...readFileSync("justfile", "utf8")
      .matchAll(/^([a-z][\w-]*)(?:\s+[\w"'=]+)*:/gm)].map((m) => m[1]);
    return new RegExp(`\\bjust\\s+(?:${recipes.join("|")})\\b`);
  })();

  test("hints do not reference this repository's own tooling", () => {
    // A consumer has no justfile of ours. Advice must be expressed in terms of
    // their code, their config, or their container runtime.
    const offenders: string[] = [];
    for (const file of srcFiles("src")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/hint:[\s\S]{0,900}?`,\n/g)) {
        if (RECIPE_INVOCATION.test(m[0]) || /bun run |npm run /.test(m[0])) offenders.push(file);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
