# Attach mode

Connect Speculum tests to Kubernetes workloads that are already running — no `kubectl apply` from the harness, no test-owned lifecycle. The workloads can be deployed by Helm, Terraform, kustomize, hand-applied YAML, or anything else. Speculum reads the cluster, the developer's derive script translates whatever the source of truth is into a small JSON file, and that JSON threads verbatim into the Bindings.

This document is the developer-facing walkthrough for that flow. The decision records that back it are [D-018](decisions.md#d-018-kubernetes-adapter--attach-mode-discovers-via-service-refuses-cluster-mutation) (denylist), [D-019](decisions.md#d-019-kubectl-shellout-not-kubernetesclient-node-for-the-kubernetes-adapter) (kubectl shellout), [D-021](decisions.md#d-021-attach-mode-port-stability-via-local-port-claim-watch-driven-respawn) (reconnection layer), [D-022](decisions.md#d-022-adapter-specific-binding-config-via-typescript-declaration-merging) (per-Binding override shape), and [D-023](decisions.md#d-023-attach-mode-chaos-via-kubectl-scale-against-a-named-deployment-opt-in) (chaos opt-in).

## When to use attach mode

Use attach mode when:

- You want to smoke-test against an existing staging / UAT / dev cluster without rolling its workloads from your test runner.
- You want to verify the Blueprint contract against a deployment you don't own — a prior version on staging, a vendor build, a Helm chart you're evaluating.
- Your test environment has long-lived state (databases with seeded data, queues with subscribers) that test-owned lifecycle would destroy on every run.
- You're running integration tests in CI that piggyback on a real shared cluster.

Use **deploy** mode instead (`createK8sAdapter({ mode: "deploy" })`) when:

- The harness should own the full lifecycle of every component.
- Tests need isolated, hermetic environments per run.
- Resilience tests need pod-level chaos and you're not willing to grant scale RBAC against the target namespace.

## The flow at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Cluster state (already running)                                │
│  ─ Deployment / Service / ConfigMap                             │
│  ─ Labels: speculum.component, speculum.instance                │
└────────────────────────────────┬────────────────────────────────┘
                                 │  developer-owned
                                 ▼
                  ┌───────────────────────────────┐
                  │  Derive script                │
                  │  (parse YAML / TF state / …)  │
                  └────────────────┬──────────────┘
                                   │  emits
                                   ▼
                  ┌───────────────────────────────┐
                  │  derived.json                 │
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

1. **Speculum doesn't deploy.** The cluster state pre-exists.
2. **The derive script is yours.** Speculum ships one example (`tests/petstore-example/scripts/derive-speculum.ts`); your project writes one for its actual source of truth.
3. **The JSON shape is `AdapterConfig` itself.** No envelope, no wrapper. `derived[key]` is what `bind()` accepts on its `adapter` field, verbatim.
4. **env.ts validates at startup.** Missing keys throw before any test runs, with the missing names listed — no silent fallback to convention discovery.
5. **The test file is unchanged.** Same Blueprint surface, same assertions, same chaos calls. Only the adapter wiring differs.

## Override shape

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

## Anatomy of derived.json

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

The keying convention is `<component>` for single-instance Bindings, `<component>.<instance>` for multi-instance ones. That matches how Speculum names things internally — your env.ts just looks the key up.

This convention is not load-bearing on Speculum itself: the framework only sees one `AdapterConfig` object per `bind()` call. The keying is purely a contract between *your* derive script and *your* env.ts. The flat map shown above is what the petstore-example uses; you can organise your derive output as one file per Binding, one file per component, or anything else. The framework consumes the values, not the structure.

## Example: deriving from Kubernetes YAML

The reference script at `tests/petstore-example/scripts/derive-speculum.ts` walks a directory (or single file) of K8s manifests and emits the flat map shown above. The matching logic is the load-bearing part:

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

The prerequisite for this generic matcher is that pod templates carry `speculum.component` and (where applicable) `speculum.instance` labels. The petstore-attach demo's YAML (`tests/support/k8s/petstore-attach/all.yaml`) shows this — every Deployment pod template carries both. Adding these labels to existing Helm charts or Terraform-managed Deployments is usually a one-line annotation; if you can't modify the deployment, fall back to name-based heuristics in your own script (e.g. infer component from a `name:` regex).

Each emitted entry is validated against the zod schema before being written:

```ts
import { K8sAdapterConfigSchema } from "../../../src/adapters/kubernetes";
// ...
K8sAdapterConfigSchema.parse(entry);
derived[bindingKey(component, instance)] = entry;
```

Failure here halts the derive — a malformed entry would otherwise pass into env.ts and produce a confusing downstream error.

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

`tests/petstore-example/env.ts` shows the consumer side. Two pieces matter: load-time validation and per-Binding threading.

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
const adapterFor = (key: string): AdapterConfig | undefined =>
  IS_K8S_ATTACH ? derived[key] : undefined;
```

Thread:

```ts
bind(petstoreBlueprint, {
  image: "...", version: "...", config: {...}, env: {...}, ports: {...},
  adapter: adapterFor(`petstore.${instance}`),    // verbatim
});
```

Why the load-time validation matters: without `EXPECTED_KEYS`, a missing entry would surface as `derived[key] === undefined`, which `bind()` accepts (the `adapter` field is optional). The K8s attach adapter would then fall back to convention-based Service discovery and fail later with a `k8s_attach_service_not_found` whose root cause is two layers removed from the actual problem (your derive script didn't emit that key). Throwing on the missing-key list at startup keeps the failure mode honest.

## Real chaos under attach mode

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

Why this matters: the outage is observable to every consumer *inside the cluster*. When `cache-leader` has zero Ready endpoints, the petstore Pods (in the same cluster) actually see their redis-primary endpoint disappear via cluster DNS, and their writes return 503 honestly. A network-seam mechanism (e.g. killing the local port-forward only) would leave in-cluster traffic untouched, and resilience tests would pass trivially.

RBAC implication: the target namespace needs `apps/deployments` `get` and `apps/deployments/scale` `get, patch`. See [`k8s-rbac.md`](k8s-rbac.md#attach-mode--chaos-opt-in-d-023) for the paste-ready Role addendum. The denylist enforces the same constraint at the call site, but the RBAC boundary is the durable defence.

## Running the suite

The petstore-attach demo bundles all four steps into one recipe:

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

## Troubleshooting

Errors are thrown as discriminated objects with a `kind` field. The common ones:

| Kind | Where | Cause + fix |
|---|---|---|
| `derived_json_missing` | env.ts load | `derived.json` not found at the expected path. Run your derive step first. |
| `derived_json_missing_keys` | env.ts load | The derive script didn't produce one or more expected Binding keys. Check that pod templates carry the right `speculum.component` / `speculum.instance` labels, or update `EXPECTED_KEYS` if your topology has changed. |
| `attach_mode_violation` | kubectl chokepoint | A write verb was attempted in attach mode without `allowChaos`. Either set `allowChaos: true` + `deployment` on the Binding, or switch to deploy mode for that test. |
| `chaos_unsupported_in_attach_mode` | adapter `stop` | `chaos.*` called on a Binding whose `allowChaos` is unset or false. Set `allowChaos: true` and `deployment: <name>`. |
| `k8s_attach_deployment_required` | adapter `start` | `allowChaos: true` is set but `deployment` is missing. Add the Deployment name. |
| `k8s_attach_service_not_found` | adapter `start` | The override's `service` (or the convention-derived name) doesn't match any Service in the namespace. Verify the Service exists and RBAC grants `services get`. |
| `k8s_attach_no_ready_endpoints` | adapter `start` | Service exists but `EndpointSlice` has zero Ready endpoints — no running pods back it. `kubectl get pods -n <ns>` to diagnose. |
| `k8s_attach_endpoint_wait_timeout` | chaos.stop / start | The wait for endpoints to drain or repopulate exceeded 30s. Check that the Deployment is actually scalable (RBAC for `deployments/scale`), and that the cluster API server is healthy. |
| `k8s_attach_endpointslice_parse_failed` | adapter | `kubectl get endpointslice -o json` returned malformed JSON. Likely a kubectl version skew — report it. |
| `k8s_attach_reconnect_failed` | reconnection layer | The port-forward subprocess died and three respawn attempts failed. Usually means the target pod was permanently removed (Deployment scaled to 0 outside of chaos, or namespace torn down). |
| `k8s_attach_scale_failed` | chaos.stop / start | `kubectl scale` exited non-zero. Check RBAC (`apps/deployments/scale` `patch`); inspect `stderr` on the error object. |

## See also

- [`README.md`](../README.md#adapters) — adapter matrix and the Worked Example.
- [`design.md`](design.md#adapter-specific-binding-config-d-022) — the type story behind `AdapterConfig` and declaration merging.
- [`k8s-rbac.md`](k8s-rbac.md) — base attach Role + chaos-opt-in addendum.
- [`decisions.md`](decisions.md) — D-018 (denylist), D-019 (kubectl shellout), D-021 (reconnection layer), D-022 (adapter-specific Binding config), D-023 (chaos via scale).
- `tests/petstore-example/scripts/derive-speculum.ts` — the reference derive script.
- `tests/support/k8s/petstore-attach/all.yaml` — the fixture topology (6 workloads, deliberately non-convention names).
