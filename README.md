# Cyanotype

[![npm version](https://img.shields.io/npm/v/@expelledboy/cyanotype.svg)](https://www.npmjs.com/package/@expelledboy/cyanotype)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#status)

> Run the same integration test against a real Docker container, an in-process simulator, a Kubernetes pod, or an already-running Docker Compose stack — without changing the test.

Cyanotype is a Bun-native blackbox test harness for multi-container service systems. A test consumes a **Component Blueprint** — a typed contract describing what a component exposes (API schemas) and what it observably emits (a log-event catalog). Any **Binding** that satisfies the contract — the real production image, a hand-written in-process simulator, a prior version, a vendor-compatible alternative — is interchangeable. One line at harness wiring flips the substrate.

## Install

```sh
bun add @expelledboy/cyanotype
# or
npm install @expelledboy/cyanotype
```

Bun ≥ 1.3 is required to **run** the test suite (Cyanotype uses `Bun.spawn` and `bun:test`). The library is published as ESM only; consumers can `import` it from Bun, or from Node ≥ 22 (which supports `require()` of ESM modules for CJS callers).

## Quickstart

The whole library is one shape: **define a contract once, then swap which substrate runs it**. Below is a complete runnable test. The Blueprint, the Binding, and the test body are written once; the only thing that changes between Docker, Kubernetes, and an in-memory simulator is the line that creates the adapter.

```ts
// health.test.ts
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  defineBlueprint, bind, iface, http,
  createEnvironment, createSharedEnvs,
  createInMemoryAdapter, createDockerAdapter, createK8sAdapter,
} from "@expelledboy/cyanotype";
import { z } from "zod";

// 1. The contract — substrate-agnostic. No image, no env, no ports.
const routes = {
  ping: { method: "GET", path: "/", response: z.object({ ok: z.boolean() }) },
} as const;

const healthBp = defineBlueprint({
  portNames: ["3000"] as const,
  interface: (_c, _e, ports) => ({
    http: iface({ uri: `http://127.0.0.1:${ports["3000"]}`, protocol: http(routes) }),
  }),
});

// 2. The Binding — pairs the contract with an image identifier.
const health = bind(healthBp, {
  image: "cyanotype-health-example:latest", version: "latest",
  config: {}, env: {}, ports: { "3000": 13000 },
});

// 3. Pick a substrate. Exactly one of the lines below is active — and that is
//    the entire substrate switch. The Binding above never changes; the test
//    below never changes.
const adapter = createDockerAdapter({ sessionId: randomUUID() });
// const adapter = createDockerAdapter({ mode: "attach", project: "<compose project>" });
// const adapter = createK8sAdapter({ mode: "deploy", sessionId: randomUUID() });
// const adapter = createInMemoryAdapter({
//   factories: {
//     "cyanotype-health-example:latest": async () => {
//       const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
//       return { ports: { "3000": server.port }, close: async () => { server.stop(true); } };
//     },
//   },
// });

const shared = createSharedEnvs(
  { app: createEnvironment({ health }) },
  { adapter, stateDir: ".cyanotype-state", mode: "start", getTargetEnv: () => "app" },
);

// 4. The test — substrate-blind. Identical code under every adapter above.
test("health responds", async () => {
  const rt = await shared.ensure("app");
  expect(await rt.health.api.http.ping()).toEqual({ ok: true });
});
```

Reading `rt.health.api.http.ping()` left to right: `health` is the component name
from `createEnvironment({ health })`; `api` is the typed client Cyanotype derives
for you; `http` is the interface key returned by the Blueprint's `interface`
factory; and `ping` is the route key from `routes`. Rename any of those four and
the test stops compiling — that is the point.

The Docker adapter (default above) needs an image to run. This Dockerfile produces one:

```dockerfile
# Dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
RUN printf '%s\n' \
  "Bun.serve({ port: 3000, fetch: () => Response.json({ ok: true }) });" \
  > server.ts
