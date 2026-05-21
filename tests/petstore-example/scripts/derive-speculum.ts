#!/usr/bin/env bun
/**
 * EXAMPLE derive script — walk Kubernetes manifests or Docker Compose YAML
 * and emit a Speculum adapter-override JSON keyed by Speculum binding name.
 *
 * Developers write their own (Terraform state, Helm template output, etc.);
 * this is intentionally a thin reference implementation pointed at static
 * YAML so the petstore-example suite has a load-bearing demo of the
 * declaration-merge → derived.json → env.ts flow.
 *
 * Usage (K8s):
 *   bun tests/petstore-example/scripts/derive-speculum.ts \
 *     --k8s tests/support/k8s/petstore-attach/all.yaml \
 *     --out tests/petstore-example/derived.json
 *
 * Usage (Compose):
 *   bun tests/petstore-example/scripts/derive-speculum.ts \
 *     --compose tests/support/compose/petstore-attach/compose.yaml \
 *     --out tests/petstore-example/derived-compose.json
 */

import { parseAllDocuments, parse as parseYaml } from "yaml";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { K8sAdapterConfigSchema } from "../../../src/adapters/kubernetes";
import { ComposeAdapterConfigSchema } from "../../../src/adapters/docker";

type Doc = Record<string, unknown>;

const args = (() => {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const k8s = get("--k8s");
  const compose = get("--compose");
  const out = get("--out");
  if ((!k8s && !compose) || !out) {
    console.error("usage: derive-speculum.ts (--k8s <dir-or-file> | --compose <file>) --out <file-or-->");
    process.exit(2);
  }
  return { k8s, compose, out };
})();

const loadDocs = (path: string): Doc[] => {
  const st = statSync(path);
  const files = st.isDirectory()
    ? readdirSync(path).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(path, f))
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

const get = (o: unknown, ...keys: string[]): unknown => {
  let cur: unknown = o;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as object)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
};

const selectorMatches = (selector: Record<string, string>, labels: Record<string, string>): boolean => {
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
};

const bindingKey = (component: string, instance: string | undefined): string =>
  instance === undefined ? component : `${component}.${instance}`;

// ---------------------------------------------------------------------------
// K8s derive path
// ---------------------------------------------------------------------------

const deriveK8s = (k8sPath: string): Record<string, unknown> => {
  const docs = loadDocs(k8sPath);
  const deployments = docs.filter((d) => d.kind === "Deployment");
  const services = docs.filter((d) => d.kind === "Service");

  const out: Record<string, unknown> = {};
  for (const svc of services) {
    const svcName = get(svc, "metadata", "name") as string | undefined;
    const ns = get(svc, "metadata", "namespace") as string | undefined;
    const selector = get(svc, "spec", "selector") as Record<string, string> | undefined;
    if (!svcName || !ns || !selector) continue;
    const dep = deployments.find((d) => {
      const labels = (get(d, "spec", "template", "metadata", "labels") as Record<string, string> | undefined) ?? {};
      const depNs = get(d, "metadata", "namespace") as string | undefined;
      return depNs === ns && selectorMatches(selector, labels);
    });
    if (!dep) continue;
    const podLabels = (get(dep, "spec", "template", "metadata", "labels") as Record<string, string> | undefined) ?? {};
    const component = podLabels["speculum.component"];
    if (!component) continue;
    const instance = podLabels["speculum.instance"];
    const containers = (get(dep, "spec", "template", "spec", "containers") as Array<Record<string, unknown>>) ?? [];
    const ports = (containers[0]?.ports as Array<{ containerPort: number }> | undefined) ?? [];
    const containerPort = ports[0]?.containerPort;
    if (containerPort === undefined) continue;
    const depName = get(dep, "metadata", "name") as string | undefined;
    if (!depName) continue;
    const entry = {
      k8s: {
        attach: {
          namespace: ns,
          service: svcName,
          port: containerPort,
          allowChaos: true,
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
// Compose derive path
// ---------------------------------------------------------------------------

type ComposeService = {
  labels?: Record<string, string> | string[];
  ports?: Array<string | { target: number; published?: number | string }>;
};

const parseComposeLabels = (raw: Record<string, string> | string[] | undefined): Record<string, string> => {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      const idx = entry.indexOf("=");
      if (idx < 0) { out[entry] = ""; continue; }
      out[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return out;
  }
  return raw;
};

const parseComposeContainerPort = (
  ports: ComposeService["ports"],
): number | undefined => {
  if (!ports || ports.length === 0) return undefined;
  const first = ports[0]!;
  if (typeof first === "string") {
    // "hostPort:containerPort[/proto]" or "containerPort[/proto]"
    const parts = first.split(":");
    const containerPart = parts[parts.length - 1]!;
    // Strip optional protocol suffix (e.g. "/tcp")
    const portStr = containerPart.split("/")[0]!;
    const n = parseInt(portStr, 10);
    return isNaN(n) ? undefined : n;
  }
  // Long-form: { target: containerPort, published: hostPort }
  const n = typeof first.target === "number" ? first.target : undefined;
  return n;
};

const deriveCompose = (composePath: string): Record<string, unknown> => {
  const text = readFileSync(composePath, "utf8");
  const doc = parseYaml(text) as { services?: Record<string, ComposeService> } | null;
  if (!doc?.services) return {};

  const out: Record<string, unknown> = {};
  for (const [serviceName, svc] of Object.entries(doc.services)) {
    const labels = parseComposeLabels(svc.labels as Record<string, string> | string[] | undefined);
    const component = labels["speculum.component"];
    if (!component) continue;
    const instance = labels["speculum.instance"];
    const hostPort = parseComposeContainerPort(svc.ports);
    const entry = {
      compose: {
        attach: {
          service: serviceName,
          ...(hostPort !== undefined ? { port: hostPort } : {}),
          allowChaos: true,
        },
      },
    };
    ComposeAdapterConfigSchema.parse(entry);
    out[bindingKey(component, instance)] = entry;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const derived: Record<string, unknown> = args.compose
  ? deriveCompose(args.compose)
  : deriveK8s(args.k8s!);

const json = JSON.stringify(derived, null, 2);
if (args.out === "-") process.stdout.write(json + "\n");
else writeFileSync(args.out, json + "\n");
