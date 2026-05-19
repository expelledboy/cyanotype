#!/usr/bin/env bun
/**
 * EXAMPLE derive script — walk Kubernetes manifests and emit a Speculum
 * adapter-override JSON keyed by Speculum binding name.
 *
 * Developers write their own (Terraform state, Helm template output, etc.);
 * this is intentionally a thin reference implementation pointed at static
 * YAML so the petstore-example suite has a load-bearing demo of the
 * declaration-merge → derived.json → env.ts flow.
 *
 * Usage: bun tests/petstore-example/scripts/derive-speculum.ts \
 *          --k8s tests/support/k8s/petstore-attach/all.yaml \
 *          --out tests/petstore-example/derived.json
 */

import { parseAllDocuments } from "yaml";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { K8sAdapterConfigSchema } from "../../../src/adapters/kubernetes";

type Doc = Record<string, unknown>;

const args = (() => {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const k8s = get("--k8s");
  const out = get("--out");
  if (!k8s || !out) {
    console.error("usage: derive-speculum.ts --k8s <dir-or-file> --out <file-or->");
    process.exit(2);
  }
  return { k8s, out };
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

const docs = loadDocs(args.k8s);
const deployments = docs.filter((d) => d.kind === "Deployment");
const services = docs.filter((d) => d.kind === "Service");

const derived: Record<string, unknown> = {};
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
  derived[bindingKey(component, instance)] = entry;
}

const json = JSON.stringify(derived, null, 2);
if (args.out === "-") process.stdout.write(json + "\n");
else writeFileSync(args.out, json + "\n");