EXPOSE 3000
CMD ["bun", "server.ts"]
```

```sh
docker build -t cyanotype-health-example:latest .
bun test health.test.ts
```

Now swap which `const adapter = …` line is active and re-run the same test:

- **Docker Compose attach** — uncomment `createDockerAdapter({ mode: "attach", ... })`. Point it at an already-running `docker compose up` stack; Cyanotype discovers containers via `com.docker.compose.project`/`com.docker.compose.service` labels and never creates or removes containers. Services must publish their ports to the host (`ports:` in your Compose file). The test code does not change.
- **Kubernetes** — uncomment `createK8sAdapter`. Your kubectl context must point at a cluster that can pull `cyanotype-health-example:latest` (OrbStack mounts the host Docker registry automatically; for `kind`, `kind load docker-image cyanotype-health-example:latest`). Also supports `mode: "attach"` to test against pre-deployed workloads without managing the cluster yourself. The test code does not change.
- **In-memory simulator** — uncomment `createInMemoryAdapter`. No Docker daemon, no cluster — milliseconds per test. The factories map registers a `Bun.serve` fake under the same image key the Binding already declares. The test code does not change.

That is the entire architectural claim — `Blueprint → Binding → Adapter`, with the substrate as the only swappable layer. Everything else in the library is the machinery that makes it true.

## Worked example

```ts
// 1. Declare the Blueprint — contract only, no image, no mounts.
const petstoreBlueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (config, env, ports) => ({
    http: iface({
      uri: `http://localhost:${ports.http}/v1`,
      protocol: http(petstoreRoutes),  // Zod-typed route map
    }),
  }),
  events: petstoreEvents,
  readiness: { interfaceName: "http", path: "/health" },
});

// 2. Write a Binding — substrate-bound instantiation, one per real/sim/version.
const petstore = (cfg: { instanceId: string; httpPort: number }) =>
  bind(petstoreBlueprint, {
    image:     "cyanotype/petstore-sla:latest",
    version:   "latest",
    config:    cfg,
    env:       { INSTANCE_ID: cfg.instanceId, REDIS_PRIMARY_HOST: DOCKER_HOST_DNS },
    ports:     { http: cfg.httpPort },
    logParser: petstoreJsonLogParser,
  });

// 3. Compose the Environment — record of Bindings, reserved-name-checked.
const env = createEnvironment({
  petstore: {
    one:   petstore({ instanceId: "one",   httpPort: 8001 }),
    two:   petstore({ instanceId: "two",   httpPort: 8002 }),
    three: petstore({ instanceId: "three", httpPort: 8003 }),
  },
  redis: { primary: redis({ port: 6379 }), replica: redis({ port: 6380, replicaOf: 6379 }) },
  nginx: nginx({ upstreams: [8001, 8002, 8003] }),
});

// 4. Wire the harness — Adapter picks substrate (real-vs-fake is decided here).
//    Flipping is a one-line edit; tests don't change.
const adapter = createDockerAdapter({ sessionId: randomUUID() });
// const adapter = createInMemoryAdapter({
//   factories: { "cyanotype/petstore-sla:latest": petstoreFake, ... },
// });

export const shared = createSharedEnvs(
  { "petstore-sla": env },
  { adapter, stateDir: ".cyanotype-env", mode: "startOrAttach",
    getTargetEnv: () => "petstore-sla" },
);

