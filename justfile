# Cyanotype task runner. `just` lists the recipes below, grouped by substrate
# and ordered fast → heavy. Test recipes follow the grammar:
#   test-{core}                          — the tests/core/ suite
#   test-{petstore|adapter}-{substrate}  — the example suite, or an adapter suite
# Recipes used only as build steps are hidden; read this file to see them.

# Kubernetes context for every k8s recipe. Override: CYANOTYPE_K8S_CONTEXT=myctx just ...
k8s_context := env("CYANOTYPE_K8S_CONTEXT", "orbstack")

[private]
default:
    @just --list --unsorted

# ─── general ─────────────────────────────────────────────────────────────

# Type-check the project (no tests run).
[group('general')]
typecheck:
    bun run typecheck

# Run the whole test suite.
[group('general')]
test:
    bun test

# Harness functionality tests — exercises adapters/orchestrator directly, not via the example; Docker/K8s tests self-skip when unavailable.
[group('general')]
test-core:
    bun test tests/core/

# ─── memory substrate ────────────────────────────────────────────────────

# Petstore example suite on in-process fakes — no Docker, no cluster.
[group('memory')]
test-petstore-memory:
    CYANOTYPE_ADAPTER=memory bun test tests/petstore-example

# ─── docker substrate ────────────────────────────────────────────────────

# Build the container images the petstore example needs.
[group('docker')]
build-test-images:
    docker build -t cyanotype/petstore-sla:latest tests/support/containers/petstore-sla
    docker build -t cyanotype/redis-configurable:latest tests/support/containers/redis-configurable

# Petstore example suite on the real Docker substrate (Cyanotype starts the containers).
[group('docker')]
test-petstore-docker: build-test-images
    CYANOTYPE_ADAPTER=docker bun test tests/petstore-example

# Petstore example suite attached to a Compose stack this recipe brings up and tears down.
[group('docker')]
test-petstore-docker-attach: up-petstore-docker-attach derive-petstore-docker-attach
    #!/usr/bin/env bash
    # Chain: compose up → derive → test → compose down. Teardown runs even on
    # failure so the Compose stack isn't leaked (attach-mode chaos is real).
    set -u
    CYANOTYPE_ADAPTER=docker-attach bun test tests/petstore-example
    status=$?
    just teardown-petstore-docker-attach
    exit $status

# Force-remove orphan Cyanotype containers and stale state (manual reset).
[group('docker')]
clean-containers:
    # Use this when a previous run was killed mid-suite (kill -9) and leaked
    # containers — the normal path cleans up on its own via tests/preload.ts.
    docker ps -aq --filter label=cyanotype=1 | xargs -r docker rm -f
    rm -rf .cyanotype-env/

# ─── kubernetes substrate ────────────────────────────────────────────────

# Kubernetes adapter suite. Needs kubectl + a reachable cluster.
[group('kubernetes')]
test-adapter-k8s:
    CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/core/kubernetes.test.ts

# Kubernetes attach-mode adapter suite (denylist tests run offline; rest need a cluster).
[group('kubernetes')]
test-adapter-k8s-attach:
    CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/core/kubernetes-attach.test.ts

# Petstore example suite on OrbStack Kubernetes (Cyanotype deploys the workloads).
[group('kubernetes')]
test-petstore-k8s: load-k8s-images
    CYANOTYPE_ADAPTER=k8s CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/petstore-example

# Petstore example suite attached to a cluster this recipe deploys and tears down.
[group('kubernetes')]
test-petstore-k8s-attach: deploy-petstore-k8s-attach derive-petstore-attach
    #!/usr/bin/env bash
    # Chain: deploy → derive → test → delete namespace. Teardown runs even on
    # failure so cluster state isn't leaked (attach-mode chaos is real).
    set -u
    CYANOTYPE_ADAPTER=k8s-attach CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/petstore-example
    status=$?
    just teardown-petstore-k8s-attach
    exit $status

# ─── internal helpers (hidden from `just --list`) ────────────────────────

# Build images and confirm the OrbStack k8s cluster can see them. OrbStack
# shares its image store with host Docker, so no `kind load` / registry push.
[private]
load-k8s-images: build-test-images
    @docker image inspect cyanotype/petstore-sla:latest >/dev/null 2>&1 || (echo "petstore-sla image missing"; exit 1)
    @docker image inspect cyanotype/redis-configurable:latest >/dev/null 2>&1 || (echo "redis-configurable image missing"; exit 1)
    @echo "OrbStack shares host Docker images with k8s — images present, no import needed."

# Apply the petstore-attach fixture stack and wait for it to become Available.
[private]
deploy-petstore-k8s-attach: load-k8s-images
    kubectl --context {{ k8s_context }} apply -f tests/support/k8s/petstore-attach/all.yaml
    kubectl --context {{ k8s_context }} -n cyanotype-petstore-attach wait --for=condition=Available --timeout=180s deployment --all

# Walk the petstore-attach manifests → derived.json for env.ts.
[private]
derive-petstore-attach:
    bun tests/petstore-example/scripts/derive-cyanotype.ts --k8s tests/support/k8s/petstore-attach/all.yaml --out tests/petstore-example/derived.json

# Delete the petstore-attach namespace (k8s-attach teardown).
[private]
teardown-petstore-k8s-attach:
    kubectl --context {{ k8s_context }} delete ns cyanotype-petstore-attach --wait=false --ignore-not-found=true

# Bring up the petstore-attach Compose stack in detached mode.
[private]
up-petstore-docker-attach:
    docker compose -p cyanotype-petstore-attach -f tests/support/compose/petstore-attach/compose.yaml up -d

# Walk the petstore-attach Compose file → derived-compose.json for env.ts.
[private]
derive-petstore-docker-attach:
    bun tests/petstore-example/scripts/derive-cyanotype.ts --compose tests/support/compose/petstore-attach/compose.yaml --out tests/petstore-example/derived-compose.json

# Tear down the petstore-attach Compose stack and its volumes.
[private]
teardown-petstore-docker-attach:
    docker compose -p cyanotype-petstore-attach -f tests/support/compose/petstore-attach/compose.yaml down -v
