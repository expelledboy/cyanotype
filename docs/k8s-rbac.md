# Kubernetes adapter — RBAC

The K8s adapter (`src/adapters/kubernetes.ts`) drives `kubectl` via `Bun.spawn` (D-019). Permissions are whatever `kubectl` resolves at the call site — usually a kubeconfig context for local development, or a ServiceAccount token in CI. This file documents the minimum verb / resource combinations each adapter mode needs, plus paste-ready `Role` YAMLs.

## Deploy mode

Creates Pods, ConfigMaps, and one Service per binding (D-017, D-020, D-039 — the Service selects the component/instance and survives pod replacement, so chaos deletes the Pod and leaves the Service standing). Streams logs and exec'es `kubectl port-forward`. Force-deletes everything tagged with the session label on teardown.

| Resource | Verbs |
|---|---|
| `pods` | `create`, `get`, `list`, `watch`, `delete`, `deletecollection` |
| `pods/log` | `get` |
| `pods/portforward` | `create` |
| `configmaps` | `create`, `get`, `list`, `watch`, `delete`, `deletecollection` |
| `services` | `create`, `get`, `list`, `watch`, `delete`, `deletecollection` |

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cyanotype-deploy
  namespace: cyanotype-tests
rules:
  - apiGroups: [""]
    resources: ["pods", "configmaps", "services"]
    verbs: ["create", "get", "list", "watch", "delete", "deletecollection"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/portforward"]
    verbs: ["create"]
```

Bind to a `ServiceAccount` in the same namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cyanotype-deploy
  namespace: cyanotype-tests
subjects:
  - kind: ServiceAccount
    name: cyanotype
    namespace: cyanotype-tests
roleRef:
  kind: Role
  name: cyanotype-deploy
  apiGroup: rbac.authorization.k8s.io
```

## Attach mode

Discovers pre-existing workloads via Services and EndpointSlices (D-018). Opens port-forward and tails logs. **Refuses every write verb** at the `kubectl` chokepoint (`src/adapters/kubectl.ts`) — safe to grant against prod, *unless* one or more Bindings opt in to the chaos extension below.

| Resource | Verbs |
|---|---|
| `services` | `get`, `list`, `watch` |
| `endpointslices` (discovery.k8s.io) | `get`, `list`, `watch` |
| `pods` | `get`, `list`, `watch` |
| `pods/log` | `get` |
| `pods/portforward` | `create` |

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cyanotype-attach
  namespace: <target-namespace>
rules:
  - apiGroups: [""]
    resources: ["services", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/portforward"]
    verbs: ["create"]
```

No write verbs. The adapter's denylist enforces this at the call site, but the RBAC boundary is the durable defence — if an operator grants only this Role, no path through the adapter can mutate the cluster.

## Attach mode + chaos opt-in (D-023)

A Binding can opt in to real cluster chaos by setting both `adapter.k8s.attach.allowChaos: true` and `adapter.k8s.attach.deployment: "<name>"`. When that is in effect, `runtime.chaos.stop / start / restart` for that Binding calls `kubectl scale deployment/<name> --replicas=0` / `--replicas=1` (and waits on the Service's `EndpointSlice`). The denylist lifts *only* the `scale` verb on the per-Binding kubectl client; every other write verb (`apply`, `create`, `delete`, `patch` on arbitrary resources, `replace`, `edit`, `rollout`) remains blocked at the chokepoint.

To grant this, add the following rules **in addition to** the base attach Role for any namespace where chaos opt-in is allowed:

| Resource | Verbs |
|---|---|
| `deployments` (apps) | `get` |
| `deployments/scale` (apps) | `get`, `patch` |

```yaml
# Append these rules to the cyanotype-attach Role above for any namespace
# where Bindings may opt in to chaos.
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    verbs: ["get", "patch"]
```

Whether to grant this is the operator's call. Typical pattern: deny in prod, allow in staging / UAT / dev clusters where chaos testing is intended. The adapter throws `chaos_unsupported_in_attach_mode` at the call site for any Binding that does not opt in; the RBAC boundary backs that up — without `deployments/scale` permission, even a misconfigured Binding cannot mutate the cluster.

See [D-023](decisions.md#d-023-attach-mode-chaos-via-kubectl-scale-against-a-named-deployment-opt-in) for the design rationale (why `scale` rather than `delete pod`) and [`attach-mode.md`](attach-mode.md) for the developer-facing flow.

## Operator notes

- **In-cluster Bun + self-signed CA.** Set `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` so Bun trusts the cluster CA. `kubectl` reads the SA token automatically.
- **Cross-namespace attach.** If the target workload lives in a different namespace than the SA, bind the attach Role into that namespace (the binding's `namespace:` is the resource scope, not the SA scope).
- **Cluster-scoped variants.** For multi-namespace attach (smoke-testing across dev/uat/prod from one runner), promote to `ClusterRole` + `ClusterRoleBinding` with the same rule set.
