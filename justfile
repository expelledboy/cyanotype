# Cyanotype task runner. `just` lists the recipes below, grouped by substrate
# and ordered fast → heavy. Test recipes follow the grammar:
#   test-{unit|substrate|core}           — pure suite, adapter integration, or both
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

# Lint src/ and tests/. Warnings fail: a rule worth enabling is worth enforcing.
[group('general')]
lint:
    bun run lint

# Apply the lint fixes Biome considers safe.
[group('general')]
lint-fix:
    bunx biome lint --write

# Run the whole test suite.
[group('general')]
test:
    bun test

# Fast unit suite — pure, no Docker, no cluster. The inner loop.
[group('general')]
test-unit:
    bun test tests/core/

# Adapter integration against real Docker and Kubernetes. Needs both.
[group('general')]
test-substrate:
    bun test tests/substrate/

# Both harness suites: unit plus substrate integration.
[group('general')]
test-core: test-unit test-substrate

# Refuse to pass unless this tree is releasable. Checks everything, tags nothing.
[group('general')]
pre-release:
    bun scripts/pre-release.ts

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
    bun scripts/attach-suite.ts docker

# Refuse to pass while Cyanotype-owned Docker containers survive the suite.
[group('docker')]
check-no-leaks:
    bun scripts/check-no-leaks.ts

# Force-remove orphan Cyanotype containers and stale state; for a run killed mid-suite.
[group('docker')]
clean-containers:
    docker ps -aq --filter label=cyanotype.substrate=docker | xargs -r docker rm -f
    rm -rf .cyanotype-env/

# ─── kubernetes substrate ────────────────────────────────────────────────

# Kubernetes adapter suite. Needs kubectl + a reachable cluster.
[group('kubernetes')]
test-adapter-k8s:
    CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/substrate/kubernetes.test.ts

# Kubernetes attach-mode adapter suite (denylist tests run offline; rest need a cluster).
[group('kubernetes')]
test-adapter-k8s-attach:
    CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/substrate/kubernetes-attach.test.ts

# Petstore example suite on OrbStack Kubernetes (Cyanotype deploys the workloads).
[group('kubernetes')]
test-petstore-k8s: load-k8s-images
    CYANOTYPE_ADAPTER=k8s CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun test tests/petstore-example

# Petstore example suite attached to a cluster this recipe deploys and tears down.
[group('kubernetes')]
test-petstore-k8s-attach: deploy-petstore-k8s-attach derive-petstore-attach
    CYANOTYPE_K8S_CONTEXT={{ k8s_context }} bun scripts/attach-suite.ts k8s

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
