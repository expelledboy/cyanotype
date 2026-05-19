# Speculum

> Bun-native test harness built around the **Component Blueprint** — a typed contract that multiple Bindings can satisfy. Same test file runs unchanged against a real Docker container, an in-process simulator, or a Kubernetes pod.

## What it is

Speculum's central abstraction is the **Component Blueprint**: a typed contract describing what a component exposes (API schemas) and what it observably emits (a log-event catalog). Anything that satisfies the contract — the real production image, a hand-written in-process simulator, a prior version, a vendor-compatible alternative — is a valid **Binding** for that Blueprint.

A test consumes the Blueprint, not the Binding:

```ts
const pet = await runtime.petstore.api.http.createPet({ name: "Fido" });   // typed end-to-end
await runtime.petstore.events.waitFor("PETSTORE_REQUEST",
  { attributes: { method: "POST", status: 201 } }, 5_000);                  // typed event catalog
```

`runtime.petstore` is the Blueprint surface. The Binding behind it — real Docker container, in-process fake, future K8s pod — is wiring, not test concern. The substrate is the `Adapter` seam, and it is also where real-vs-simulator is decided. **One line flips the whole suite from real to simulator:**

```ts
// harness.ts
const adapter = useReal
  ? createDockerAdapter({ sessionId: randomUUID() })
  : createInMemoryAdapter({ factories: { "petstore:latest": petstoreFake } });
```

Test files unchanged. Environment composition unchanged. Same Blueprint, different Binding.

## Why this matters

This shape unlocks three things that are hard or impossible with the conventional `docker-compose up && bun test` separation:

- **Fast inner-loop + high-trust outer-loop.** Develop against an in-process simulator binding (milliseconds per test). CI runs the identical suite against the real Docker binding. No two test suites to maintain; no mock-vs-real drift.
- **Cross-implementation contract verification.** Multiple Bindings claiming the same Blueprint can be tested against the same suite — version-to-version, vendor-to-vendor, real-vs-simulator. The Blueprint *is* the cross-implementation contract.
- **Failure-mode coverage as code.** Because the contract requires tests to own container lifecycle, `await runtime.chaos.stop("redis", "primary")` is an `expect()` away. Real failover semantics, primary-down paths, p95 SLA assertions on real traffic — all live in the same test file as the happy path.

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
    image:     "speculum/petstore-sla:latest",
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
//   factories: { "speculum/petstore-sla:latest": petstoreFake, ... },
// });

export const shared = createSharedEnvs(
  { "petstore-sla": env },
  { adapter, stateDir: ".speculum-env", mode: "startOrAttach",
    getTargetEnv: () => "petstore-sla" },
);

