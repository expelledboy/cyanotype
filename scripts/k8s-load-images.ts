#!/usr/bin/env bun
/**
 * Make this repository's locally built images visible to the Kubernetes
 * cluster the suites are about to run against.
 *
 * WHETHER THAT NEEDS DOING AT ALL DEPENDS ON THE CLUSTER, which is the whole
 * reason this is a script. OrbStack and Docker Desktop run Kubernetes against
 * the same image store as the host Docker daemon, so an image you just built
 * is already there and copying it would be a no-op. kind gives each node its
 * own containerd store, so an image that is not copied in is simply absent —
 * and because the manifests set `imagePullPolicy: IfNotPresent`, absent means
 * the kubelet tries to pull `cyanotype/petstore-sla:latest` from a registry
 * that has never heard of it.
 *
 * WHAT THAT FAILURE LOOKS LIKE WITHOUT THIS SCRIPT, measured on kind: the Pod
 * sits in `Pending`, the adapter waits out its readiness budget, and sixty
 * seconds later it raises `k8s_pod_not_ready` naming the Pod. Every word of
 * that is true and none of it says "the image was never loaded". A named
 * refusal here, before anything is deployed, costs a second instead.
 *
 * DETECTION IS BY CONTEXT NAME, which is a heuristic and is why the override
 * exists. It is a sound one for the three cases it names: kind always prefixes
 * its contexts with `kind-`, and the two shared-store runtimes have fixed
 * context names. Anything else refuses rather than guessing, because guessing
 * wrong here is the sixty-second mystery above.
 *
 * Refusal follows the repository's gate contract: silent and exit 0 when the
 * cluster can see the images, otherwise the whole story between two `[GATE]`
 * lines and a non-zero exit.
 */

const CONTEXT = process.env.CYANOTYPE_K8S_CONTEXT ?? "kind-cyanotype";
const OVERRIDE = process.env.CYANOTYPE_K8S_IMAGE_LOADER;

/**
 * The images this repository builds itself. Images the fixtures pull from a
 * public registry are not listed: the cluster fetches those the ordinary way.
 */
const IMAGES = [
  "cyanotype/petstore-sla:latest",
  "cyanotype/redis-configurable:latest",
] as const;

const run = (cmd: string[]) =>
  Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

const fail = (lines: string[]): never => {
  console.error("[GATE] k8s-load-images");
  for (const l of lines) console.error(l);
  console.error("[GATE] k8s-load-images");
  process.exit(1);
};

// A context that does not exist is the common first-run state, and the two
// remedies pull in opposite directions — create the standard cluster, or point
// at one you already have. Naming only one of them sends half of readers the
// wrong way.
const reachable = run(["kubectl", "--context", CONTEXT, "get", "nodes"]);
if (reachable.exitCode !== 0) {
  fail([
    `No reachable cluster on kubectl context "${CONTEXT}".`,
    "",
    reachable.stderr.toString().trim(),
    "",
    "This repository's Kubernetes recipes default to the kind cluster that",
    "`just kind-up` creates. Either run that, or set CYANOTYPE_K8S_CONTEXT to a",
    "cluster you already have — `kubectl config get-contexts` lists them.",
  ]);
}

const missing = IMAGES.filter(
  (i) => run(["docker", "image", "inspect", i]).exitCode !== 0,
);
if (missing.length > 0) {
  fail([
    "Built images are missing from the host Docker daemon:",
    "",
    ...missing.map((i) => `  ${i}`),
    "",
    "Run `just build-test-images`. Nothing can be loaded into a cluster before",
    "it exists locally, whichever loader this cluster needs.",
  ]);
}

type Loader = { kind: "none"; why: string } | { kind: "kind"; cluster: string };

const detect = (): Loader | null => {
  if (OVERRIDE === "none") return { kind: "none", why: `CYANOTYPE_K8S_IMAGE_LOADER=none` };
  if (OVERRIDE === "kind") return { kind: "kind", cluster: CONTEXT.replace(/^kind-/, "") };
  if (CONTEXT === "orbstack") return { kind: "none", why: "OrbStack shares its image store with host Docker" };
  if (CONTEXT === "docker-desktop") return { kind: "none", why: "Docker Desktop shares its image store with host Docker" };
  if (CONTEXT.startsWith("kind-")) return { kind: "kind", cluster: CONTEXT.slice("kind-".length) };
  return null;
};

const loader = detect();
if (loader === null) {
  fail([
    `Cannot tell how to get images into the cluster on context "${CONTEXT}".`,
    "",
    "Recognised without help: `orbstack` and `docker-desktop`, which share the",
    "host Docker image store and need no copy, and any `kind-*` context, which",
    "needs `kind load docker-image`.",
    "",
    "Set CYANOTYPE_K8S_IMAGE_LOADER to say which applies here:",
    "  none   this cluster already sees images built by the host Docker daemon",
    "  kind   this is a kind cluster (its name is the context minus `kind-`)",
    "",
    "Neither fits a remote cluster: it can only pull from a registry both it",
    "and you can reach, so push the images there and reference them by that",
    "name instead.",
  ]);
}

if (loader.kind === "none") process.exit(0);

const loaded = run(["kind", "load", "docker-image", ...IMAGES, "--name", loader.cluster]);
if (loaded.exitCode !== 0) {
  fail([
    `\`kind load docker-image\` failed for cluster "${loader.cluster}".`,
    "",
    `${loaded.stdout.toString()}${loaded.stderr.toString()}`.trim(),
    "",
    `The cluster name is the kubectl context "${CONTEXT}" minus its \`kind-\``,
    "prefix. `kind get clusters` lists what actually exists; a mismatch here",
    "means the context outlived the cluster it was created for.",
  ]);
}
