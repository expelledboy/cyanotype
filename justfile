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

# Run the Kubernetes adapter suite. Requires kubectl + a reachable cluster.
# Defaults to the OrbStack context; override with SPECULUM_K8S_CONTEXT.
test-k8s:
    SPECULUM_K8S_CONTEXT={{ env_var_or_default("SPECULUM_K8S_CONTEXT", "orbstack") }} bun test tests/core/kubernetes.test.ts