// 5. Test consumes the Blueprint surface — substrate- and binding-blind.
test("primary down → 503 → recovery", async () => {
  const runtime = await shared.ensure("petstore-sla");

  await runtime.chaos.stop("redis", "primary");          // typed; "tertiary" is a compile error

  await expect(runtime.petstore.one.api.http.createPet({ name: "X" }))
    .rejects.toMatchObject({ status: 503 });

  const evt = await runtime.petstore.one.events.waitFor(
    "PETSTORE_REQUEST",
    { attributes: { status: 503 } },
    5_000,
  );
  expect(evt.attributes.method).toBe("POST");
});
```

> The `redis(...)` / `nginx(...)` Binding factories, `petstoreFake`, `petstoreEvents`, `petstoreRoutes`, and the `DOCKER_HOST_DNS` constant in the snippet above are defined in [`tests/petstore-example/env.ts`](tests/petstore-example/env.ts) — that file is the canonical runnable form of this example, with all imports.
>
> The example above wires the **Docker** adapter. The same `env.ts` switches to the in-memory simulator adapter or to Kubernetes (deploy mode, or attach against a pre-deployed cluster) by changing one constant — see [Adapters](#adapters) for the matrix, and [`docs/attach-mode.md`](docs/attach-mode.md) for the pre-deployed-cluster walkthrough.

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

| Capability | Without Speculum | With Speculum |
|---|---|---|
| Same test against real and simulator | Two suites, or mocks that drift | One suite; one-line `harness.ts` swap |
| Contract-typed API client | Hand-written client + drift, or codegen step | Declared once as `HttpRouteMap`; client derived at call site |
| Typed log-event assertions | Regex over stdout | Per-Binding `logParser` → `events.waitFor("NAME", { attributes }, ms)` |
| Multi-instance addressable by name | String lookups, untyped | `runtime.petstore.one`, `.two`, `.three` (compile-checked) |
| Stop a container mid-test | docker CLI from a hook + manual port resolution | `chaos.stop("redis", "primary")` — typed disruption |
| Cross-worker container reuse | Brittle global-setup hooks | Atomic file-claim metadata + dead-container fallback |
| Config files referencing resolved ports | docker-compose templating limits | TypeScript strings, mount-as-content (tmpfile bind mounts) |
| Quantitative SLA assertions on real traffic | Load-test in a separate suite | `expect(stats.p95).toBeLessThanOrEqual(500)` in the integration suite |
| Smoke-test against a pre-deployed staging/UAT cluster | Maintain a parallel test-only env, or run e2e tests by hand | `SPECULUM_ADAPTER=k8s-attach` + a developer-owned derive script over your Helm/Terraform output ([walkthrough](docs/attach-mode.md)) |

## Adapters

The Adapter is Speculum's substrate seam (D-003). The same test suite runs against any of them.

| Adapter | Substrate | Use case |
|---|---|---|
| `createDockerAdapter` | Real Docker containers via `dockerode` | High-trust integration; default |
| `createInMemoryAdapter` | In-process simulators (factory registry) | Fast inner loop; CI; no daemon needed |
| `createK8sAdapter({ mode: "deploy" })` | Pods + ConfigMaps + per-Pod Services via `kubectl` | Pre-prod / staging integration; cluster-native parity |
| `createK8sAdapter({ mode: "attach" })` | Pre-deployed workloads (Helm / Terraform / kustomize) discovered via Service. Per-Binding `adapter.k8s.attach` overrides for non-convention names; opt-in real chaos via `kubectl scale` ([D-022](docs/decisions.md#d-022-adapter-specific-binding-config-via-typescript-declaration-merging), [D-023](docs/decisions.md#d-023-attach-mode-chaos-via-kubectl-scale-against-a-named-deployment-opt-in), walkthrough: [`docs/attach-mode.md`](docs/attach-mode.md)) | Smoke / contract tests against an existing cluster; **refuses writes by default** |

The `tests/petstore-example/` SLA suite (15 tests including chaos failover and p95 latency assertions) passes against **all three** substrates, and across both Kubernetes modes (deploy + attach). Switch via `SPECULUM_ADAPTER=docker|memory|k8s|k8s-attach`.

| Adapter | Suite time |
|---|---|
| in-memory | 0.75s |
| docker | 10.3s |
| k8s deploy (OrbStack) | 16.4s |
| k8s attach (OrbStack) | 15.2s |

## Status

**v0.** Same 15-test SLA suite green across four adapter modes (in-memory, Docker, K8s deploy, K8s attach against a pre-deployed cluster). 15/15 in each. Plus 89/89 core harness self-tests; 13/13 K8s attach tests (denylist + integration including rolling-restart survivability and override-rescues-non-convention-name). Bun-native development; library code is portable to Node consumers. ~3k LoC src, ~2.5k LoC tests. Runtime deps: `zod`, `dockerode`. The K8s adapter uses `kubectl` as a subprocess (D-019) — no Kubernetes client library is taken as a dependency.

## Prerequisites

- [Bun](https://bun.sh) `~1.3` or newer (for development; Node consumers can `npm install` the published package)
- [just](https://github.com/casey/just) — `brew install just`
- **Docker** daemon running, for the Docker adapter (Mac/Windows Docker Desktop, or Linux Docker with `host.docker.internal` configured).
- **`kubectl`** on PATH and a reachable cluster context, for the K8s adapter. OrbStack's local Kubernetes works out of the box; for `kind` or remote clusters see [`docs/k8s-rbac.md`](./docs/k8s-rbac.md).

## Run the tests

```sh
# One-time: build the petstore + redis-configurable test images
just build-test-images

# Quad-adapter SLA suite
SPECULUM_ADAPTER=docker bun test tests/petstore-example   # real Docker
SPECULUM_ADAPTER=memory bun test tests/petstore-example   # in-process simulators
SPECULUM_ADAPTER=k8s    bun test tests/petstore-example   # real Kubernetes (deploy mode)

# Attach mode against a pre-deployed cluster — deploys fixtures, derives
# override config from the YAML, runs the suite, tears down on exit.
# See docs/attach-mode.md for the developer-derive-script flow.
just test-petstore-k8s-attach

# Harness self-tests (no Docker images needed, in-memory adapter only)
just test-core

# K8s adapter self-tests (deploy + attach)
just test-k8s
just test-k8s-attach

# Type-check
just typecheck
```

If a `bun test` run is interrupted (Ctrl-C during the integration suite), orphan containers can keep ports allocated. `just clean-containers` force-removes everything labeled `speculum=1`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup, the ADR process, and the code-review checklist. See [`CONVENTIONS.md`](./CONVENTIONS.md) for code style.

## License

TBD.
