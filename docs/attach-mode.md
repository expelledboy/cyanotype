# Attach mode

Connect Speculum tests to workloads that are already running — no deploy from the harness, no test-owned lifecycle. The workloads can be a Kubernetes cluster managed by Helm or Terraform, or a Docker Compose stack spun up by a developer or a CI job. Speculum reads the running substrate, the developer's derive script translates whatever the source of truth is into a small JSON file, and that JSON threads verbatim into the Bindings.

This document is the developer-facing walkthrough for that flow across both supported substrates: Kubernetes and Docker Compose. The decision records that back it are [D-018](decisions.md#d-018-kubernetes-adapter--attach-mode-discovers-via-service-refuses-cluster-mutation) (K8s denylist), [D-019](decisions.md#d-019-kubectl-shellout-not-kubernetesclient-node-for-the-kubernetes-adapter) (kubectl shellout), [D-021](decisions.md#d-021-attach-mode-port-stability-via-local-port-claim-watch-driven-respawn) (reconnection layer), [D-022](decisions.md#d-022-adapter-specific-binding-config-via-typescript-declaration-merging) (per-Binding override shape), [D-023](decisions.md#d-023-attach-mode-chaos-via-kubectl-scale-against-a-named-deployment-opt-in) (K8s chaos opt-in), [D-025](decisions.md#d-025-docker-compose-attach-mode-adapter-discovery-guard) (Docker Compose adapter + discovery + guard), and [D-026](decisions.md#d-026-docker-compose-attach-chaos-via-docker-stopstart) (Compose chaos via docker stop/start).

## When to use attach mode

### Kubernetes

Use K8s attach mode when:

- You want to smoke-test against an existing staging / UAT / dev cluster without rolling its workloads from your test runner.
- You want to verify the Blueprint contract against a deployment you don't own — a prior version on staging, a vendor build, a Helm chart you're evaluating.
- Your test environment has long-lived state (databases with seeded data, queues with subscribers) that test-owned lifecycle would destroy on every run.
- You're running integration tests in CI that piggyback on a real shared cluster.

Use **deploy** mode instead (`createK8sAdapter({ mode: "deploy" })`) when:

- The harness should own the full lifecycle of every component.
- Tests need isolated, hermetic environments per run.
- Resilience tests need pod-level chaos and you're not willing to grant scale RBAC against the target namespace.

### Docker Compose

Use Docker Compose attach mode when:

- A `docker compose up` stack is already running and you want to run the SLA suite against it without the harness taking ownership.
- You want to verify Blueprint contracts against a Compose stack defined by another team or tool.
- You're running CI on a machine where Compose is the natural substrate and a full K8s cluster is not available.

Use **deploy** mode instead (`createDockerAdapter({ mode: "deploy" })`) when:

- The harness should own the full container lifecycle for the test run.
- Tests need hermetic, per-run environments.

**Hard constraint:** services under test MUST publish their ports to the host using `ports:` in the Compose file. A service that only uses `expose:` (internal-only) cannot be reached by Speculum and will fail at attach time with `compose_attach_service_not_found` or `port_not_bound`.

## The flow at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Substrate state (already running)                              │
│  K8s: Deployment / Service / ConfigMap                          │
│  Compose: containers with com.docker.compose.* labels           │
└────────────────────────────────┬────────────────────────────────┘
                                 │  developer-owned
                                 ▼
                  ┌───────────────────────────────┐
                  │  Derive script                │
                  │  (parse YAML / Compose / …)   │
                  └────────────────┬──────────────┘
                                   │  emits
                                   ▼
                  ┌───────────────────────────────┐
                  │  derived.json                 │
                  │  (K8s) or derived-compose.json│
                  │  flat map, keyed by           │
                  │  <component>[.<instance>]     │
                  └────────────────┬──────────────┘
                                   │  loaded + validated at module init
                                   ▼
                  ┌───────────────────────────────┐
                  │  env.ts                       │
                  │  bind(..., { adapter:         │
                  │    derived[key] })            │
                  └────────────────┬──────────────┘
                                   │  Speculum runs
                                   ▼
                          test file unchanged
```

Five things to notice:

1. **Speculum doesn't deploy.** The substrate state pre-exists.
2. **The derive script is yours.** Speculum ships one example (`tests/petstore-example/scripts/derive-speculum.ts`) that handles both K8s and Compose; your project writes one for its actual source of truth.
3. **The JSON shape is `AdapterConfig` itself.** No envelope, no wrapper. `derived[key]` is what `bind()` accepts on its `adapter` field, verbatim.
4. **env.ts validates at startup.** Missing keys throw before any test runs, with the missing names listed — no silent fallback to convention discovery.
5. **The test file is unchanged.** Same Blueprint surface, same assertions, same chaos calls. Only the adapter wiring differs.

## Override shape

### Kubernetes — `k8s.attach.*`

The shape lives in `src/adapters/kubernetes.ts`, extended into the open `AdapterConfig` interface via TypeScript declaration merging (D-022). The runtime validator is exported:

```ts
import { K8sAdapterConfigSchema } from "speculum/adapters/kubernetes";

// equivalent to:
z.object({
  k8s: z.object({
    attach: z.object({
      namespace: z.string().optional(),
      service: z.string().optional(),
      port: z.number().optional(),
      allowChaos: z.boolean().optional(),
      deployment: z.string().optional(),
    }).optional(),
  }).optional(),
});
```

Per-field semantics:

| Field | When to set | What happens if omitted |
|---|---|---|
| `namespace` | The target workload lives in a different namespace than the adapter default | Falls back to the adapter's constructor `namespace` option |
| `service` | The cluster's Service name doesn't match `<component>[-<instance>]` | Falls back to label-derived convention (`speculum.component` + optional `speculum.instance` labels on `StartSpec`) |
| `port` | The container port to forward to | Falls back to the first port on the resolved Service |
| `allowChaos` | The Binding's tests need `chaos.stop / start / restart` | Defaults to `false`. Chaos calls throw `chaos_unsupported_in_attach_mode` |
| `deployment` | **Required** when `allowChaos: true` | If unset with `allowChaos: true`, `start` throws `k8s_attach_deployment_required` |

Per-field fallback means a partial override is honoured: setting only `service` keeps the convention-based namespace and adapter port discovery.

### Docker Compose — `compose.attach.*`

The shape lives in `src/adapters/docker.ts`, also extended via declaration merging. The runtime validator is exported:

```ts
import { ComposeAdapterConfigSchema } from "speculum/adapters/docker";

// equivalent to:
z.object({
  compose: z.object({
    attach: z.object({
      project: z.string().optional(),
      service: z.string().optional(),
      containerNumber: z.number().optional(),
      port: z.number().optional(),
      allowChaos: z.boolean().optional(),
    }).optional(),
  }).optional(),
});
```

Per-field semantics:

| Field | When to set | What happens if omitted |
|---|---|---|
| `project` | The Compose project name differs from the adapter constructor's `project` option | Falls back to `opts.project` on `createDockerAdapter(...)`. If neither is set, throws `compose_attach_project_required` |
| `service` | The Compose service name doesn't match `<component>[-<instance>]` | Falls back to the `speculum.component` label (+ optional `speculum.instance`) on the container |
| `containerNumber` | The target service scales to multiple replicas and you need a specific one | Defaults to `1` (the first replica) |
| `port` | The container port Speculum should read from `NetworkSettings.Ports` | Falls back to all ports declared in `spec.ports` |
| `allowChaos` | The Binding's tests need `chaos.stop / start` | Defaults to `false`. Chaos calls throw `attach_mode_violation` |

There is no `deployment` field for Compose — the container itself is the unit of chaos (`docker stop` / `docker start`).

## Anatomy of the derived JSON

### derived.json (Kubernetes)

`tests/petstore-example/derived.json` shows the canonical shape. Three entries:

```json
{
  "redis.primary": {
    "k8s": {
      "attach": {
        "namespace": "speculum-petstore-attach",
        "service": "cache-leader",
        "port": 6379,
        "allowChaos": true,
        "deployment": "cache-leader"
      }
    }
  },
  "petstore.one": {
    "k8s": {
      "attach": {
        "namespace": "speculum-petstore-attach",
        "service": "pet-svc-1",
        "port": 8080,
        "allowChaos": true,
        "deployment": "pet-svc-1"
      }
    }
  },
  "nginx": {
    "k8s": {
      "attach": { "namespace": "speculum-petstore-attach", "service": "front-door", "port": 8080, "allowChaos": true, "deployment": "front-door" }
    }
  }
}
```

### derived-compose.json (Docker Compose)

`tests/petstore-example/derived-compose.json` follows the same keying convention, but under `compose.attach`:

```json
{
  "redis.primary": {
    "compose": {
      "attach": {
        "service": "redis-primary",
        "port": 6379,
        "allowChaos": true
      }
    }
  },
  "petstore.one": {
    "compose": {
      "attach": {
        "service": "petstore-one",
        "port": 8080,
        "allowChaos": true
      }
    }
  },
  "nginx": {
    "compose": {
      "attach": { "service": "nginx", "port": 8080, "allowChaos": true }
    }
  }
}
```

The keying convention is `<component>` for single-instance Bindings, `<component>.<instance>` for multi-instance ones. That matches how Speculum names things internally — your env.ts just looks the key up.

This convention is not load-bearing on Speculum itself: the framework only sees one `AdapterConfig` object per `bind()` call. The keying is purely a contract between *your* derive script and *your* env.ts. The flat map shown above is what the petstore-example uses; you can organise your derive output as one file per Binding, one file per component, or anything else. The framework consumes the values, not the structure.

## Example: deriving from Kubernetes YAML

The reference script at `tests/petstore-example/scripts/derive-speculum.ts` accepts `--k8s <dir-or-file>` and walks K8s manifests:

```sh
bun tests/petstore-example/scripts/derive-speculum.ts \
  --k8s tests/support/k8s/petstore-attach/all.yaml \
  --out tests/petstore-example/derived.json
```

The matching logic is the load-bearing part:

```ts
// For each Service, find the Deployment whose pod-template labels
// satisfy the Service's selector.
const dep = deployments.find((d) => {
  const labels = get(d, "spec", "template", "metadata", "labels") ?? {};
  const depNs = get(d, "metadata", "namespace");
  return depNs === ns && selectorMatches(selector, labels);
});

// The component / instance keys come from the pod template's labels.
const component = podLabels["speculum.component"];
const instance  = podLabels["speculum.instance"];   // optional
```

The prerequisite is that pod templates carry `speculum.component` and (where applicable) `speculum.instance` labels. The petstore-attach demo's YAML (`tests/support/k8s/petstore-attach/all.yaml`) shows this — every Deployment pod template carries both. Adding these labels to existing Helm charts or Terraform-managed Deployments is usually a one-line annotation; if you can't modify the deployment, fall back to name-based heuristics in your own script.

Each emitted entry is validated against the zod schema before being written:

```ts
import { K8sAdapterConfigSchema } from "../../../src/adapters/kubernetes";
// ...
K8sAdapterConfigSchema.parse(entry);
derived[bindingKey(component, instance)] = entry;
```

Failure here halts the derive — a malformed entry would otherwise pass into env.ts and produce a confusing downstream error.

## Example: deriving from a Docker Compose file

The same reference script accepts `--compose <file>` and walks a Compose YAML:

```sh
bun tests/petstore-example/scripts/derive-speculum.ts \
  --compose tests/support/compose/petstore-attach/compose.yaml \
  --out tests/petstore-example/derived-compose.json
```

The matching logic reads `speculum.component` / `speculum.instance` labels from each service:

```ts
for (const [serviceName, svc] of Object.entries(doc.services)) {
  const labels = parseComposeLabels(svc.labels);
  const component = labels["speculum.component"];
  if (!component) continue;
  const instance = labels["speculum.instance"];
  // ...emit { compose: { attach: { service: serviceName, port, allowChaos: true } } }
  ComposeAdapterConfigSchema.parse(entry);
  out[bindingKey(component, instance)] = entry;
}
```

The prerequisite is that each service in the Compose file carries a `speculum.component` label. Services without this label are silently skipped. The port is read from the first entry in `ports:` — which must use the published `host:container` form, not bare `expose:`.

Each emitted entry is validated against `ComposeAdapterConfigSchema` before being written, halting the derive for any malformed entry.

## Example: deriving from Terraform (sketch)

The shape is the same; the source is different. Sketch using `terraform show -json`:

```sh
terraform show -json > tfstate.json
jq '
  .values.root_module.resources[]
  | select(.type == "kubernetes_service_v1")
  | {
      key: .values.metadata[0].labels["speculum.component"]
        + (.values.metadata[0].labels["speculum.instance"] // "" | if . == "" then "" else "." + . end),
      value: {
        k8s: { attach: {
          namespace:  .values.metadata[0].namespace,
          service:    .values.metadata[0].name,
          port:       .values.spec[0].port[0].port,
          deployment: .values.metadata[0].labels["speculum.deployment"]
        } }
      }
    }
' tfstate.json | jq -s 'from_entries' > derived.json
```

(In practice you'd write this as a typed Bun/Node/Python script with proper validation; the jq form just sketches the projection.) Real Terraform projects often have richer information — you can derive `allowChaos` from a workspace name, point `deployment` at a `kubernetes_deployment_v1` resource address joined by selector, and so on.

## Example: deriving from Helm (sketch)

Render the chart and walk the manifest stream like the K8s YAML example:

```sh
helm template my-release ./chart --values prod-values.yaml \
  | bun tests/petstore-example/scripts/derive-speculum.ts --k8s /dev/stdin --out derived.json
```

The reference script reads `/dev/stdin` via the same path handling (treat `-` or pipe the helm output to a temp file). If the chart's templates don't include `speculum.component` labels, override them with `--set podLabels."speculum\.component"=…`.

The pattern recurs: whatever your source of truth is, render it to something the script can walk, match Services to backing workloads, and emit the same shape.

## env.ts integration

`tests/petstore-example/env.ts` shows the consumer side for both substrates. Two pieces matter: load-time validation and per-Binding threading.

### Kubernetes — `loadDerived()` / `IS_K8S_ATTACH`

Load:

```ts
import { K8sAdapterConfigSchema } from "../../src/adapters/kubernetes";
import type { AdapterConfig } from "../../src/index";

const EXPECTED_KEYS = ["petstore.one","petstore.two","petstore.three",
                       "redis.primary","redis.replica","nginx"] as const;

const loadDerived = (): Record<string, AdapterConfig> => {
  const p = join(import.meta.dir, "derived.json");
  if (!existsSync(p)) throw { kind: "derived_json_missing", path: p };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const out: Record<string, AdapterConfig> = {};
  const missing: string[] = [];
  for (const k of EXPECTED_KEYS) {
    const entry = parsed[k];
    if (!entry) { missing.push(k); continue; }
    out[k] = K8sAdapterConfigSchema.parse(entry) as AdapterConfig;
  }
  if (missing.length > 0) throw { kind: "derived_json_missing_keys", missing };
  return out;
};

const derived = IS_K8S_ATTACH ? loadDerived() : {};
```

### Docker Compose — `loadDerivedCompose()` / `IS_DOCKER_ATTACH`

Load:

```ts
import { ComposeAdapterConfigSchema } from "../../src/adapters/docker";

const loadDerivedCompose = (): Record<string, AdapterConfig> => {
  const p = join(import.meta.dir, "derived-compose.json");
  if (!existsSync(p)) throw { kind: "derived_json_missing", path: p };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const out: Record<string, AdapterConfig> = {};
  const missing: string[] = [];
  for (const k of EXPECTED_KEYS) {
    const entry = parsed[k];
    if (!entry) { missing.push(k); continue; }
    out[k] = ComposeAdapterConfigSchema.parse(entry) as AdapterConfig;
  }
  if (missing.length > 0) throw { kind: "derived_json_missing_keys", missing };
  return out;
};

const derived: Record<string, AdapterConfig> = IS_K8S_ATTACH
  ? loadDerived()
  : IS_DOCKER_ATTACH
  ? loadDerivedCompose()
  : {};
const adapterFor = (key: string): AdapterConfig | undefined =>
  (IS_K8S_ATTACH || IS_DOCKER_ATTACH) ? derived[key] : undefined;
```

### Threading (both substrates)

```ts
bind(petstoreBlueprint, {
  image: "...", version: "...", config: {...}, env: {...}, ports: {...},
  adapter: adapterFor(`petstore.${instance}`),    // verbatim
});
```

Why the load-time validation matters: without `EXPECTED_KEYS`, a missing entry would surface as `derived[key] === undefined`, which `bind()` accepts (the `adapter` field is optional). The adapter would then fall back to convention-based discovery and fail later with a `*_service_not_found` whose root cause is two layers removed from the actual problem (your derive script didn't emit that key). Throwing on the missing-key list at startup keeps the failure mode honest.

## Real chaos under attach mode

### Kubernetes

Attach mode (D-018) refuses every cluster-mutating verb by default. The chaos opt-in (D-023) lifts that for one verb (`scale`), against one named Deployment, on the per-Binding kubectl client.

Set both fields:

```ts
adapter: {
  k8s: {
    attach: {
      namespace: "speculum-petstore-attach",
      service:   "cache-leader",
      port:      6379,
      allowChaos: true,
      deployment: "cache-leader",
    },
  },
},
```

Behaviour:

- `chaos.stop("redis", "primary")` pauses the D-021 reconnection wrapper (kills the current port-forward, holds the local port), then `kubectl scale deployment/cache-leader --replicas=0`, then polls the Service's EndpointSlice until zero endpoints are Ready (30s timeout).
- `chaos.start("redis", "primary")` `kubectl scale --replicas=1`, polls until ≥1 Ready endpoint, then resumes the reconnection wrapper which re-resolves a Ready Pod and respawns `kubectl port-forward` against the same local port.
- `chaos.restart(...)` is stop + start sequenced.
- Any chaos call without both `allowChaos: true` and `deployment` throws (`chaos_unsupported_in_attach_mode` or `k8s_attach_deployment_required`).

Why this matters: the outage is observable to every consumer *inside the cluster*. When `cache-leader` has zero Ready endpoints, the petstore Pods (in the same cluster) actually see their redis-primary endpoint disappear via cluster DNS, and their writes return 503 honestly. A network-seam mechanism would leave in-cluster traffic untouched, and resilience tests would pass trivially.

RBAC implication: the target namespace needs `apps/deployments` `get` and `apps/deployments/scale` `get, patch`. See [`k8s-rbac.md`](k8s-rbac.md#attach-mode--chaos-opt-in-d-023) for the paste-ready Role addendum.

### Docker Compose

Compose attach mode blocks all destructive operations by default (D-025). Setting `allowChaos: true` on a Binding opts it in to real `docker stop` / `docker start` against the discovered container (D-026).

```ts
adapter: {
  compose: {
    attach: {
      service:    "redis-primary",
      port:       6379,
      allowChaos: true,
    },
  },
},
```

Behaviour:

- `chaos.stop("redis", "primary")` calls `docker stop` on the matching container and marks the binding as paused. The container is stopped but not removed.
- `chaos.start("redis", "primary")` calls `docker start` on the same container, refreshes the port mapping, and marks the binding as resumed.
- `chaos.restart(...)` is stop + start sequenced.
- Any chaos call on a Binding whose `allowChaos` is unset or false throws `attach_mode_violation`.

There is no `deployment` field — the container is the chaos unit directly. No RBAC is required; chaos operates against the local Docker daemon.

## Running the suite

### Kubernetes

The petstore-attach demo bundles all steps into one recipe:

```sh
# Deploy fixtures, derive override config, run the suite, tear down on exit.
just test-petstore-k8s-attach
```

To inspect intermediate state:

```sh
just deploy-petstore-k8s-attach        # apply tests/support/k8s/petstore-attach/all.yaml
just derive-petstore-attach            # walk YAML, emit tests/petstore-example/derived.json
SPECULUM_ADAPTER=k8s-attach bun test tests/petstore-example/
just teardown-petstore-k8s-attach      # delete namespace
```

The composite recipe runs teardown even when tests fail, so cluster state is not leaked.

For your own project, the equivalent is: ensure your cluster has the workloads running (whatever your normal deploy flow is), run your derive script to produce `derived.json` somewhere env.ts can find it, then `SPECULUM_ADAPTER=k8s-attach bun test`.

### Docker Compose

```sh
# Bring up the Compose stack (once).
docker compose -f tests/support/compose/petstore-attach/compose.yaml up -d

# Derive the override config.
bun tests/petstore-example/scripts/derive-speculum.ts \
  --compose tests/support/compose/petstore-attach/compose.yaml \
  --out tests/petstore-example/derived-compose.json

# Run the suite.
SPECULUM_ADAPTER=docker-attach bun test tests/petstore-example/

# Tear down the stack when done (Speculum never does this for you in attach mode).
docker compose -f tests/support/compose/petstore-attach/compose.yaml down
```

For your own project, the equivalent is: ensure your Compose stack is up and its services publish ports to the host, run your derive script to produce `derived-compose.json`, then `SPECULUM_ADAPTER=docker-attach bun test`.

## Troubleshooting

Errors are thrown as discriminated objects with a `kind` field. The common ones:

### Shared (both substrates)

| Kind | Where | Cause + fix |
|---|---|---|
| `derived_json_missing` | env.ts load | `derived.json` / `derived-compose.json` not found at the expected path. Run your derive step first. |
| `derived_json_missing_keys` | env.ts load | The derive script didn't produce one or more expected Binding keys. Check that services carry the right `speculum.component` / `speculum.instance` labels, or update `EXPECTED_KEYS` if your topology has changed. |
| `attach_mode_violation` | adapter chokepoint | A destructive operation was attempted in attach mode without `allowChaos`. Either set `allowChaos: true` on the Binding, or switch to deploy mode for that test. |

### Kubernetes-specific (`k8s_attach_*`)

| Kind | Where | Cause + fix |
|---|---|---|
| `chaos_unsupported_in_attach_mode` | adapter `stop` | `chaos.*` called on a Binding whose `allowChaos` is unset or false. Set `allowChaos: true` and `deployment: <name>`. |
| `k8s_attach_deployment_required` | adapter `start` | `allowChaos: true` is set but `deployment` is missing. Add the Deployment name. |
| `k8s_attach_service_not_found` | adapter `start` | The override's `service` (or the convention-derived name) doesn't match any Service in the namespace. Verify the Service exists and RBAC grants `services get`. |
| `k8s_attach_no_ready_endpoints` | adapter `start` | Service exists but `EndpointSlice` has zero Ready endpoints — no running pods back it. `kubectl get pods -n <ns>` to diagnose. |
| `k8s_attach_endpoint_wait_timeout` | chaos.stop / start | The wait for endpoints to drain or repopulate exceeded 30s. Check that the Deployment is actually scalable (RBAC for `deployments/scale`), and that the cluster API server is healthy. |
| `k8s_attach_endpointslice_parse_failed` | adapter | `kubectl get endpointslice -o json` returned malformed JSON. Likely a kubectl version skew — report it. |
| `k8s_attach_reconnect_failed` | reconnection layer | The port-forward subprocess died and three respawn attempts failed. Usually means the target pod was permanently removed (Deployment scaled to 0 outside of chaos, or namespace torn down). |
| `k8s_attach_scale_failed` | chaos.stop / start | `kubectl scale` exited non-zero. Check RBAC (`apps/deployments/scale` `patch`); inspect `stderr` on the error object. |

### Docker Compose-specific (`compose_attach_*`)

| Kind | Where | Cause + fix |
|---|---|---|
| `compose_attach_project_required` | adapter `start` | No project name was supplied — neither in `createDockerAdapter({ project })` nor in `compose.attach.project`. Set one. |
| `compose_attach_service_not_found` | adapter `start` | No container matched the Compose project + service labels. Check that the stack is running (`docker compose ps`) and that the service name matches. |
| `compose_attach_container_not_running` | adapter `start` | The container was found but is not in the `running` state. Start or restart the service before running the suite. |

## See also

- [`README.md`](../README.md#adapters) — adapter matrix and the Worked Example.
- [`design.md`](design.md#adapter-specific-binding-config-d-022) — the type story behind `AdapterConfig` and declaration merging.
- [`k8s-rbac.md`](k8s-rbac.md) — base attach Role + chaos-opt-in addendum.
- [`decisions.md`](decisions.md) — D-018 (K8s denylist), D-019 (kubectl shellout), D-021 (reconnection layer), D-022 (adapter-specific Binding config), D-023 (K8s chaos via scale), D-025 (Compose adapter + discovery + guard), D-026 (Compose chaos via docker stop/start).
- `tests/petstore-example/scripts/derive-speculum.ts` — the reference derive script (handles both `--k8s` and `--compose`).
- `tests/support/k8s/petstore-attach/all.yaml` — the K8s fixture topology (6 workloads, deliberately non-convention names).
- `tests/support/compose/petstore-attach/compose.yaml` — the Docker Compose fixture topology (6 services).