// 5. Test consumes the Blueprint surface — substrate- and binding-blind.
test("primary down → 503 → recovery", async () => {
  const runtime = await shared.ensure("petstore-sla");

  await runtime.chaos.stop("redis", "primary");          // typed; "tertiary" is a compile error

  const checkpoint = runtime.petstore.one.events.mark(); // waits start here, not at boot

  await expect(runtime.petstore.one.api.http.createPet({ name: "X" }))
    .rejects.toMatchObject({ status: 503 });

  const evt = await runtime.petstore.one.events.waitFor(
    "PETSTORE_REQUEST",
    { attributes: { status: 503 }, after: checkpoint },
    5_000,
  );
  expect(evt.attributes.method).toBe("POST");
});
```

> The `redis(...)` / `nginx(...)` Binding factories, `petstoreFake`, `petstoreEvents`, `petstoreRoutes`, and the `DOCKER_HOST_DNS` constant in the snippet above are defined in [`tests/petstore-example/env.ts`](tests/petstore-example/env.ts) — that file is the canonical runnable form of this example, with all imports.
>
> The example above wires the **Docker** adapter. The same `env.ts` switches to the in-memory simulator adapter, to Kubernetes (deploy mode, or attach against a pre-deployed cluster), or to Docker Compose attach by changing one constant — see [Adapters](#adapters) for the matrix, and [`docs/attach-mode.md`](docs/attach-mode.md) for the pre-deployed-cluster walkthrough.

## Why this matters

This shape unlocks three things that are hard or impossible with the conventional `docker-compose up && bun test` separation:

- **Fast inner-loop + high-trust outer-loop.** Develop against an in-process simulator binding (milliseconds per test). CI runs the identical suite against the real Docker binding. No two test suites to maintain; no mock-vs-real drift.
- **Cross-implementation contract verification.** Multiple Bindings claiming the same Blueprint can be tested against the same suite — version-to-version, vendor-to-vendor, real-vs-simulator. The Blueprint *is* the cross-implementation contract.
- **Failure-mode coverage as code.** Because the contract requires tests to own container lifecycle, `await runtime.chaos.stop("redis", "primary")` is an `expect()` away. Real failover semantics, primary-down paths, p95 SLA assertions on real traffic — all live in the same test file as the happy path.

## How it differs from existing tools

- **vs. [testcontainers-node](https://node.testcontainers.org/).** Testcontainers is image-first: you ask for an image, it runs. Cyanotype is contract-first: you declare a Blueprint, and *any* binding (real image, in-process fake, K8s pod) can satisfy it. The same suite runs on a simulator OR a real container OR a cluster.
- **vs. [supertest](https://github.com/ladjs/supertest).** Supertest is in-process and protocol-bound to HTTP-against-an-Express-app. Cyanotype exercises real sockets against real containers (or in-process servers reachable over real ports), spans multiple components, and handles topology, mounts, and chaos.
- **vs. [msw](https://mswjs.io/).** MSW intercepts requests at the client. Cyanotype runs the real server (or a real in-process server implementing the same contract) and never mocks the network — the contract is the Blueprint, and the test owns the lifecycle.

## The two halves of the promise

1. **A Blueprint declares a contract** — multi-protocol API surfaces with typed schemas (HTTP today; TCP / SOAP / opaque extensible), plus a typed log-event catalog. The Blueprint carries no `image`, no `mounts`, no `env` values. Substrate-agnostic by construction.
2. **A Binding instantiates the Blueprint against a substrate** — pairs it with `image`, host port assignments, `env`, optional `mounts`, and a per-Binding `logParser` that converts the Binding's specific log format into the Blueprint's typed event catalog. Real images and simulators are interchangeable Bindings.

Read [`docs/axioms.md`](docs/axioms.md) for the seven forces this thesis structurally requires, and [`docs/design.md`](docs/design.md) for how the pieces fit.

## Who this is for

Engineering teams that:

- **Want to test against a contract, not an image.** Multiple implementations satisfy the same Blueprint; the test suite verifies whichever one is bound.
- **Run a fast inner-loop on a simulator + a high-trust outer-loop on the real binding** without rewriting tests.
- **Build multi-container service systems** — micro/macroservices, replication topologies, load-balanced fleets — and need failure-mode coverage as code, not folklore.
- **Use Bun** for the test loop and want a harness that doesn't require Node-only native modules.

## What you can do that you couldn't easily before

| Capability | Without Cyanotype | With Cyanotype |
|---|---|---|
| Same test against real and simulator | Two suites, or mocks that drift | One suite; one-line `harness.ts` swap |
| Contract-typed API client | Hand-written client + drift, or codegen step | Declared once as `HttpRouteMap`; client derived at call site |
| Typed log-event assertions | Regex over stdout | Per-Binding `logParser` → `events.waitFor("NAME", { attributes }, ms)` |
| Multi-instance addressable by name | String lookups, untyped | `runtime.petstore.one`, `.two`, `.three` (compile-checked) |
| Stop a container mid-test | docker CLI from a hook + manual port resolution | `chaos.stop("redis", "primary")` — typed disruption |
| Cross-worker container reuse | Brittle global-setup hooks | Atomic file-claim metadata + dead-container fallback |
| Config files referencing resolved ports | docker-compose templating limits | TypeScript strings, mount-as-content (tmpfile bind mounts) |
| Quantitative SLA assertions on real traffic | Load-test in a separate suite | `expect(stats.p95).toBeLessThanOrEqual(500)` in the integration suite |
| Smoke-test against a pre-deployed staging/UAT cluster | Maintain a parallel test-only env, or run e2e tests by hand | `CYANOTYPE_ADAPTER=k8s-attach` + a developer-owned derive script over your Helm/Terraform output ([walkthrough](docs/attach-mode.md)) |
| Smoke-test against an already-running Docker Compose stack | Separate test stack, or duplicate compose files | `CYANOTYPE_ADAPTER=docker-attach` — discovers containers by label; non-destructive by default ([D-025](docs/decisions.md#d-025), [D-026](docs/decisions.md#d-026)) |
| See where slow provisioning time goes | A silent multi-minute hang during image pull / readiness wait | Opt-in observer stream — typed `image.pull_progress`, `probe.attempt`, per-phase `environment.*` timing ([D-024](docs/decisions.md#d-024-framework-lifecycle-telemetry-via-an-opt-in-observer-stream)) |
| Bring a Docker Compose stack up to date before the suite runs | A bash preflight that fingerprints inputs, runs `compose up --build` on drift, and regenerates per-binding adapter config | `reconcileComposeStack({ project, composeFile, fingerprint, onStale })` + the `cyanotype derive compose` CLI + `loadDerivedCompose(...)` ([D-030](docs/decisions.md#d-030), [D-031](docs/decisions.md#d-031), [D-032](docs/decisions.md#d-032)) |
| Force a rebuild when the image or config changed | Delete `.cyanotype-env/` from outside the library and pray nothing leaks | Bump `Binding.version` — re-ensure stops the live containers, deletes metadata, and re-races the start path ([D-027](docs/decisions.md#d-027)) |
| Catch an attached container running the wrong image | Hand-rolled `docker inspect` comparison in a preflight | `createDockerAdapter({ onImageDrift: "fail" })` — throws `attach_image_drift` with `expected` and `actual` ([D-028](docs/decisions.md#d-028)) |

## Adapters

The Adapter is Cyanotype's substrate seam (D-003). The same test suite runs against any of them.

| Adapter | Substrate | Use case |
|---|---|---|
| `createDockerAdapter` | Real Docker containers via `dockerode` | High-trust integration; default (`mode: "deploy"`) |
| `createDockerAdapter({ mode: "attach", project })` | Pre-running Docker Compose stack — containers discovered via `com.docker.compose.project`/`.service` labels. Per-Binding `compose.attach` overrides for non-convention names; opt-in stop/start chaos via `allowChaos: true` ([D-025](docs/decisions.md#d-025), [D-026](docs/decisions.md#d-026)) | Smoke / contract tests against an existing Compose stack; **refuses writes by default** |
| `createInMemoryAdapter` | In-process simulators (factory registry) | Fast inner loop; CI; no daemon needed |
| `createK8sAdapter({ mode: "deploy" })` | Pods + ConfigMaps + per-Pod Services via `kubectl` | Pre-prod / staging integration; cluster-native parity |
| `createK8sAdapter({ mode: "attach" })` | Pre-deployed workloads (Helm / Terraform / kustomize) discovered via Service. Per-Binding `adapter.k8s.attach` overrides for non-convention names; opt-in real chaos via `kubectl scale` ([D-022](docs/decisions.md#d-022-adapter-specific-binding-config-via-typescript-declaration-merging), [D-023](docs/decisions.md#d-023-attach-mode-chaos-via-kubectl-scale-against-a-named-deployment-opt-in), walkthrough: [`docs/attach-mode.md`](docs/attach-mode.md)) | Smoke / contract tests against an existing cluster; **refuses writes by default** |

The `tests/petstore-example/` SLA suite (15 tests including chaos failover and p95 latency assertions) passes against **all five** substrates. Switch via `CYANOTYPE_ADAPTER=docker|docker-attach|memory|k8s|k8s-attach`.

| Adapter | Suite time |
|---|---|
| in-memory | 0.75s |
| docker | 10.3s |
| docker-attach (Compose) | 10.8s |
| k8s deploy (OrbStack) | 16.4s |
| k8s attach (OrbStack) | 15.2s |

## FAQ

**Does this work with Jest or Vitest?** Not today. Cyanotype's teardown relies on a `bun:test` global preload (`afterAll` in `tests/preload.ts`). A `vitest`/`jest` wrapper is straightforward (it's one `afterAll` hook), but the published package only ships the `bun:test` path.

**Can I use it without Docker?** Yes. The in-memory adapter runs in-process simulators with no daemon at all (the Hello World above needs nothing but Bun). The K8s adapter targets any reachable kubectl context.

**Does it replace testcontainers?** Different goals — see the comparison above. If your need is "spin up a Postgres for one test and tear it down," testcontainers is simpler. If you need contract-typed multi-component topologies that run identically on a simulator and on real infrastructure, Cyanotype is the shape.

**Why is provisioning slow — how do I see what it's doing?** Pass an `observer` when wiring the harness. Cyanotype ships a built-in reporter; gate it behind an env var so local runs and CI opt in explicitly:

```ts
import { createConsoleReporter } from "@expelledboy/cyanotype";

