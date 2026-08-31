#!/usr/bin/env bun
/**
 * Create the local Kubernetes cluster this repository's k8s recipes default to.
 *
 * IDEMPOTENT: an existing cluster of the same name is left alone. `kind create`
 * errors on a name it already has, which would make `just kind-up` a command
 * you can only run once — wrong for something every k8s recipe wants to
 * depend on.
 *
 * IT WAITS TWICE, AND THE SECOND WAIT IS THE LOAD-BEARING ONE. `kind create
 * --wait` waits for the NODE to report Ready, and CoreDNS is still
 * ContainerCreating when that returns — measured, not assumed. Deploy mode
 * wires cross-component traffic through Service DNS (D-020), so a suite
 * starting inside that window watches its components fail readiness and
 * reports a timeout naming the component rather than the DNS it could not
 * resolve.
 */

const CONTEXT = process.env.CYANOTYPE_K8S_CONTEXT ?? "kind-cyanotype";
const CLUSTER = CONTEXT.replace(/^kind-/, "");

const run = (cmd: string[]) =>
  Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });

const existing = Bun.spawnSync(["kind", "get", "clusters"], { stdout: "pipe", stderr: "pipe" });
const names = existing.stdout.toString().split("\n").map((l) => l.trim());

if (!names.includes(CLUSTER)) {
  const created = run(["kind", "create", "cluster", "--name", CLUSTER, "--wait", "120s"]);
  if (created.exitCode !== 0) process.exit(created.exitCode ?? 1);
}

const dns = run([
  "kubectl", "--context", CONTEXT, "-n", "kube-system",
  "wait", "--for=condition=Ready", "pods", "--all", "--timeout=120s",
]);
process.exit(dns.exitCode ?? 1);
