default:
    @just --list

# Build test-image dependencies used by tests/petstore-example.
build-test-images:
    docker build -t speculum/petstore-sla:latest tests/support/containers/petstore-sla
    docker build -t speculum/redis-configurable:latest tests/support/containers/redis-configurable

# Force-remove orphan containers and stale state. Safe between bun test invocations
# (cross-invocation attach is a feature; if you want it, skip this and run `bun test` directly).
clean-containers:
    docker ps -aq --filter label=speculum=1 | xargs -r docker rm -f
    rm -rf .speculum-env/

# Type-check.
typecheck:
    bun run typecheck

# Run the full suite. The bun:test preload (tests/preload.ts) handles
# teardown on exit, so no pre-clean is needed for the normal path.
# Use `just clean-containers` as a manual reset if a previous run was
# killed mid-suite (`kill -9`) and left orphan containers.
test:
    bun test

# Run just the harness self-tests (in-mem adapter; no Docker images needed).
test-core:
    bun test tests/core/

# Petstore-example against the real Docker substrate.
test-petstore-docker:
    SPECULUM_ADAPTER=docker bun test tests/petstore-example

# Petstore-example against the in-process fakes (no Docker needed).
test-petstore-memory:
    SPECULUM_ADAPTER=memory bun test tests/petstore-example

# Make test images visible to the OrbStack Kubernetes cluster. OrbStack
# shares its containerd image store with the host Docker daemon, so this
# recipe is build-test-images + a sanity check — no `docker save | ctr import`
# step is needed. For non-OrbStack clusters (kind, k3d, EKS) image loading
# would require `kind load`, `k3d image import`, or a registry push.
load-k8s-images: build-test-images
    @docker image inspect speculum/petstore-sla:latest >/dev/null 2>&1 || (echo "petstore-sla image missing"; exit 1)
    @docker image inspect speculum/redis-configurable:latest >/dev/null 2>&1 || (echo "redis-configurable image missing"; exit 1)
    @echo "OrbStack shares host Docker images with k8s — images present, no import needed."

# Petstore-example against OrbStack Kubernetes (D-020 Service-per-Pod DNS).
test-petstore-k8s: load-k8s-images
    SPECULUM_ADAPTER=k8s SPECULUM_K8S_CONTEXT={{ env_var_or_default("SPECULUM_K8S_CONTEXT", "orbstack") }} bun test tests/petstore-example

# Run the Kubernetes adapter suite. Requires kubectl + a reachable cluster.
# Defaults to the OrbStack context; override with SPECULUM_K8S_CONTEXT.
test-k8s:
    SPECULUM_K8S_CONTEXT={{ env_var_or_default("SPECULUM_K8S_CONTEXT", "orbstack") }} bun test tests/core/kubernetes.test.ts

# Run the Kubernetes attach-mode suite. Denylist tests run without a cluster;
# integration tests require kubectl + a reachable cluster and apply
# tests/support/k8s/attach-fixture.yaml into namespace `speculum-attach-tests`
# (cleaned up in afterAll).
test-k8s-attach:
    SPECULUM_K8S_CONTEXT={{ env_var_or_default("SPECULUM_K8S_CONTEXT", "orbstack") }} bun test tests/core/kubernetes-attach.test.ts