const shared = createSharedEnvs(registry, {
  adapter, stateDir: ".cyanotype-state", mode: "start",
  observer: process.env.CYANOTYPE_OBSERVER ? createConsoleReporter() : undefined,
});
```

`createConsoleReporter()` renders the framework-lifecycle stream as readable stderr lines — substrate connect, image pull (a live progress bar per Docker layer on a TTY), the readiness-probe phase, and per-phase timing:

```
cyanotype  ·  environment starting · 2 component(s)
cyanotype  ✓  substrate   connected · 0ms
cyanotype  ·  petstore    image pulling · …/petstore-sla:latest…
cyanotype  ·  petstore    image ▕████████████▏ 100%
cyanotype  ·  petstore    image pulled · 8.4s
cyanotype  ✗  petstore    probe attempt 3 · ECONNREFUSED · 2.1s
cyanotype  ✓  petstore    ready · 1/2 · 11.0s
cyanotype  ✓  environment ready · 14.7s
```

The stream is also yours to consume directly — pass any `(e: ObserverEvent) => void` for CI annotations or timing dumps. It is distinct from the per-component `events` bus (that one is your *system under test*; this one is the *harness itself*). Opt-in; zero cost when omitted. A throwing reporter is isolated and never breaks provisioning.

> A custom readiness `check()` that returns `false` shows the generic `custom probe returned false`. To see *which* sub-check failed, **throw a tagged error** from `check()` instead — `throw { kind: "zero_ping_failed" }` — and that `kind` appears on the `probe attempt` line. A `check()` that blocks for a long time before returning is shown only as `probe running …` until it resolves; break long work into fast polls that return `false` if you want per-attempt visibility.

See [D-024](docs/decisions.md#d-024-framework-lifecycle-telemetry-via-an-opt-in-observer-stream).

**Linux support?** Yes for the K8s adapter (kubectl shellout — anywhere kubectl works). The Docker adapter works on Linux too; Bindings that use `host.docker.internal` for cross-container traffic need that DNS name configured (`--add-host=host.docker.internal:host-gateway`).

## Status

**Developer preview.** Semver below 1.0 means minor versions may include breaking changes. The Blueprint / Binding / Adapter shape is stable; specific adapter configs may evolve. The current published version lives in [`package.json`](./package.json) and on [npm](https://www.npmjs.com/package/@expelledboy/cyanotype).

Same 15-test SLA suite green across five adapter modes (in-memory, Docker, Docker Compose attach, K8s deploy, K8s attach against a pre-deployed cluster). 15/15 in each. Plus 178/178 core harness self-tests; 13/13 K8s attach tests (denylist + integration including rolling-restart survivability and override-rescues-non-convention-name). Bun-native development; library code is portable to Node consumers. ~5k LoC src, ~4.4k LoC tests. Runtime deps: `zod`, `yaml`, `dockerode`. The K8s adapter uses `kubectl` as a subprocess (D-019) — no Kubernetes client library is taken as a dependency.

## Prerequisites

- [Bun](https://bun.sh) `~1.3` or newer (for development; Node consumers can `npm install` the published package)
- [just](https://github.com/casey/just) — `brew install just`
- **Docker** daemon running, for the Docker adapter (Mac/Windows Docker Desktop, or Linux Docker with `host.docker.internal` configured).
- **`kubectl`** on PATH and a reachable cluster context, for the K8s adapter. OrbStack's local Kubernetes works out of the box; for `kind` or remote clusters see [`docs/k8s-rbac.md`](./docs/k8s-rbac.md).

## Run the tests

```sh
# One-time: build the petstore + redis-configurable test images
just build-test-images

