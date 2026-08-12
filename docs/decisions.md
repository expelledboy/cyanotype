# Decisions

> Concrete decisions that shape the codebase. Each entry states the context, the decision, and the consequences. Append-only — new decisions get a new entry, never amend an existing one. If a decision is wrong, add a new entry that explicitly retires it; do not edit history.

## Index

- [D-001 — Bun-native source; cross-runtime when published](#d-001-bun-native-source-cross-runtime-when-published)
- [D-002 — Blueprint / Binding split](#d-002-blueprint--binding-split)
- [D-003 — Adapter is the single real-vs-fake decision point](#d-003-adapter-is-the-single-real-vs-fake-decision-point)
- [D-004 — Adapter SPI: seven methods](#d-004-adapter-spi-seven-methods)
- [D-005 — `StartSpec.instance` is a typed first-class field](#d-005-startspecinstance-is-a-typed-first-class-field)
- [D-006 — Per-component typed event catalog with Zod schemas](#d-006-per-component-typed-event-catalog-with-zod-schemas)
- [D-007 — Cross-process registry: atomic file claim with staged state](#d-007-cross-process-registry-atomic-file-claim-with-staged-state)
- [D-008 — Mount-as-content, not mount-from-path](#d-008-mount-as-content-not-mount-from-path)
- [D-009 — Multi-instance via nested record, no wrapper](#d-009-multi-instance-via-nested-record-no-wrapper)
- [D-010 — Protocol discriminated union](#d-010-protocol-discriminated-union)
- [D-011 — No state machine; snapshot is a getter](#d-011-no-state-machine-snapshot-is-a-getter)
- [D-012 — No assert() proliferation](#d-012-no-assert-proliferation)
- [D-013 — dockerode, not CLI shellout, for the Docker adapter](#d-013-dockerode-not-cli-shellout-for-the-docker-adapter)
- [D-014 — SIGINT / SIGTERM teardown is mandatory](#d-014-sigint--sigterm-teardown-is-mandatory)
- [D-015 — `createEnvironment` validates reserved component names](#d-015-createenvironment-validates-reserved-component-names)
- [D-016 — Global teardown via `bun:test` preload + label-scan in `stopAll`](#d-016-global-teardown-via-buntest-preload--label-scan-in-stopall)
- [D-017 — Kubernetes adapter — deploy mode uses bare Pods + ConfigMaps + `kubectl port-forward`](#d-017-kubernetes-adapter--deploy-mode-uses-bare-pods--configmaps--kubectl-port-forward)
- [D-018 — Kubernetes adapter — attach mode discovers via Service, refuses cluster mutation](#d-018-kubernetes-adapter--attach-mode-discovers-via-service-refuses-cluster-mutation)
- [D-019 — `kubectl` shellout, not `@kubernetes/client-node`, for the Kubernetes adapter](#d-019-kubectl-shellout-not-kubernetesclient-node-for-the-kubernetes-adapter)
- [D-020 — Kubernetes adapter — per-Pod `Service` for in-cluster DNS](#d-020-kubernetes-adapter--per-pod-service-for-in-cluster-dns)
- [D-021 — Attach-mode port stability via local-port-claim + Watch-driven respawn](#d-021-attach-mode-port-stability-via-local-port-claim--watch-driven-respawn)
- [D-022 — Adapter-specific Binding config via TypeScript declaration merging](#d-022-adapter-specific-binding-config-via-typescript-declaration-merging)
- [D-023 — Attach-mode chaos via `kubectl scale` against a named Deployment (opt-in)](#d-023-attach-mode-chaos-via-kubectl-scale-against-a-named-deployment-opt-in)
- [D-024 — Framework lifecycle telemetry via an opt-in observer stream](#d-024-framework-lifecycle-telemetry-via-an-opt-in-observer-stream)
- [D-025 — Docker Compose attach adapter — discovery via compose labels + non-destructive guard](#d-025-docker-compose-attach-adapter--discovery-via-compose-labels--non-destructive-guard)
- [D-026 — Docker Compose attach-mode chaos — `container.stop`/`start` as the lifted verbs](#d-026-docker-compose-attach-mode-chaos--containerstopstart-as-the-lifted-verbs)
- [D-027 — `Binding.version` as a cache key — re-ensure invalidates a stale environment](#d-027-bindingversion-as-a-cache-key--re-ensure-invalidates-a-stale-environment)
- [D-028 — Attach-mode image-drift detection via a configurable `onImageDrift` policy](#d-028-attach-mode-image-drift-detection-via-a-configurable-onimagedrift-policy)
- [D-029 — `stack.*` observer phase for compose-stack reconciliation telemetry](#d-029-stack-observer-phase-for-compose-stack-reconciliation-telemetry)
- [D-030 — `cyanotype derive` shipped as a CLI (`bin`) over a copied reference script](#d-030-cyanotype-derive-shipped-as-a-cli-bin-over-a-copied-reference-script)
- [D-031 — `reconcileComposeStack` — library-owned compose-stack staleness reconciliation](#d-031-reconcilecomposestack--library-owned-compose-stack-staleness-reconciliation)
- [D-032 — Closing the derive→bind seam, the rebuild escape hatch, and the image-drift compare boundary](#d-032-closing-the-derivebind-seam-the-rebuild-escape-hatch-and-the-image-drift-compare-boundary)
- [D-033 — Derived adapter config is topology-only; policy lives at the bind site](#d-033-derived-adapter-config-is-topology-only-policy-lives-at-the-bind-site)
- [D-034 — Container ownership as a first-class SPI property; teardown is detach-only for non-owned containers](#d-034-container-ownership-as-a-first-class-spi-property-teardown-is-detach-only-for-non-owned-containers)
- [D-035 — `derive` emits `attach.port` only for single-port services; the field is a narrow override, not a default](#d-035-derive-emits-attachport-only-for-single-port-services-the-field-is-a-narrow-override-not-a-default)

---

## D-001. Bun-native source; cross-runtime when published

**Context:** The development loop benefits from Bun's fast startup and native TypeScript (`bun:test` is the test runner). But the library's consumers may be on Node — testcontainers-node and adjacent tools live in the Node ecosystem.

**Decision:** Source files use Bun for development and tests. The library code (`src/**/*.ts`) avoids Bun-only APIs and uses cross-runtime primitives (`fetch`, `AbortSignal`, `node:fs`, `dockerode`, `zod`). Test fakes (`tests/fakes/**`) may use `Bun.serve` since they only run in `bun:test`.

**Consequences:**
- `package.json` ships ESM with an `exports` map pointing at `src/index.ts`.
- Consumers on Node can `npm install cyanotype` and import.
- We don't ship a pre-bundled `dist/` — TypeScript itself is the artefact, with `tsc --noEmit` for the typecheck gate.
- No native dependencies. `dockerode` and `zod` are pure JavaScript.

---

## D-002. Blueprint / Binding split

**Context:** A component has two halves: the *contract* it exposes (what its APIs and event catalog look like) and the *substrate-bound instantiation* (the image, the env, the host ports, the log format). Conflating them makes the simulator-vs-real swap unexpressible and forces users to copy the contract for every binding.

**Decision:** Two types, two helpers.

- `Blueprint<C, E, I, A>` carries port names, `interface(config, env, resolvedPorts) => I`, optional `api(iface, helpers) => A`, `events`, and probes. No `image`. No `mounts`. No `env` values. Substrate-agnostic.
- `Binding<B>` carries `blueprint: B`, `image`, `version`, `config: C`, `env: E`, host port assignments, optional `mounts`, optional per-Binding `logParser`, optional `labels`.
- `defineBlueprint(spec)` and `bind(blueprint, spec)` are identity factories that drive inference. Plain objects satisfying the types also work — the helpers are convenience, not required ceremony.

**Consequences:**
- Multiple Bindings can satisfy one Blueprint without contract duplication.
- The Blueprint never crosses the Adapter boundary — substrate stays in `StartSpec`.
- `defineBlueprint` uses TS 5.0's `const` type-parameter modifier to preserve literal event-catalog types end-to-end. Without it, `EventCatalog` widens and `runtime.X.events.waitFor("NAME", { attributes: {...} })` loses typed-attribute checking.

---

## D-003. Adapter is the single real-vs-fake decision point

**Context:** "The same test file runs against a real container or a simulator" is the load-bearing user-facing promise. Where that decision lives determines whether the promise is delivered cheaply or expensively.

**Decision:** The decision lives on the Adapter, not on the Binding. The in-memory adapter takes a factory registry `{ [image: string]: FakeFactory }`; the Docker adapter pulls and runs. Bindings declare what to run (`image: string`); adapters interpret what that means against the substrate they own.

Flipping a whole suite from real to simulator is one line at harness wiring:

```ts
const adapter = useReal
  ? createDockerAdapter({ sessionId: randomUUID() })
  : createInMemoryAdapter({ factories: { "petstore:latest": petstoreFake } });
```

**Consequences:**
- Bindings stay substrate-naming; they don't carry factories or substrate dispatch.
- Test files don't change when the substrate changes.
- The factory registry being on the Adapter means an environment running against the in-mem adapter requires every component's image to have a registered factory. Missing factories surface as `{ kind: "image_not_registered" }` at start time.

---

## D-004. Adapter SPI: seven methods

**Context:** The Adapter SPI is the IO boundary. It needs to support session lifecycle (verify daemon, allocate pool), per-container lifecycle, log streaming, and dead-container detection (for cross-process attach recovery).

**Decision:** Seven methods on `Adapter`:

1. `connect()` — verify daemon, allocate connection pool. No-op for stateless adapters.
2. `disconnect()` — release session resources.
3. `teardown()` — label-scan stragglers from crashed runs and remove them.
4. `start(spec: StartSpec): Promise<Started>` — start one container.
5. `stop(containerId: string)` — stop and remove one container. Idempotent.
6. `logs(containerId, signal?): AsyncIterable<string>` — pre-split lines with `AbortSignal` cleanup.
7. `exists(containerId): Promise<boolean>` — structured dead-container check.

**Consequences:**
- Adapters without a session concept (in-memory) implement `connect`/`disconnect`/`teardown` as no-ops.
- The orchestrator never inspects adapter error message strings — `exists()` is the structured signal for dead-container detection.
- `logs()` returns already-line-split strings; adapters own the byte stream, the line splitter, and the cleanup wiring.

---

## D-005. `StartSpec.instance` is a typed first-class field

**Context:** Multi-instance Bindings (e.g. `redis.primary` vs `redis.replica`) need to be distinguishable at the substrate level — adapters set labels for teardown discovery, and in-memory factories need to know which instance they're serving.

**Decision:** `StartSpec.instance?: string` is a typed first-class field on the spec the Adapter receives. The orchestrator sets it from the Binding's instance key. Adapters mirror it into `labels["cyanotype.instance"]` for teardown discovery. In-memory factories read `spec.instance` directly.

**Consequences:**
- No reliance on label-string conventions for instance identity in user-written factories.
- Single-instance Bindings simply omit the field.

---

## D-006. Per-component typed event catalog with Zod schemas

**Context:** A global event bus with `Record<string, unknown>` attributes is the easy thing to build. It's also a lie about typing: `runtime.events.waitFor("PAYMENT_OK", { attributes: { typo: 1 } })` would compile fine.

**Decision:** Each component has its own event bus, typed against the Blueprint's `events` catalog. `EventCatalog = Record<eventName, EventSchema>` where each `EventSchema` is a Zod schema. `runtime.X.events.waitFor("NAME", { attributes: { ... } }, ms)` enforces the schema's attribute shape at compile time. Cross-component composition is `Promise.race(...)` over per-component buses — verbose for the rare case, type-safe for the common one.

**Consequences:**
- No global merged catalog and therefore no silent event-name collisions.
- Each event's source component is explicit at the call site.
- The orchestrator validates each parsed event against the catalog at ingest time (parse-at-boundary); incoming events that don't match are dropped with a warning.

---

## D-007. Cross-process registry: atomic file claim with staged state

**Context:** Multiple test worker processes share the cost of starting containers. Naively, the first writer wins and racing workers can both think they own the environment. Stale "starting" files from crashed runs need to recover without manual cleanup.

**Decision:** `<stateDir>/<envKey>.json` is opened with `O_CREAT|O_EXCL`. The winning writer records `{ state: "starting", session, pid, startedAt }`, runs the orchestrator, then atomically rewrites to `{ state: "running", components, ... }`. Losing writers see `EEXIST`, poll the file until `state === "running"`, then attach. Stale `"starting"` files (older than 90 seconds) are treated as crashed; the would-be loser deletes and re-races. Dead-container recovery uses `Adapter.exists()` rather than error-message string-matching.

**Consequences:**
- Multi-worker safety is structural, not best-effort.
- 90 second staleness threshold is the only tunable; documented and adjustable per environment.
- Cross-worker reconciliation of *components* (not just the env start) is not provided — chaos restarts during a session that produce new container IDs aren't seen by attached workers.

---

## D-008. Mount-as-content, not mount-from-path

**Context:** Cross-container wiring (nginx upstream pointing at three petstore host ports, redis `replicaof` referencing the primary's resolved host port) requires config files that depend on runtime values. docker-compose's static YAML can't express this; mount-from-host-path requires the host to have the right file at a known location before the test starts.

**Decision:** `Binding.mounts` is `Record<container_path, content_string>`. The Adapter writes content to host tmpfiles and bind-mounts them read-only. No path-based mounts in the user API.

**Consequences:**
- Cross-container wiring is fully expressible in TypeScript with resolved-port closures.
- The Adapter is responsible for tmpfile lifecycle (write on start, clean on stop).

---

## D-009. Multi-instance via nested record, no wrapper

**Context:** A component with multiple instances (replication, sharding, load-balanced fleets) needs to be addressable per-instance at compile time. The natural shape is a record.

**Decision:** An environment slot is either a single `Binding` or `Record<instanceId, Binding>` — inline. No `Slot` wrapper type, no `multi(...)` factory. The Runtime derives the right shape: `runtime.redis.primary` is `Running<...>`; `runtime.redis` is `{ primary: Running, replica: Running }`.

**Consequences:**
- Chaos arg shape is derived per-slot at compile time: `chaos.stop("redis", "primary")` is required for multi, `chaos.stop("nginx")` is required for single.
- Same component definition is reusable across instances by sharing the Blueprint and per-instance configuration.

---

## D-010. Protocol discriminated union

**Context:** A component may expose HTTP, raw TCP, gRPC, SOAP, or any number of protocols. The way that's modelled determines how easy it is to add a new protocol later.

**Decision:** `Protocol` is a discriminated union (`{ kind: "http"; routes } | { kind: "opaque" } | …`). Each case carries its own schema and resolves to a typed client via `ApiOf<P>`. Adding a new protocol is a new case in the union plus a new branch in `ApiOf`. For the Opaque case the typed API is `undefined` — tests get host/port from the Interface and bring their own client.

**Consequences:**
- HTTP is the only protocol with a runtime typed client in v1.
- Future TCP/gRPC additions don't require a discrimination rewrite of every consumer — they extend the union.

---

## D-011. No state machine; snapshot is a getter

**Context:** A reducer-style state machine (`step(state, command) -> events`) is tempting for orchestrators. In practice the bugs that hit are IO-edge bugs (process keepalive on stream destroy, exit-handler races) — none of which a reducer prevents. The theoretical win is `snapshot()` exhaustiveness, but `snapshot()` is a getter regardless.

**Decision:** No `Command` / `DomainEvent` / `step` / `apply`. `Runtime.snapshot()` returns a structurally-typed frozen view assembled at call time from live state. The orchestrator uses imperative closures with `Map` / mutable status records.

**Consequences:**
- The orchestrator stays small and the snapshot semantics are defined directly on `Runtime`.
- No event log, no replay, no audit trail. If those are needed later it's an additive ADR, not a refactor.

---

## D-012. No assert() proliferation

**Context:** A common pattern in TypeScript-with-validation libraries is to `assert(x != null)` everywhere. Most asserts duplicate what the type system already guarantees and add noise without adding safety.

**Decision:** Validate at boundaries; trust internally. `createEnvironment` rejects reserved component names. `EventBus.ingest` validates parsed events against the catalog. Metadata files are validated on load. Inside the orchestrator and runtime, trust the types — no defensive asserts.

**Consequences:**
- The source stays terse and readable.
- A bug that bypasses the type system (e.g. a JSON.parse from a corrupted metadata file) is caught at the boundary, not deeper.

---

## D-013. dockerode, not CLI shellout, for the Docker adapter

**Context:** The Docker adapter needs lifecycle, log streaming, label-based teardown discovery, and connection pooling. CLI shellout (`docker ps -a --filter ...`) requires text parsing and provides poor cleanup signals.

**Decision:** `dockerode` (pure JavaScript, talks to the Docker socket via `fetch`). It works on both Bun and Node, provides demux/pull-progress/inspect in single library calls, and the connection-pool cleanup is the SDK's responsibility.

**Consequences:**
- One runtime dependency (`dockerode` + its transitive `docker-modem`).
- The mount-as-content tmpfile lifecycle, label-based teardown, and SIGINT/SIGTERM cleanup are still ours.

---

## D-014. SIGINT / SIGTERM teardown is mandatory

**Context:** Without a process-level signal handler that stops known containers, killing `bun test --watch` with Ctrl-C orphans containers; the next invocation collides on labels or ports.

**Decision:** The Docker adapter registers an idempotent SIGINT/SIGTERM handler at session start. The handler stops every container in the live registry, then calls `disconnect()`. Registered exactly once per process (re-entrant safe).

**Consequences:**
- "Harness exits cleanly on Ctrl-C" is a v1 invariant.
- The orphan-cleanup case (process killed without Ctrl-C — `kill -9`) falls back to label-based teardown on the next session start.

---

## D-015. `createEnvironment` validates reserved component names

**Context:** The Runtime tree exposes system operations at the root (`runtime.chaos`, `runtime.snapshot`, `runtime.metadata`, `runtime.stop`). A Blueprint named "chaos" would silently shadow.

**Decision:** `createEnvironment(record)` throws `{ kind: "reserved_component_name", name, reserved }` at construction time when any top-level key collides with a reserved name (`start`, `stop`, `snapshot`, `metadata`, `chaos`). `start` is reserved defensively even though `runtime.start()` is not currently exposed — cheap insurance against future shadowing if env-level start is added later.

**Consequences:**
- The runtime tree's system-op keys are guaranteed not to collide with component names.
- Validation is at the boundary (the user's `createEnvironment` call), not deeper — matches the broader "parse at boundaries" principle.

---

## D-016. Global teardown via `bun:test` preload + label-scan in `stopAll`

**Context:** `bun test` runs all test files in a single process. Test files call `shared.ensure(...)` in `beforeAll` to start containers and reuse them across files via the registry cache. When the process exits normally (all tests pass, `process.exit(0)`), no SIGINT/SIGTERM fires — so the Docker adapter's signal handler, which would stop owned containers on Ctrl-C, does not run. Without an additional hook, containers leak between `bun test` invocations and the next run hits port-allocation errors.

The leak is not specific to a misbehaving test: it's structural. `runtime.stop()` is owned by tests that explicitly want to tear a runtime down mid-suite (the chaos pattern). `shared.stopAll()` is the global teardown, but it has no automatic firing point — Bun has no `globalTeardown` equivalent of Jest's.

**Decision:** Two changes.

1. **`bunfig.toml` registers a preload script** at `./tests/preload.ts`. The preload's top-level `afterAll` (from `bun:test`) fires exactly once after the entire `bun test` run and calls `shared.stopAll()`. Top-level `afterAll` in a preload is the Bun-documented idiom for run-scoped teardown; lifecycle hooks scoped at the `describe` level are file-scoped only.

   The preload also has a top-level `beforeAll` — currently a no-op, kept so future setup-side additions live alongside teardown. Setup is deliberately lazy: per-file `beforeAll(shared.ensure(...))` triggers the first start, and the cache makes subsequent calls free, so `bun test tests/core/` (in-memory only) doesn't pay a Docker start cost it doesn't need.

2. **`shared.stopAll()` does belt-and-suspenders cleanup.** After stopping cached runtimes and deleting metadata, if the session ever started anything (`cache.size > 0` before the loop), the harness reconnects the adapter, calls `adapter.teardown()` for a session-labelled force-clean of any stragglers (orphans from chaos restarts, crash-mid-start, etc.), then disconnects. Guarded by `hadAny` so an in-memory-only test run doesn't pay a Docker connect cycle.

**Consequences:**
- `bun test` alone (no `just clean-containers` prerequisite) leaves a clean Docker environment. Verified: two consecutive `bun test` invocations with no cleanup between them, both 85/85 green, zero orphan containers after each.
- `just test` no longer depends on `clean-containers`. `just clean-containers` remains as a manual reset for unusual situations (`kill -9`, partial state, ad-hoc debugging).
- `--watch` mode: the preload's `afterAll` fires between watch iterations, so containers are stopped + re-created on each iteration. That's the conservative default; users wanting `--watch` with container reuse can write their own preload that omits the teardown call.
- The SIGINT/SIGTERM handler in the Docker adapter remains as the safety net for Ctrl-C — orthogonal to the preload pattern.

---

## D-017. Kubernetes adapter — deploy mode uses bare Pods + ConfigMaps + `kubectl port-forward`

**Context:** The Kubernetes adapter must satisfy the same 7-method SPI as the Docker adapter (D-004). The substrate primitives differ — K8s has Pods, Deployments, Jobs, Services, ConfigMaps, NodePort, Ingress, port-forward — and we need one shape per concern. The Docker adapter is the reference for behaviour, not for primitives.

**Decision:**

- **Workload:** bare `Pod`, not `Deployment` or `Job`. One Pod per `StartSpec`. Cyanotype owns the lifecycle; restart-on-crash would mask the very failures tests assert on. `containerId` is the Pod name.
- **Mount-as-content (D-008):** one `ConfigMap` per Pod, `data[basename] = content`, mounted via `volumeMounts` with `subPath` to preserve the absolute target path. Labelled identically to the Pod so the label-scan teardown sweeps both.
- **Port exposure:** long-lived `kubectl port-forward pod/<name> :<containerPort>` subprocess. The local port is parsed from kubectl's stdout (`Forwarding from 127.0.0.1:NNNNN -> NNNN`). One subprocess per `StartSpec` port. Avoids NodePort (requires node-IP discovery, breaks on managed clusters) and `hostPort` (requires cluster-side config).
- **Namespace:** single configurable namespace (default `cyanotype-tests`). Session scoping via labels, not namespace suffix — per-session namespaces churn RBAC and orphan-cleanup logic.
- **Labels** (on Pod and ConfigMap): `cyanotype=1`, `cyanotype.session=<uuid>`, `cyanotype.component=<name>`, `cyanotype.instance=<name>` when present.
- **Teardown:** `kubectl delete pods,configmaps -n <ns> -l cyanotype=1,cyanotype.session=<uuid> --wait=false`. SIGINT/SIGTERM handler (D-014) ported from `src/adapters/docker.ts`, owning the same `globalKnown` / `globalStopFns` discipline plus the set of live port-forward subprocesses.

**Consequences:**
- Deploy mode requires `create,get,list,watch,delete,deletecollection` on `pods` + `configmaps` in the target namespace, plus `pods/log` (get) and `pods/portforward` (create). Documented in `docs/k8s-rbac.md`.
- Pod crashes surface as `exists() === false` (matching the Docker contract). No silent restart.
- Adding a `Deployment`-backed variant later is additive; this ADR doesn't foreclose it.
- The local port held by `kubectl port-forward` is stable for the subprocess's lifetime; if the Pod is rescheduled mid-test, the subprocess exits and `exists()` returns false — the test sees the same failure mode as a Docker container exit.

---

## D-018. Kubernetes adapter — attach mode discovers via Service, refuses cluster mutation

**Context:** Smoke-testing real environments — dev/uat/prod where components are Helm- or Terraform-deployed — needs an adapter that runs the same test suite without provisioning anything. The adapter must be loud-safe: one stray destructive call against prod is catastrophic. Discovery must work zero-config against existing Helm charts; we cannot require chart authors to add cyanotype-specific labels.

**Decision:**

- **Mode selection at factory time:** `createK8sAdapter({ mode: "deploy" | "attach", ... })`. `CYANOTYPE_K8S_MODE` env var overrides for CI ergonomics. Mode is a structural property of the adapter instance — matches D-003 (substrate decision is the single seam).
- **Discovery:** convention-based `Service` lookup. The `Service` named `<component>` (or `<component>-<instance>` for multi-instance) in the configured namespace is the resolution target. Helm charts already name Services after components.
- **Explicit override:** a Binding may declare `attach: { namespace, service, port }` to override the convention.
- **`start()` is non-creating.** Resolves the Service via `kubectl get svc <name> -o json`, picks a ready Pod from the EndpointSlice (`kubectl get endpointslices -l kubernetes.io/service-name=<name> -o json`), opens a `kubectl port-forward` against that Pod. `containerId = "attach:<namespace>/<podName>"` so dispatch forks on prefix.
- **`stop()` / `teardown()` are non-destructive.** They close the port-forward subprocess and nothing else. The adapter rejects, at one chokepoint, any `kubectl` invocation whose first subcommand is `apply`, `create`, `delete`, `patch`, `replace`, `edit`, `scale`, or `rollout` while `mode === "attach"`. Violations throw `{ kind: "attach_mode_violation", op, target }`. This is the loud safety guarantee — enforced in the adapter, not at call sites.
- **`logs()`:** `kubectl logs -f --tail=0 <pod> -c <container>` subprocess, stdout streamed via `readline` over `Readable.fromWeb(proc.stdout)`. Identical to the Docker adapter's `AsyncIterable<string>` contract.
- **`exists()`:** `kubectl get pod <name>` exit code (0 = exists, non-zero = gone). On 404 mid-session, re-resolve via the Service's EndpointSlice and update the cached Pod reference. Host-side port stays stable across the re-resolve (the port-forward subprocess restarts under the same local port via re-spawn).

**Consequences:**
- Attach mode needs only read RBAC + `pods/log` + `pods/portforward`. Safe to grant against prod.
- Helm chart authors do not need to add cyanotype-specific labels for discovery to work.
- Mode-dispatch is at the SPI boundary inside one adapter file, not two parallel adapters — keeps D-003 intact.
- Rolling restarts of the target workload are survivable mid-test.
- The kubectl-subcommand denylist is unit-tested: each destructive verb is exercised in attach mode and asserted to throw.

---

## D-019. `kubectl` shellout, not `@kubernetes/client-node`, for the Kubernetes adapter

**Context:** A spike against OrbStack's local Kubernetes cluster (May 2026) found that `@kubernetes/client-node` cannot authenticate under Bun. The library configures client cert/key on a Node `https.Agent`; Bun's fetch path does not surface agent-supplied cert/key on the wire ([oven-sh/bun#10642](https://github.com/oven-sh/bun/issues/10642), [#9376](https://github.com/oven-sh/bun/issues/9376), [#23985](https://github.com/oven-sh/bun/issues/23985)). The blocker is tracked specifically as [oven-sh/bun#19754 "Cannot use @kubernetes/client-node under bun"](https://github.com/oven-sh/bun/issues/19754), open since May 2025 with no fix. `NODE_EXTRA_CA_CERTS` made TLS handshake succeed; the client cert still never reached the API server and every call returned 401.

A second spike replaced the library with `Bun.spawn` driving `kubectl` directly. Four capabilities passed first attempt: `kubectl get -o json` + JSON parse; pod-exists via exit code; `kubectl port-forward` + 10 sequential local TCP connections; `kubectl logs -f` line streaming. Subprocess teardown via `proc.kill()` + `await proc.exited` was clean; no zombies; no warmup latency.

`kubectl` is the de facto programmatic interface for Kubernetes — stable JSON output via `-o json`, native streaming for `logs -f`, native port-forward, and identical behaviour against OrbStack, kind, EKS, GKE, anywhere it runs. Its surface is more polished than `@kubernetes/client-node` for the operations Cyanotype needs.

**Decision:** The Kubernetes adapter (`src/adapters/kubernetes.ts`) drives `kubectl` via `Bun.spawn`. All cluster I/O is subprocess I/O — `get -o json` for reads, `apply -f - <<<JSON` for creates, `delete --selector=...` for teardown, `port-forward` for port exposure, `logs -f` for log streaming. No TypeScript Kubernetes client is taken as a dependency.

**Consequences:**
- This **reverses D-013** for the Kubernetes substrate specifically. D-013 chose `dockerode` over CLI shellout for the Docker adapter because Docker's CLI is awkward for programmatic use (incomplete JSON output, ad-hoc flag conventions). The reverse trade-off holds for Kubernetes: `kubectl` is the canonical programmatic interface; the Bun-compatible library option is broken upstream with no committed fix.
- Cyanotype gains zero new TLS / HTTP / auth code. The runtime trust path is owned by `kubectl`. In-cluster auth, kubeconfig auth, exec-plugin auth, OIDC, AWS IAM auth — all are handled by kubectl, free.
- `kubectl` becomes a runtime dependency of the K8s adapter — documented in the adapter README and `docs/k8s-rbac.md`. CI images must include it.
- Subprocess overhead is non-trivial (~50–150ms per `kubectl get` invocation). Acceptable for test-infrastructure use; not a high-throughput path. Logs and port-forward are long-lived subprocesses, so per-call overhead does not stack there.
- One Bun-specific detail captured for the implementation: `Bun.spawn`'s `proc.stdout` is a web `ReadableStream`. Feed it to `readline` via `Readable.fromWeb(proc.stdout)` — direct use throws `input.on is not a function`. This is a one-line wrapper at every streaming site.
- If `@kubernetes/client-node` becomes Bun-compatible later, switching is internal to the adapter and does not affect the SPI. This ADR is not retired by that change unless we want it to be.

---

## D-020. Kubernetes adapter — per-Pod `Service` for in-cluster DNS

**Context:** D-017 chose bare Pods + `kubectl port-forward` for the deploy-mode Kubernetes adapter. Port-forward gives the test runner on the dev machine a local TCP endpoint to each Pod, but it does nothing for **cross-component traffic inside the cluster.** In the petstore-SLA suite, nginx must reach three petstore Pods, the petstore Pods must reach two redis Pods, and the redis replica must reach the redis primary. The Docker harness solves this with `host.docker.internal:<pinned-host-port>` — every container hops back to the host's published port. That idiom does not translate to Kubernetes: Pods cannot route to the dev machine's localhost, and pinning hostPort across restarts is fragile (TIME_WAIT on chaos restarts, conflicts on multi-suite parallelism).

The K8s-native answer is a `Service` per component instance: a stable in-cluster DNS name (`<component>` or `<component>-<instance>`) that components reference in their env wiring. The same name resolves identically on every Pod in the namespace, regardless of where the target was scheduled.

**Decision:** The deploy-mode adapter creates one `Service` per Pod that has ports, alongside the Pod + ConfigMap from D-017.

- **Naming:** `sanitiseDnsLabel(<cyanotype.component>[-<cyanotype.instance>])`. Stable across the test session — restarts of the same component reuse the same Service name.
- **Selector:** the unique per-Pod label `cyanotype.podname=<podName>`. The adapter writes that label onto the Pod alongside the orchestrator-set labels. This makes the Service 1:1 with its Pod (no risk of cross-instance traffic when two Pods share `cyanotype.component` + `cyanotype.instance` — e.g. mid-chaos when an old Pod is terminating while the new one is starting).
- **Ports:** one Service port per `StartSpec.ports` entry, with `port == targetPort == Number(name)`. The K8s adapter's `StartSpec.ports` keys are the container port (D-017).
- **Labels:** the same `cyanotype=1`, `cyanotype.session`, `cyanotype.component`, `cyanotype.instance` labels the Pod and ConfigMap carry, so the existing label-scan teardown sweeps Services too.
- **Lifecycle:** Service is applied after the Pod becomes Ready (Pod-Ready failures don't leak Services). Service deletion is appended to `stop()` and to the bulk session-teardown (`delete pods,configmaps,services -l cyanotype=1,cyanotype.session=<uuid>`).
- **Cross-component env wiring:** `tests/petstore-example/env.ts` switches on `CYANOTYPE_ADAPTER === "k8s"` and uses the Service DNS names (`redis-primary`, `redis-replica`, `petstore-one|two|three`) on the **container** port (6379, 8080) instead of `host.docker.internal` on the pinned host port. The Docker / in-memory paths are unchanged.
- **Port-forward in K8s mode binds to `"auto"`, not the pinned hostPort.** D-017's port-forward is for the dev machine's test runner; that traffic does not flow through the host's well-known port any more. Pinning would only create chaos-test TIME_WAIT hazards on stop+start cycles. The host-side port is reported back via the existing `Started.ports` contract, so user-facing test code is unchanged.

**Consequences:**
- Cross-component DNS in deploy mode now works identically to the Docker harness's `host.docker.internal` pattern, but cluster-native. Authoring an environment for both substrates is a single switch in the Binding env block (or a helper).
- Attach mode (D-018) is unaffected: it already discovers via existing Services and creates nothing.
- D-017's RBAC requirements grow by one resource: deploy mode now needs `create,get,list,watch,delete,deletecollection` on `services` in addition to `pods` + `configmaps`. `docs/k8s-rbac.md` should be updated.
- The orchestrator's `chaos.stop` polls `exists()` for up to 5 seconds. K8s pod deletion under the default 30s grace period would blow that budget every time; the adapter uses `--grace-period=0 --force --wait=false` and parallelises pod / configmap / service deletes. Verified end-to-end: `tests/petstore-example` (15 tests including three chaos-stop+start cycles in an `afterEach`) is green against OrbStack under bun:test's default 5s hook timeout.
- `kubectl wait --for=condition=Ready --timeout=<n>s` replaces the previous 500ms poll loop for Pod readiness. `kubectl wait` uses the watch API and returns within milliseconds of the kubelet flipping the Ready condition; the polled inspection is kept as a fall-through for structured error reporting on timeout.

---

## D-021. Attach-mode port stability via local-port-claim + Watch-driven respawn

**Context:** Attach mode (D-018) opens `kubectl port-forward` against a Service-resolved Pod. `kubectl port-forward` does not reconnect: per [kubectl reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_port-forward/), "the forwarding session ends when the selected pod terminates." `kubectl port-forward service/X` resolves to one Pod once and does not re-target on rolling restart ([kubectl#686](https://github.com/kubernetes/kubectl/issues/686), closed not-planned). For attach mode against real environments where ops actions (Helm upgrade, autoscaler, rollout) routinely replace pods, the naive shape — one subprocess per port — fails the first time a Pod is rescheduled.

A Cyanotype test holds a reference to `Started.ports[name]` and connects to `127.0.0.1:<port>` repeatedly. The contract that makes test code portable across substrates is that the local port stays the same for the lifetime of the runtime. If the port flaps on every backend churn, test code has to refresh its references — bleeding substrate concerns up into tests.

**Decision:** The K8s adapter's attach mode wraps each `kubectl port-forward` in a reconnection layer (`startReconnectForward` in `src/adapters/kubernetes.ts`):

1. **Claim a local port up-front.** `net.createServer().listen(0, "127.0.0.1")`, read `address().port`, then `close()`. The kernel assigned port is recorded as `localPort`.
2. **Spawn `kubectl port-forward pod/<X> LOCAL:CONTAINER`.** Explicit `LOCAL` means subsequent respawns use the same host-side port.
3. **Detect subprocess exit asynchronously.** A background loop awaits `proc.exited`. On exit (any code), if the wrapper hasn't been explicitly `kill()`ed, re-resolve a ready Pod via the Service's EndpointSlice (with 500ms backoff and a 3-strike give-up), then respawn with the same `LOCAL`.
4. **Surface terminal failure as a typed error.** After 3 consecutive re-resolution failures, the wrapper marks itself stopped and emits `{ kind: "k8s_attach_reconnect_failed", service, attempts }`.

`stop()` and `teardown()` set `state.stopped = true` and kill the current subprocess (via the `killForwards` path that already handles deploy-mode tracking).

**Consequences:**
- `kubectl rollout restart` against an attached Deployment causes a brief blip; the local port stays valid and the next request succeeds. Integration-tested in `tests/core/kubernetes-attach.test.ts > survives rolling restart via reconnection layer`.
- The host-side port is allocated by the OS and immediately released before kubectl claims it. The window between `close()` and kubectl's bind is small but non-zero — if another process steals the port in that window, the initial port-forward fails with `bind: address already in use`. Not observed in practice; if it surfaces, the next-step mitigation is to retry the initial spawn with a fresh local port.
- Re-resolution polls EndpointSlices, not Pods, so attach mode tolerates ReplicaSet rolls correctly: the EndpointSlice represents "the Pods that are currently ready endpoints of this Service."
- The reconnection layer never mutates the cluster — it only spawns `kubectl port-forward` (allowed in attach mode by the D-018 chokepoint) and reads via `kubectl get svc` / `kubectl get endpointslices` (read verbs only). Safe to use against prod.
- Same shape can be lifted into deploy mode if a use case appears (e.g., chaos tests that restart the Pod). Not done — deploy mode owns the Pod's identity, so a Pod loss is a test failure, not a substrate event.

---

## D-022. Adapter-specific Binding config via TypeScript declaration merging

**Context:** Attach mode (D-018) derives the K8s `Service` name from `cyanotype.component` (+ optional instance) labels. That convention works when the Cyanotype-internal name matches the real cluster's Service name, but breaks the moment a user attaches to an existing Service whose name was decided by ops (`my-real-prod-nginx`, `payments-api-v2`, etc.). The Binding needs a substrate-specific escape hatch — but stuffing K8s-specific fields onto `Binding` itself bleeds substrate concerns into the substrate-agnostic core, and a generic `Binding<Cfg>` parameter would virally propagate through every helper and test signature.

**Decision:** Adapter-specific Binding overrides flow through an open `AdapterConfig` interface on `src/adapter.ts`, augmented per-adapter via TypeScript declaration merging.

- Core declares `export interface AdapterConfig {}` (open, empty).
- `Binding` carries `readonly adapter?: AdapterConfig`.
- `StartSpec` carries `readonly adapterConfig?: AdapterConfig`; orchestrator's `buildSpec` forwards `binding.adapter` into it.
- Each adapter augments the interface from its own module — e.g. the K8s adapter declares `interface AdapterConfig { k8s?: { attach?: { namespace?: string; service?: string; port?: number } } }`. Other adapters get their own top-level key (`docker?`, `inMemory?`, …) and never collide.
- Adapters honour overrides per-field with fallback to the existing convention (override `service` → use it; else derive from labels).

**Consequences:**
- Substrate-agnostic core stays generic-free — `Binding<B>` already carries one variance-sensitive type parameter and adding a second was a non-starter under `strictFunctionTypes`. Module augmentation gives full type-safety without a generic.
- Adapter additions are zero-cost on the core: a new adapter contributes a `declare module` block in its own file. No central registry, no enum, no switch.
- Users importing a Binding from an adapter-aware module get the merged interface automatically; importing only the core sees the empty interface and the override slot is `unknown`-shaped — degrade is graceful.
- Convention-based discovery remains the default. Overrides are opt-in per Binding, per field. Integration-verified against a Service whose name (`my-real-prod-nginx`) intentionally does not match the component label.

---

## D-023. Attach-mode chaos via `kubectl scale` against a named Deployment (opt-in)

**Context:** D-018 made attach mode refuse every cluster-mutating verb — the right default against shared dev/uat/prod. But the petstore-example resilience tests assert behaviour under *component* outage, and need a chaos shape that actually exercises real failure. A first cut (the original D-023) tried to satisfy this entirely at the network seam: pause the `kubectl port-forward` subprocess on `chaos.stop`, resume it on `chaos.start`. From the test runner's local socket the component looked gone — but from inside the cluster *nothing changed*. Cluster-internal traffic (petstore Pod → redis Service via cluster DNS) was untouched, so backend-to-backend resilience tests passed trivially without exercising real failure. That defeated the entire point of the opt-in: the developer says "yes, you may mutate my cluster for chaos" — and we then did not mutate it.

**Decision:** Attach-mode chaos is real cluster mutation, gated by *two* fields on the Binding:

- `adapter: { k8s: { attach: { allowChaos: true, deployment: "<name>" } } }`. Both required. `allowChaos: true` without `deployment` throws `k8s_attach_deployment_required` at `start` time — failing the developer loudly rather than silently degrading to network-seam chaos.

Mechanism:

- `chaos.stop(component, instance)` pauses the D-021 reconnection wrapper (kills the current `kubectl port-forward`, holds the local port), then `kubectl scale deployment/<name> --replicas=0`, then polls the Service's EndpointSlice until zero endpoints are Ready (30s timeout).
- `chaos.start(...)` `kubectl scale deployment/<name> --replicas=1`, polls until ≥1 Ready endpoint, then resumes the reconnection wrapper which re-resolves a Ready Pod and respawns `kubectl port-forward` against the same local port (D-021 invariant intact).
- `chaos.restart(...)` is stop + start sequenced.
- `chaos.stop` with `allowChaos: false` still throws `chaos_unsupported_in_attach_mode` (unchanged from the original D-023).

`scale` is chosen over `delete pod`: a bare `delete pod` against a Deployment is respawned by the ReplicaSet controller within milliseconds, so chaos would last under a second and resilience tests would race. `scale --replicas=0` holds the outage until we choose to lift it.

The kubectl denylist (D-018) is lifted *only* for the `scale` verb, and only on the per-Binding kubectl client created with `allowChaosScale: true`. `apply / create / delete / patch / replace / edit / rollout` remain blocked at the chokepoint regardless. Denylist tests for those verbs are unchanged.

**Consequences:**
- This **reverses the original D-023 design** (network-seam pause/resume). The pause/resume scaffolding is kept — it still holds the local port stable across the outage — but the *real* outage now comes from the Deployment having no Ready endpoints, observable to every consumer inside the cluster.
- The opt-in surface gains one required field. Discovery scripts (e.g. `tests/petstore-example/scripts/derive-cyanotype.ts`) must emit the Deployment name alongside the Service name; the reference derive script does this by finding the Deployment whose `spec.template.metadata.labels` satisfies the Service's `spec.selector`.
- All 15 petstore-example tests pass under attach mode, including the previously-trivially-green resilience tests (which now exercise real failure) and the previously-failing primary-outage test (which now passes for real because petstore Pods actually observe their redis-primary endpoint disappear).
- RBAC for attach + chaos: read everything previously listed in D-018, plus `patch` on `deployments/scale` in the target namespace. Without `allowChaos: true` the read-only attach RBAC is unchanged — still safe against prod.
- `just test-petstore-k8s-attach` chains `deploy → derive → test → teardown` so cluster state is never leaked even when the suite fails. Teardown deletes the entire `cyanotype-petstore-attach` namespace.
- Cross-namespace attach (D-022) still composes: the paused-attaches registry remains keyed by `${namespace}/${serviceName}` and now also carries the Deployment name and the per-binding kubectl client.


---

## D-024. Framework lifecycle telemetry via an opt-in observer stream

**Context:** Cyanotype had exactly one notion of "event" — `EventBus<Cat>` / `logParser` (D-006): the *domain events of the system under test*, parsed from container logs, typed against a Blueprint catalog, asserted on by tests. They only exist *after* a container is up and streaming logs.

There was no event layer for the framework's *own* lifecycle. Walk `startEnvironment` → `adapter.start` → `runProbe` and every slow operation is silent: `adapter.connect()` (daemon ping), `ensureImage()` (image pull — 10s–minutes), `createContainer` / `start`, `runProbe` (readiness polling — 0–30s), the per-component loop. When Docker is slow the two real culprits — **image pull** and **readiness polling** — are precisely the operations that produce zero feedback. The Docker adapter even *consumed* dockerode's layer-by-layer pull progress (`followProgress`) and discarded it. A test author provisioning a Docker environment saw a multi-minute hang with no indication of what was happening or whether it had stalled.

**Decision:** Add a second, separate event channel — the **observer stream** (`src/observer.ts`) — distinct from `EventBus`:

- `EventBus<Cat>` is typed per Blueprint, owned by a component, asserted on by tests. Unchanged.
- The observer stream is cross-cutting *framework telemetry* — substrate connection, image pull, container provisioning, readiness polling, teardown, chaos — owned by the orchestrator + adapters, consumed by a *reporter* (terminal progress, CI annotations, timing dumps).

Shape:

- `ObserverEventData` — a discriminated union (on `type`) covering six phases: `substrate.*`, `image.*`, `container.*`, `probe.*`, `environment.*`, `chaos.*`.
- `ObserverEvent` = `ObserverEventData` + an envelope (`seq`, `at`, `adapter`, `envKey?`, `component?`, `instance?`).
- `Observer = (e: ObserverEvent) => void` — the consumer-facing sink, passed on `OrchestratorOptions.observer`.
- `createEmitter(observer)` wraps a sink into scoped `Emit` functions; the envelope (including a monotonic `seq` shared across all scopes) is stamped centrally so a reporter gets one stable total order even across concurrent component starts.

Threading:

- The orchestrator owns the `Observer`. It emits `substrate.*`, `probe.*` (via a new optional 4th arg to `runProbe`), `environment.*`, and `chaos.*`/`container.stop*` itself.
- Substrate-internal events that only an adapter can see — `image.*`, `container.creating/created/starting/started` — flow through a new optional `emit?: Emit` parameter on `Adapter.start`. The Docker adapter emits the full set, including throttled `image.pull_progress` lifted from dockerode's previously-discarded `followProgress` callback. The in-memory adapter emits `container.created/started` so the simulator path also renders in a reporter.

**Consequences:**

- **Opt-in and additive — zero cost when off.** No `observer` ⇒ `createEmitter` returns a shared no-op `Emit`. The `Adapter.start` and `runProbe` signature changes are optional trailing parameters, so every existing adapter, caller, and test compiles and behaves identically. The `Adapter` SPI stays at seven methods (D-004).
- **The Blueprint contract is untouched.** `EventBus<Cat>` / `logParser` / the event catalog are unchanged. This is a strictly separate channel.
- **Configuration-aware by construction.** The in-memory adapter skips `image.*` and jumps to `container.started`; Docker emits the full pull stream; K8s will add `portforward.*`. The same reporter renders all substrates, and the event vocabulary self-describes where the time went — answering "this framework runs in various stages / configurations alongside test suites".
- **Reuses existing error shapes.** `*.failed` / `*.timed_out` events carry the same structured tagged objects already thrown (`docker_connect_failed`, `image_pull_failed`, `container_start_failed`, `probe_timeout`); near-zero new modelling.
- **Presentation is not Cyanotype's job (yet).** This decision ships the *stream*, not a reporter. A default terminal progress reporter, a GitHub Actions `::group::` reporter, and a `--timing` phase-breakdown reporter are natural follow-ups that consume `ObserverEvent` without further core changes.
- **Follow-up:** the K8s adapter currently threads the `emit` parameter (signature-compatible) but does not yet emit; wiring `image.*`, `container.*`, and K8s-specific `portforward.*` / `endpoints.*` events is a bounded next step.

---

## D-025. Docker Compose attach adapter — discovery via compose labels + non-destructive guard

**Context:** The Docker adapter (D-013) has always owned a single deploy mode: pull an image, create a container, manage its full lifecycle. After the Kubernetes adapter gained an attach mode (D-018) — point an existing test suite at already-running cluster workloads without provisioning anything — the same pattern became desirable for Docker Compose. A user runs `docker compose up` to stand up their stack, then points the same SLA test suite at those containers without Cyanotype creating, pulling, or removing anything. The thesis is "same suite, five substrates": in-memory simulator, Docker deploy, Docker Compose attach, Kubernetes deploy, Kubernetes attach.

**Decision:**

- **Mode selection at factory time:** `createDockerAdapter({ mode: "deploy" | "attach", project?: string, ... })`. `mode` mirrors the K8s adapter's `createK8sAdapter` option. Mode is a structural property of the adapter instance — matches D-003. `Adapter.start` dispatches to a private `startAttach` path; the 7-method SPI (D-004) is unchanged.
- **Discovery via Compose labels.** Containers are found via `dockerode.listContainers` filtered on two labels: `com.docker.compose.project=<project>` (the compose project name, defaulting to the directory name) and `com.docker.compose.service=<service>`. By convention the compose service name maps to the Cyanotype component by name (`cyanotype.component` label, with optional `--scale` suffix `<service>-<n>`). The `containerNumber` field (default 1) targets a specific scaled instance. A Binding may override any of these via `adapter: { compose: { attach: { project, service, containerNumber, port } } }` — per the D-022 declaration-merging slot.
- **Port resolution without port-forward.** Docker Compose publishes host ports directly: the adapter reads `container.inspect().NetworkSettings.Ports["<containerPort>/tcp"][].HostPort`. No `kubectl port-forward` subprocess, no local-port-claim loop. This is stable by construction: a `docker stop`/`start` reuses the same container and its host port mapping is re-inspected on `chaos.start`.
- **Non-destructive guard.** In attach mode the dockerode client is wrapped at one chokepoint that denies mutations. Blocked unconditionally: `createContainer`, `pull`, container `remove`. Blocked unless `allowChaos: true` (per-Binding, see D-026): `stop`, `start`, `restart`, `kill`. The wrapper also wraps container handles returned by `getContainer` — violations throw `{ kind: "attach_mode_violation", op }`. This mirrors the kubectl denylist chokepoint in D-018; the loud guarantee is enforced in the adapter, not at call sites.
- **`logs()` and `exists()`** follow the existing Docker deploy implementation verbatim — `container.logs({ follow: true, stdout: true, stderr: true })` with demux, and `container.inspect()` exit-code check. The SPI contract is identical regardless of mode.
- **Must-publish-ports constraint.** Services under test must declare `ports:` in their `docker-compose.yml` (not just `expose:`). `expose` makes ports reachable only within the compose network; without a host-port mapping the adapter has nothing to connect to from the test process. This is a hard requirement — `startAttach` throws `{ kind: "compose_attach_no_host_port", service, containerPort }` when no `HostPort` is found.
- **Type machinery.** `AdapterConfig` gains a `compose?.attach?.{ project, service, containerNumber, port, allowChaos }` slot via the D-022 declaration-merging pattern. An exported `ComposeAdapterConfigSchema` Zod schema mirrors `K8sAdapterConfigSchema` for validation tooling.

Three things are explicitly simpler than K8s attach (D-018, D-021):

1. **No port-forward layer.** Compose publishes host ports natively; the adapter reads `HostPort` directly from the inspect result. No subprocess, no reconnect loop, no local-port-claim window.
2. **Stable ports across stop/start.** `docker stop`/`start` reuses the same container and its port binding — no pod rescheduling, no new container ID, no need for the D-021 reconnection wrapper. `chaos.start` re-inspects `HostPort` and updates the record, but the value is typically identical.
3. **No deployment-equivalent field.** The container itself is the chaos unit; there is no K8s `Deployment` controller to reason about. `chaos.stop` calls `container.stop`; `chaos.start` calls `container.start`. No `scale` verb, no `deployment` config field, no endpoint polling. See D-026.

**Consequences:**
- The petstore example gains a 5th mode (`CYANOTYPE_ADAPTER=docker-attach`) running the same 15-test SLA suite. The thesis "same suite, five substrates" holds.
- Attach mode reads only: `listContainers` (list) + `getContainer` + `inspect` (read). No image pulls, no container creation, no network creation. Safe to run against shared dev stacks.
- The must-publish-ports constraint is a user-facing documentation requirement, not a Cyanotype limitation. Stacks intended for Cyanotype attach mode need `ports:` on each service under test; the adapter surfaces the missing mapping as a typed error at `start` time.
- The denylist chokepoint is unit-tested: `createContainer`, `pull`, `remove` are exercised in attach mode and asserted to throw; chaos verbs are exercised with and without `allowChaos`.
- K8s and Docker Compose attach modes now share the same user-facing pattern (mode flag, per-Binding `adapter` override slot, non-destructive guard, `allowChaos` gate) while each adapter's internal mechanics remain appropriate to its substrate.

---

## D-026. Docker Compose attach-mode chaos — `container.stop`/`start` as the lifted verbs

**Context:** D-018 made attach mode refuse every cluster-mutating verb by default. D-023 added an opt-in chaos path for K8s attach using `kubectl scale deployment/<name>` — a two-field opt-in (`allowChaos: true` + `deployment: "<name>"`) because the K8s controller layer separates the scale knob from the running pod. For Docker Compose the equivalent question is: what is the right chaos unit and what is the right verb?

In Compose, `docker compose stop <service>` / `docker compose start <service>` are the natural verbs. But they require the compose CLI, which is a shellout. The adapter already talks to the daemon via dockerode. The container itself is the unit of disruption: `container.stop()` takes it off the network; `container.start()` brings it back. No Deployment controller exists — the container *is* the service replica. There is nothing analogous to `scale --replicas=0` because there is no controller to hold the outage; stop is the correct hold mechanism.

**Decision:** Attach-mode chaos for Docker Compose is opt-in per Binding via a single field — `adapter: { compose: { attach: { allowChaos: true } } }`. No second field is required (contrast D-023's `deployment` requirement).

Mechanism:

- `chaos.stop(component, instance?)` calls `container.stop()` on the discovered container, then marks the attach record as stopped. The D-025 guard's `stop` verb is lifted when `allowChaos: true` for that specific container handle.
- `chaos.start(...)` calls `container.start()` then re-inspects `NetworkSettings.Ports` to refresh the `HostPort` in the live record (the port value is expected to be stable — see D-025 — but re-inspection is correct regardless). Marks the record as started.
- `chaos.restart(...)` is stop + start sequenced.
- `chaos.stop(...)` with `allowChaos: false` (the default) throws `{ kind: "chaos_unsupported_in_attach_mode" }` — unchanged from the non-chaos-capable guard baseline.

The guard chokepoint from D-025 is lifted selectively: the per-Binding dockerode client (the wrapped client that would normally block `stop`/`start`/`restart`/`kill`) permits those four verbs on the specific container when `allowChaos: true`. `createContainer`, `pull`, and `remove` remain blocked unconditionally regardless of `allowChaos`.

Why no `deployment` analogue: in K8s, `delete pod` against a Deployment is respawned by the ReplicaSet controller in milliseconds, making bare pod deletion useless for holding an outage — hence the requirement to name the Deployment and scale it. In Docker Compose, `container.stop()` is absolute: there is no controller that will restart it. The outage holds until `container.start()` is called explicitly. The two-field requirement of D-023 was structural, not conservative; the Docker Compose substrate does not have the structure that necessitated it.

**Consequences:**
- The opt-in surface is simpler than D-023: one field (`allowChaos: true`) instead of two. The simpler surface is correct for the substrate, not a cut corner.
- From inside the compose network, other services see the stopped container as gone — connections time out or are refused. This is real disruption, not a network-seam pause. Backend-to-backend resilience tests exercise actual failure.
- RBAC has no equivalent for Docker Compose, but the principle holds: with `allowChaos: false` (the default), Cyanotype touches only read operations against the Docker daemon when in attach mode. Safe to use against shared stacks.
- `chaos.start` re-inspects `HostPort` after `container.start()`. If the compose file maps a fixed host port the value is identical; if it maps an ephemeral range (`"8080"` without a host side) the remapped port is picked up correctly.
- All 15 petstore-example tests pass under `CYANOTYPE_ADAPTER=docker-attach`, including chaos-stop+start resilience tests that exercise real container outage.

---

## D-027. `Binding.version` as a cache key — re-ensure invalidates a stale environment

**Context:** `createSharedEnvs` persists a `<envKey>.json` metadata file so a second process re-attaches to a running environment instead of starting its own. The freshness check on a running file is structural — `adapter.exists(sampleContainerId)` confirms the container is alive — and does not consider whether the intent (the binding) has changed. `Binding` carries a `version` field, but without an in-library invalidation hook it has no effect on re-ensure: a bumped `version` does not force a rebuild, and the stale environment is reused. External code that wants to force a rebuild has to delete the library's own state file from outside, reaching into library-owned files because the library exposes no equivalent.

**Decision:** `Binding.version` becomes a cache key for the persisted environment.

- `ComponentSnapshot` gains an optional `version?: string`. `EnvironmentMetadata.schemaVersion` stays `1` — the field is additive and optional.
- The orchestrator threads `version` into `StartSpec` and includes it in the `metadata()` snapshot; `writeMetadataRunning` persists it per component.
- On re-ensure, `startOrAttach`'s attach branch compares each stored snapshot `version` against the live `Binding.version` (`isVersionStale` in `shared.ts`, handling single and multi slots). If both are present and differ, the metadata file is deleted and the ensure loop re-races — exactly the existing dead-container invalidation path.
- In pure `"attach"` mode (`freshAttach`) there is nothing to rebuild, so a version mismatch throws `{ kind: "attach_version_stale", envKey }`, mirroring how that path throws `attach_dead_container`.

**Consequences:**
- If the stored snapshot lacks `version`, the check is skipped. Metadata written before this field existed never false-invalidates a healthy environment. Backward compatibility without a `schemaVersion` bump.
- Consumers stop reaching into `.cyanotype-env/` to force a rebuild; bumping `version` is the supported, in-library invalidation hook.
- `StartSpec.version` is optional, not required: making it required would break adapter unit tests that hand-build a `StartSpec`. The orchestrator always populates it.

---

## D-028. Attach-mode image-drift detection via a configurable `onImageDrift` policy

**Context:** D-027 covers cases where Cyanotype owns the environment and can rebuild it. The orthogonal case is attach mode: another process (a `docker compose` stack) owns the container, and Cyanotype only observes. If that container is running an image other than what the `Binding` declares — a locally rebuilt image, a moved tag — the test silently runs against the wrong substrate. `startAttach` calls `.inspect()` on the discovered container but does not look at its image. Detecting this outside the library means each consumer reaches for `docker image inspect` and stores the expected digest somewhere of its own — work the library is better placed to do once.

**Decision:** The Docker adapter compares the discovered container's image against the `Binding`'s expectation during attach discovery, governed by an `onImageDrift` policy.

- The `DockerContainer.inspect()` return type gains the top-level `Image?` digest field (the Docker daemon already returns it; it was simply untyped).
- `startAttach`'s discovery loop captures the matched container's image (`Config.Image` tag, falling back to the top-level digest) and compares it against `spec.image`/`spec.version`. The comparison is prefix-tolerant — it accepts `repo:tag` vs `repo:tag@sha256:...` so benign ref-shape differences are not flagged.
- `onImageDrift?: "warn" | "fail" | "ignore"` is added to both `DockerAdapterOptions` and the per-Binding `AdapterConfig.compose.attach` slot (with a matching `ComposeAdapterConfigSchema` enum). Resolution is `attach?.onImageDrift ?? opts.onImageDrift ?? "warn"` — per-Binding beats adapter default, mirroring the `allowChaos` precedence from D-025/D-026.
- `"fail"` throws `{ kind: "attach_image_drift", expected, actual, component }` (`AttachImageDriftError`, exported from `src/index.ts`). `"warn"` logs and continues. `"ignore"` skips the check.

**Consequences:**
- The default is `"warn"`, not `"fail"`: attach mode is inherently advisory, and a hard default failure would make Cyanotype brittle against harmless ref differences. `"fail"` is opt-in for CI that demands exact reproducibility.
- `ImageDriftPolicy` and `AttachImageDriftError` are exported alongside the sibling docker types. `attach_version_stale` (D-027) stays an inline discriminated kind — consistent with how the other `attach_*` kinds are not exported as named types.
- Only the Docker adapter implements this; the SPI is unchanged. A K8s-attach equivalent is left for a future ADR.

---

## D-029. `stack.*` observer phase for compose-stack reconciliation telemetry

**Context:** D-024 established the opt-in observer stream — a discriminated union over lifecycle phases (`substrate.* / image.* / container.* / probe.* / environment.* / chaos.*`). The compose-stack reconciliation helper (D-031) performs a multi-step flow — fingerprint check, conditional rebuild, attach — that runs as a silent preflight. Without a dedicated event phase the reconciliation produces no structured signal: there is no record of whether a rebuild happened or how long it took, only whatever the underlying `docker compose` invocation prints.

**Decision:** Add a seventh observer phase, `stack.*`, covering the reconciliation lifecycle: `stack.checking` → either `stack.fresh` or (`stack.stale` → `stack.rebuilding` → `stack.rebuilt`) → `stack.attached`, with `stack.failed` as the failure terminal. Each event carries a `stackName`; `stack.stale` carries `changedFields: readonly string[]` (which fingerprint keys differed), `stack.rebuilt` carries `durationMs`, `stack.attached` carries `serviceCount`, `stack.failed` carries `error: unknown`. The built-in console reporter routes `stack.*` to a `"stack"` label column, parallel to `"substrate"`, using the standard glyph convention.

**Consequences:**
- Purely additive — the discriminated union, `createEmitter`, and every existing reporter pick up the new members for free. No SPI change, zero cost when no observer is attached.
- `stack.stale.changedFields` lets a consumer emit a structured CI annotation without re-computing a fingerprint diff.
- D-031's `reconcileComposeStack` is the first emitter of this phase.

---

## D-030. `cyanotype derive` shipped as a CLI (`bin`) over a copied reference script

**Context:** Attach mode needs a `derived.json` mapping each component to its `compose.attach` / `k8s.attach` adapter override. Shipping the derivation only as a reference script under `tests/petstore-example/scripts/` forces every consumer to copy it verbatim. Copied scripts drift from the library's adapter-config schemas and never receive fixes.

**Decision:** Ship the derive logic in the package.

- The logic moves to `src/cli/derive.ts` as pure, path-in → validated-record-out functions `deriveCompose(path, project?)` and `deriveK8s(path)` — importable by consumers building their own tooling without shelling out.
- `src/cli/index.ts` is a thin dispatch entrypoint (shebang `#!/usr/bin/env bun`): `cyanotype derive compose --compose <f> --out <f|->` and `cyanotype derive k8s --k8s <d|f> --out <f|->`, exit 2 on bad args.
- `package.json` gains `"bin": { "cyanotype": "./dist/cli/index.js" }`. `yaml` moves from `devDependencies` to `dependencies` — the derive library parses YAML at consumer runtime.
- The petstore reference script is reduced to a thin wrapper over `src/cli/derive.ts` — one implementation, identical CLI behaviour, petstore tests unaffected.

**Consequences:**
- Consumers run `bunx @expelledboy/cyanotype derive compose ...` or import `deriveCompose` directly — no copied script to drift.
- `src/cli/` is inside the existing `tsconfig.build.json` `rootDir`, so it compiles to `dist/cli/` with no build-config change.
- This is Cyanotype's first `bin` entry; the package is now a library *and* a CLI. The CLI surface is intentionally minimal (derive only) — future subcommands are additive.

---

## D-031. `reconcileComposeStack` — library-owned compose-stack staleness reconciliation

**Context:** Docker-attach consumers run a preflight before tests: is the `docker compose` stack up to date with its inputs (image tags, the compose file, the stack topology, derived artifacts)? If not, rebuild it. Implemented outside the library this is a few hundred lines per consumer — fingerprint inputs, compare against a stored file, run `docker compose up -d --build` when stale, re-derive adapter config, invalidate the library's metadata. Replicated across consumers it drifts, and the invalidation step has no supported library hook (see D-027).

**Decision:** Ship `reconcileComposeStack(options) => Promise<ReconcileComposeResult>` in `src/compose.ts`.

- `options`: `{ project, composeFile, fingerprint, onStale?, observer?, stateDir? }`. Returns `{ rebuilt, changedFields, durationMs }`.
- **Single job — reconcile, not attach.** The helper brings the compose stack up to date; it does *not* attach an `Environment`. `createSharedEnvs` + `attachEnvironment` remain the caller's untouched next step. No duplication of the orchestrator.
- **`FingerprintSpec` is a named-field record, not an opaque hash** — staleness can report *which* inputs changed, feeding `stack.stale.changedFields`. Two forms: a static list of `{ name, file }` / `{ name, value }` inputs, or an async `() => Record<string,string>` for derived values (e.g. docker image IDs). A missing file hashes to a `"<missing>"` sentinel rather than throwing — an absent derived artifact is a legitimate "must rebuild" state.
- The stack is stale when there is no stored fingerprint, any field changed, or the compose project is not running. Fingerprints persist to `<stateDir>/<project>-stack-fingerprint.json` as a schema-versioned record, written atomically (tmp + rename) — reusing the `shared.ts` crash-safety pattern; a corrupt file throws `{ kind: "stack_fingerprint_corrupt" }`.
- `onStale` runs *after* the rebuild but *before* re-fingerprinting, so post-rebuild derivation (e.g. `deriveCompose`, D-030) is captured by the persisted fingerprint and does not immediately re-trigger staleness.
- Emits the D-029 `stack.*` phase via `createEmitter` verbatim: `stack.checking` → (`stack.fresh` | `stack.stale` + `stack.rebuilding` + `stack.rebuilt`) → `stack.attached`; `stack.failed` on any thrown error. A not-running-but-hash-matched stack reports the synthetic changed field `["<not-running>"]` so the rebuild reason stays visible.

**Consequences:**
- Consumer preflight collapses to a single `reconcileComposeStack` call plus the caller's `fingerprint` field list.
- The helper does not invalidate the library's own `<envKey>.json` metadata. `Binding.version` (D-027) is the supported invalidation hook, so out-of-library `unlinkSync` calls against `.cyanotype-env/` are no longer required.

---

## D-032. Closing the derive→bind seam, the rebuild escape hatch, and the image-drift compare boundary

**Context:** A consumer-repo audit and a code-review pass against D-027..D-031 surfaced three residual seams. (a) `cyanotype derive compose` (D-030) emits a `derived-compose.json` but offers nothing to load it back — every consumer hand-rolls a read-parse-validate-assert loop between the CLI's output and the `bind({ adapter })` call, and tends to invoke it at module load (a footgun: a stray import then throws before any test-runner gating fires). (b) `reconcileComposeStack` (D-031) has no manual override — a CI flag or local "rebuild even if the fingerprint says fresh" knob requires bypassing the library or salting the fingerprint. (c) The attach-mode image-drift compare (D-028) tolerates any prefix relationship between `expected` and `actual`, so `expected="redis"` aligns with `actual="redis-evil:latest"` and `expected="a"` aligns with everything starting with `"a"` — a false negative on real drift.

**Decision:**

- **`loadDerivedCompose(path, expectedKeys)`** — a synchronous public helper that reads the derive JSON, validates each entry against `ComposeAdapterConfigSchema`, asserts every key in `expectedKeys` is present, and returns the loaded map typed as `Record<string, AdapterConfig>` so the consumer can spread per-binding. Three discriminated errors: `derived_compose_missing` (ENOENT), `derived_compose_invalid` (parse or schema failure, with `cause`), `derived_compose_missing_keys` (lists the missing names). Synchronous on purpose: an async loader would tempt consumers to await it at module top level. A sync function makes the throws land where the consumer's own ensure-time setup runs, not at import time.
- **`force?: boolean` on `ReconcileComposeOptions`** — when `true`, skip the fingerprint compare and the running-stack probe and go straight to the rebuild path. The emitted `stack.stale` event reports `changedFields: ["<forced>"]`, mirroring the existing `["<not-running>"]` synthetic marker so reporters render coherently. `onStale` still fires; the post-rebuild fingerprint is still persisted (so the next run can short-circuit normally).
- **Tightened image-drift compare** — replace the bidirectional `startsWith` with exact-or-`@sha256:`-suffix tolerance only: `expected === actual || actual.startsWith(expected + "@sha256:") || expected.startsWith(actual + "@sha256:")`. The only ambiguity worth admitting is the digest suffix shape (`repo:tag` vs `repo:tag@sha256:...`); arbitrary prefix relationships are not.

**Consequences:**
- The F3 derive story (D-030) is now end-to-end: emit JSON → load JSON → `bind({ adapter })`. The hand-rolled loader the consumer audit caught reduces to a single `loadDerivedCompose` call. The sync signature is a load-bearing constraint, not a stylistic choice — it forbids the import-time-throw pattern.
- `force` formalises a knob that consumer repos otherwise improvise (an env-var that bypasses the helper, or a salted fingerprint field that always changes). The synthetic `["<forced>"]` marker keeps the observer/reporter contract symmetric with the existing not-running case.
- The drift compare now flags real drift while still tolerating the digest-suffix shape that motivated the loose check originally. Three test cases pin the boundary: prefix-only refs differ, digest-suffix refs match, single-char prefixes are not absorbed.
- New exported error-kind types: `DerivedComposeMissingError`, `DerivedComposeInvalidError`, `DerivedComposeMissingKeysError`. `loadDerivedCompose` itself is exported from `src/index.ts`.

---

## D-033. Derived adapter config is topology-only; policy lives at the bind site

**Context:** `cyanotype derive compose|k8s` (D-030) walks an infrastructure manifest — a compose YAML or a directory of K8s resources — and emits a binding-keyed JSON of `AdapterConfig` entries the consumer loads at attach time. Through 0.3.1 the derive output included `allowChaos: true` on every entry. The schemas already correctly omitted `onImageDrift` (added in D-028); `allowChaos` had been smuggled in alongside the topology fields by accident of when the CLI was specified. A consumer who ran `bunx @expelledboy/cyanotype derive compose` then `loadDerivedCompose` got chaos opt-in baked into every binding without ever typing the words. Combined with the D-034 lifecycle defect — `runtime.stop` reaching `adapter.stop` when `allowChaos: true` — this meant a default-derived attach session would `docker stop` the operator's stack at suite teardown. Even with D-034 in place, the structural issue remains: a *generated* file is not a place for a policy decision.

**Decision:** Derive output is topology only.

- `deriveCompose` emits `{ compose: { attach: { project?, service, port? } } }` per binding — nothing else. (`containerNumber` is similarly topology and stays whenever it applies.)
- `deriveK8s` emits `{ k8s: { attach: { namespace, service, port, deployment } } }` — nothing else.
- The Zod schemas (`ComposeAdapterConfigSchema`, `K8sAdapterConfigSchema`) keep `allowChaos: z.boolean().optional()` and `onImageDrift: z.enum([...]).optional()`. The schemas describe the *union* of valid fields a bind site may use; the derive functions emit a *subset* — strictly the topology fields.
- Policy fields (`allowChaos`, `onImageDrift`) are set per-binding at the `bind()` call site by the test author. The shipped `loadDerivedCompose` (D-032) returns topology-only adapter config; consumers spread it under the policy they want:
  ```ts
  const derived = loadDerivedCompose(path, ["bankingSim", "payswitch"]);
  bind(bp, {
    adapter: {
      compose: { attach: { ...derived.bankingSim.compose.attach, allowChaos: true, onImageDrift: "fail" } },
    },
  });
  ```
- Regression locked by an assertion in `tests/core/cli-derive.test.ts`: `expect(entry.compose.attach.allowChaos).toBeUndefined()` (and the K8s equivalent). Any future regression that re-introduces a policy field to derive output fails the gate.

**Consequences:**
- **Breaking for consumers who relied on `derive` setting `allowChaos: true`.** Resilience tests that call `chaos.stop`/`chaos.start` against an attach mode must now set `allowChaos: true` explicitly per binding. The petstore reference example (`tests/petstore-example/env.ts`) does this centrally in its `adapterFor` helper, conditional on `IS_DOCKER_ATTACH`/`IS_K8S_ATTACH` — the documented pattern.
- The category boundary is *generated vs. declared*. Derived JSON is a build artifact: a fingerprint-driven snapshot of the substrate's shape. Bind-site config is source code: the test author's deliberate declaration of what Cyanotype is allowed to do. Anything that depends on intent — chaos opt-in, image-drift policy, future authentication choices — belongs in source.
- The schemas remain open to growth. Future policy fields added to `AdapterConfig` are accepted on the bind site without ceremony; derive simply continues to ignore them.

---

## D-034. Container ownership as a first-class SPI property; teardown is detach-only for non-owned containers

**Context:** The Adapter SPI's `start(spec)` returns `Started = { containerId, ports }` — the orchestrator records those into a `ComponentSnapshot` and persists them. In deploy mode the adapter created the container; in attach mode the adapter discovered an existing operator-owned container. The SPI did not distinguish. `finalizeRuntime` carried a `detachOnly: boolean` parameter — `false` from `startEnvironment`, `true` from `attachEnvironment` — that gated whether `runtime.stop()` called `adapter.stop()` on each component. This worked for the pure-attach case (re-attach from snapshot in a second process), but it failed for the common case where a `startOrAttach` runtime is built via `startEnvironment` against a Docker adapter in `mode: "attach"`. Such a runtime has `detachOnly: false` (because it came from `startEnvironment`), so `runtime.stop()` reaches `adapter.stop()`, which in the docker adapter ran a real `docker stop` against the operator's container as soon as `allowChaos: true` was set on the binding. Combined with the D-033 defect (derive shipped `allowChaos: true` by default), a default consumer flow ended every test session with `docker stop` against an attached compose stack.

The lifecycle and chaos concerns were also conflated at the wrong layer. The chaos API (`runtime.chaos.stop/start/restart`) calls `adapter.stop`/`start` directly — that's its job. Suite teardown (`shared.stopAll` → `runtime.stop` → `adapter.stop`) was reusing the same `adapter.stop` path, with `allowChaos` as the only gate. A test author who opted into chaos for one disruption test was implicitly opting into teardown-time destruction for every test in the suite. Two distinct intents — "let one test disrupt this service" and "stop this container when the suite ends" — were ratified by a single flag.

Within the adapters themselves, the inconsistency surfaced: the K8s adapter throws `chaos_unsupported_in_attach_mode` when `adapter.stop` is called on an attach binding without `allowChaos: true`; the Docker adapter silently no-oped. With teardown reaching `adapter.stop`, the silent no-op masked the inconsistency at the cost of leaving misconfigured chaos calls undetected.

**Decision:** Container ownership is declared by the adapter on every `start()` return, propagated through the orchestrator, persisted in the snapshot, and consulted by every teardown path.

- `Started` gains a required `readonly owned: boolean`. The adapter returns `true` when it created the container (Docker deploy, in-memory, K8s deploy) and `false` when it discovered an existing container (Docker attach, K8s attach).
- `ComponentSnapshot` gains optional `readonly owned?: boolean`. Absent is treated as `true` on read — pre-0.4.0 metadata never carried the field and was always Cyanotype-created.
- The orchestrator's `ComponentState` carries `owned: boolean`. `startOne` reads it from the `Started` result of `adapter.start`. `attachOne` (the `attachEnvironment` per-component path) hardcodes `owned: false` regardless of what the snapshot says — the process that called `attachEnvironment` did not start these containers, so its `runtime.stop` must not stop them.
- `finalizeRuntime`'s `detachOnly: boolean` parameter is removed. The `stop()` closure becomes per-component: `if (c.owned && c.containerId) await adapter.stop(...)`. A single uniform rule replaces the previous bimodal flag.
- `shared.ts`'s `stopAllInMeta` (the D-027 version-drift cleanup) skips snapshots where `(snap.owned ?? true) === false`. Version drift in attach mode no longer bulk-stops the operator's stack; pure-attach mode (`mode: "attach"`) continues to throw `attach_version_stale`.
- The chaos API is unchanged. `runtime.chaos.stop/start/restart` continue to call `adapter.stop/start` directly, gated only by `allowChaos` at the adapter. Chaos is the *sole* path that reaches `adapter.stop` for non-owned containers — and only when the bind site explicitly opted in.
- The Docker adapter's silent no-op on `adapter.stop` in attach mode + `allowChaos: false` (previously `if (!b.allowChaos) return;`) is replaced with a throw of `{ kind: "chaos_unsupported_in_attach_mode", message, containerId }`, mirroring the K8s adapter's existing throw. With teardown no longer reaching `adapter.stop` for non-owned containers, the only remaining callers are the explicit chaos verbs — making "chaos call without `allowChaos`" a test-author error, surfaced loudly.
- The metadata snapshot writes `owned: false` only when the component is not owned; the field is omitted when owned. This keeps owned-only environments (the entirety of pre-0.4.0 use) byte-stable with pre-0.4.0 readers — a newer Cyanotype reading older metadata, or vice versa, never trips.
- New invariant test suite at `tests/core/owned-lifecycle.test.ts` (11 cases) pins the rules: `runtime.stop()` on owned calls `adapter.stop`; non-owned does not; mixed environments stop only the owned half; `attachEnvironment` always produces `owned: false` regardless of snapshot; `metadata()` field-presence rules; `stopAllInMeta` honors `owned` on version drift; pre-0.4.0 snapshots (absent field) are treated as owned.

**Consequences:**
- **Breaking SPI change** for any external adapter implementation: `Started.owned` is required. No known external adapters exist; the change forces every implementer to declare the substrate's truth.
- The category boundary is *who created this container?* Not *who attached?*, *what mode is the adapter in?*, *what process is running?* — those are derived. The adapter knows whether it called `createContainer`; only the adapter knows. Surfacing it as `Started.owned` puts the fact at the source of truth.
- Suite teardown becomes a property of the *container*, not a property of the *runtime construction path*. The previous `detachOnly: true | false` parameter was a proxy for ownership inferred from which orchestrator entry built the runtime. Direct measurement replaces inference; per-component granularity replaces per-runtime granularity. Mixed environments (some owned, some attached) compose correctly without ceremony.
- Chaos and teardown are now separable concerns. `allowChaos: true` opts into the test using `chaos.stop("svc")` to disrupt; it does not opt suite teardown into destruction. Test authors who want both still get both; test authors who want chaos for one test no longer pay for it across the suite.
- The docker/K8s asymmetry is closed. Both adapters now throw `chaos_unsupported_in_attach_mode` when chaos is invoked against a non-opted-in attach binding. The silent no-op masked test-author errors; the throw surfaces them.
- One latent K8s issue is noted and deferred: `kubernetesAdapter.teardown()` does not scale a chaos-paused deployment back to `replicas: 1` before cleanup, so a deployment chaos-stopped mid-suite stays at zero replicas after the suite ends. The lifecycle fix here does not address that — it remains an open ADR item if it bites a consumer.

---

## D-035. `derive` emits `attach.port` only for single-port services; the field is a narrow override, not a default

**Context:** `cyanotype derive compose|k8s` emits, per binding, a topology object Cyanotype's attach-mode adapters consume. Both adapters resolve container ports via the same shape: `const portKeys = override?.port !== undefined ? [String(override.port)] : Object.keys(spec.ports)`. Setting `attach.port` therefore *overrides* the binding's `spec.ports` to one key, not *augments* it. Through 0.4.0 the derive functions auto-emitted a single port for every service — picking the first one declared in the compose/k8s manifest. For single-port services the emitted value matched `spec.ports` and the override was a no-op. For multi-port services the emitted value silently disabled resolution for every port except the first. A binding with `spec.ports = { "59220": 59220, "8080": 59221 }` against a network simulator publishing both ports would resolve only `59220` because derive emitted `port: 59220` against the first entry; the binding's `8080` key was silently dropped. The first consumer to wire a multi-port attach stack hit this and worked around it by stripping `port` from derive output for a hand-maintained set of binding keys.

The defect was structural, not a one-off bug. `attach.port` is a *narrow override* — useful when a single binding wants to track only one port of a multi-port service. Emitting it as a default for every service inverted the polarity: the rare override became the implicit default, and the common case (multi-port resolution from `spec.ports`) became impossible without manual stripping.

**Decision:** `deriveCompose` and `deriveK8s` emit `attach.port` only when the underlying compose service / k8s workload publishes exactly one container port. Services with two or more declared ports omit `attach.port` from the derived entry — the binding's `spec.ports` then drives full resolution through the adapter's existing fallback path.

- Compose path (`parseComposeContainerPort`): returns `undefined` when `ports.length !== 1`. Single-port services keep their `port` field; multi-port services omit it.
- K8s path (`deriveK8s`): emits `port` only when `containers[0].ports.length === 1`. A workload with no declared ports is still skipped (no topology signal); a workload with one port emits it; multi-port workloads emit the rest of the entry (`namespace`, `service`, `deployment`) without `port`.
- Both adapters' attach paths are unchanged — `override?.port !== undefined ? [...] : Object.keys(spec.ports)` already does the right thing for both branches.
- Regression locked by two test cases in `tests/core/cli-derive.test.ts`: a fixture with one single-port and one multi-port service asserts `port` is present on the first and `undefined` on the second; the same shape is asserted for K8s.

**Consequences:**
- The common case (multi-port binding in attach mode) now works without any bind-site stripping. The petstore reference example does not change; consumer repos with multi-port attach bindings drop their `MULTI_PORT_ATTACH_KEYS` workaround sets.
- The narrow case (a binding that genuinely wants to track only one port of a multi-port service) still works — the consumer spreads the derived entry and adds `port: <n>` at the bind site, just like any other policy field per D-033. Override-by-extension, not override-by-default.
- `attach-mode.md` makes the polarity explicit in the per-field semantics table: `port` set means "single-port override; ignores `spec.ports`"; `port` absent means "resolve every `spec.ports` key against the running container — correct default for multi-port services". A dedicated "Multi-port attach services" subsection works through the example end-to-end.
- This is a behavior change in derive output but not in the schema or the adapter SPI. A consumer who had relied on derive's first-port emission was already relying on broken behavior — their multi-port bindings were silently resolving only one port. Such consumers get the correct behavior automatically after upgrade.
- The fix is parallel to and complements D-033. D-033 said *policy* fields don't belong in derive output. D-035 says even topology fields emitted by derive must be *correct topology*: a single port for a multi-port service is wrong topology, not a useful default.
