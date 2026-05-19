# Kubernetes adapter — RBAC

The K8s adapter (`src/adapters/kubernetes.ts`) drives `kubectl` via `Bun.spawn` (D-019). Permissions are whatever `kubectl` resolves at the call site — usually a kubeconfig context for local development, or a ServiceAccount token in CI. This file documents the minimum verb / resource combinations each adapter mode needs, plus paste-ready `Role` YAMLs.

## Deploy mode

Creates Pods, ConfigMaps, and per-Pod Services (D-017 + D-020). Streams logs and exec'es `kubectl port-forward`. Force-deletes everything tagged with the session label on teardown.

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
  name: speculum-deploy
  namespace: speculum-tests
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
  name: speculum-deploy
  namespace: speculum-tests
subjects:
  - kind: ServiceAccount
    name: speculum
    namespace: speculum-tests
roleRef:
  kind: Role
  name: speculum-deploy
  apiGroup: rbac.authorization.k8s.io
```

## Attach mode

Discovers pre-existing workloads via Services and EndpointSlices (D-018). Opens port-forward and tails logs. **Refuses every write verb** at the `kubectl` chokepoint (`src/adapters/kubectl.ts`) — safe to grant against prod.

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
  name: speculum-attach
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

## Operator notes

- **In-cluster Bun + self-signed CA.** Set `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` so Bun trusts the cluster CA. `kubectl` reads the SA token automatically.
- **Cross-namespace attach.** If the target workload lives in a different namespace than the SA, bind the attach Role into that namespace (the binding's `namespace:` is the resource scope, not the SA scope).
- **Cluster-scoped variants.** For multi-namespace attach (smoke-testing across dev/uat/prod from one runner), promote to `ClusterRole` + `ClusterRoleBinding` with the same rule set.