# Five-adapter SLA suite
CYANOTYPE_ADAPTER=docker        bun test tests/petstore-example   # real Docker
CYANOTYPE_ADAPTER=memory        bun test tests/petstore-example   # in-process simulators
CYANOTYPE_ADAPTER=k8s           bun test tests/petstore-example   # real Kubernetes (deploy mode)

# Attach mode against a pre-running Compose stack — brings the stack up, derives
# override config from the Compose file, runs the suite, tears down on exit.
just test-petstore-docker-attach

# Attach mode against a pre-deployed cluster — deploys fixtures, derives
# override config from the YAML, runs the suite, tears down on exit.
# See docs/attach-mode.md for the developer-derive-script flow.
just test-petstore-k8s-attach

# Harness self-tests (no Docker images needed, in-memory adapter only)
just test-core

# K8s adapter self-tests (deploy + attach)
just test-adapter-k8s
just test-adapter-k8s-attach

# Type-check
just typecheck
```

If a `bun test` run is interrupted (Ctrl-C during the integration suite), orphan containers can keep ports allocated. `just clean-containers` force-removes everything labeled `cyanotype.substrate=docker`, and `just check-no-leaks` reports whether any survived.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup, the ADR process, and the code-review checklist. See [`CONVENTIONS.md`](./CONVENTIONS.md) for code style.

## License

MIT — see [`LICENSE`](./LICENSE).
