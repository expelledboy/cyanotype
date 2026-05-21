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

---

## D-001. Bun-native source; cross-runtime when published

**Context:** The development loop benefits from Bun's fast startup and native TypeScript (`bun:test` is the test runner). But the library's consumers may be on Node — testcontainers-node and adjacent tools live in the Node ecosystem.

**Decision:** Source files use Bun for development and tests. The library code (`src/**/*.ts`) avoids Bun-only APIs and uses cross-runtime primitives (`fetch`, `AbortSignal`, `node:fs`, `dockerode`, `zod`). Test fakes (`tests/fakes/**`) may use `Bun.serve` since they only run in `bun:test`.

**Consequences:**
- `package.json` ships ESM with an `exports` map pointing at `src/index.ts`.
- Consumers on Node can `npm install speculum` and import.
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

**Decision:** `StartSpec.instance?: string` is a typed first-class field on the spec the Adapter receives. The orchestrator sets it from the Binding's instance key. Adapters mirror it into `labels["speculum.instance"]` for teardown discovery. In-memory factories read `spec.instance` directly.

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

- **Workload:** bare `Pod`, not `Deployment` or `Job`. One Pod per `StartSpec`. Speculum owns the lifecycle; restart-on-crash would mask the very failures tests assert on. `containerId` is the Pod name.
- **Mount-as-content (D-008):** one `ConfigMap` per Pod, `data[basename] = content`, mounted via `volumeMounts` with `subPath` to preserve the absolute target path. Labelled identically to the Pod so the label-scan teardown sweeps both.
- **Port exposure:** long-lived `kubectl port-forward pod/<name> :<containerPort>` subprocess. The local port is parsed from kubectl's stdout (`Forwarding from 127.0.0.1:NNNNN -> NNNN`). One subprocess per `StartSpec` port. Avoids NodePort (requires node-IP discovery, breaks on managed clusters) and `hostPort` (requires cluster-side config).
- **Namespace:** single configurable namespace (default `speculum-tests`). Session scoping via labels, not namespace suffix — per-session namespaces churn RBAC and orphan-cleanup logic.
- **Labels** (on Pod and ConfigMap): `speculum=1`, `speculum.session=<uuid>`, `speculum.component=<name>`, `speculum.instance=<name>` when present.
- **Teardown:** `kubectl delete pods,configmaps -n <ns> -l speculum=1,speculum.session=<uuid> --wait=false`. SIGINT/SIGTERM handler (D-014) ported from `src/adapters/docker.ts`, owning the same `globalKnown` / `globalStopFns` discipline plus the set of live port-forward subprocesses.

**Consequences:**
- Deploy mode requires `create,get,list,watch,delete,deletecollection` on `pods` + `configmaps` in the target namespace, plus `pods/log` (get) and `pods/portforward` (create). Documented in `docs/k8s-rbac.md`.
- Pod crashes surface as `exists() === false` (matching the Docker contract). No silent restart.
- Adding a `Deployment`-backed variant later is additive; this ADR doesn't foreclose it.
- The local port held by `kubectl port-forward` is stable for the subprocess's lifetime; if the Pod is rescheduled mid-test, the subprocess exits and `exists()` returns false — the test sees the same failure mode as a Docker container exit.

---

## D-018. Kubernetes adapter — attach mode discovers via Service, refuses cluster mutation

**Context:** Smoke-testing real environments — dev/uat/prod where components are Helm- or Terraform-deployed — needs an adapter that runs the same test suite without provisioning anything. The adapter must be loud-safe: one stray destructive call against prod is catastrophic. Discovery must work zero-config against existing Helm charts; we cannot require chart authors to add speculum-specific labels.

**Decision:**

- **Mode selection at factory time:** `createK8sAdapter({ mode: "deploy" | "attach", ... })`. `SPECULUM_K8S_MODE` env var overrides for CI ergonomics. Mode is a structural property of the adapter instance — matches D-003 (substrate decision is the single seam).
- **Discovery:** convention-based `Service` lookup. The `Service` named `<component>` (or `<component>-<instance>` for multi-instance) in the configured namespace is the resolution target. Helm charts already name Services after components.
- **Explicit override:** a Binding may declare `attach: { namespace, service, port }` to override the convention.
- **`start()` is non-creating.** Resolves the Service via `kubectl get svc <name> -o json`, picks a ready Pod from the EndpointSlice (`kubectl get endpointslices -l kubernetes.io/service-name=<name> -o json`), opens a `kubectl port-forward` against that Pod. `containerId = "attach:<namespace>/<podName>"` so dispatch forks on prefix.
- **`stop()` / `teardown()` are non-destructive.** They close the port-forward subprocess and nothing else. The adapter rejects, at one chokepoint, any `kubectl` invocation whose first subcommand is `apply`, `create`, `delete`, `patch`, `replace`, `edit`, `scale`, or `rollout` while `mode === "attach"`. Violations throw `{ kind: "attach_mode_violation", op, target }`. This is the loud safety guarantee — enforced in the adapter, not at call sites.
- **`logs()`:** `kubectl logs -f --tail=0 <pod> -c <container>` subprocess, stdout streamed via `readline` over `Readable.fromWeb(proc.stdout)`. Identical to the Docker adapter's `AsyncIterable<string>` contract.
- **`exists()`:** `kubectl get pod <name>` exit code (0 = exists, non-zero = gone). On 404 mid-session, re-resolve via the Service's EndpointSlice and update the cached Pod reference. Host-side port stays stable across the re-resolve (the port-forward subprocess restarts under the same local port via re-spawn).

**Consequences:**
- Attach mode needs only read RBAC + `pods/log` + `pods/portforward`. Safe to grant against prod.
- Helm chart authors do not need to add speculum-specific labels for discovery to work.
- Mode-dispatch is at the SPI boundary inside one adapter file, not two parallel adapters — keeps D-003 intact.
- Rolling restarts of the target workload are survivable mid-test.
- The kubectl-subcommand denylist is unit-tested: each destructive verb is exercised in attach mode and asserted to throw.

---

## D-019. `kubectl` shellout, not `@kubernetes/client-node`, for the Kubernetes adapter

**Context:** A spike against OrbStack's local Kubernetes cluster (May 2026) found that `@kubernetes/client-node` cannot authenticate under Bun. The library configures client cert/key on a Node `https.Agent`; Bun's fetch path does not surface agent-supplied cert/key on the wire ([oven-sh/bun#10642](https://github.com/oven-sh/bun/issues/10642), [#9376](https://github.com/oven-sh/bun/issues/9376), [#23985](https://github.com/oven-sh/bun/issues/23985)). The blocker is tracked specifically as [oven-sh/bun#19754 "Cannot use @kubernetes/client-node under bun"](https://github.com/oven-sh/bun/issues/19754), open since May 2025 with no fix. `NODE_EXTRA_CA_CERTS` made TLS handshake succeed; the client cert still never reached the API server and every call returned 401.

A second spike replaced the library with `Bun.spawn` driving `kubectl` directly. Four capabilities passed first attempt: `kubectl get -o json` + JSON parse; pod-exists via exit code; `kubectl port-forward` + 10 sequential local TCP connections; `kubectl logs -f` line streaming. Subprocess teardown via `proc.kill()` + `await proc.exited` was clean; no zombies; no warmup latency.

`kubectl` is the de facto programmatic interface for Kubernetes — stable JSON output via `-o json`, native streaming for `logs -f`, native port-forward, and identical behaviour against OrbStack, kind, EKS, GKE, anywhere it runs. Its surface is more polished than `@kubernetes/client-node` for the operations Speculum needs.

**Decision:** The Kubernetes adapter (`src/adapters/kubernetes.ts`) drives `kubectl` via `Bun.spawn`. All cluster I/O is subprocess I/O — `get -o json` for reads, `apply -f - <<<JSON` for creates, `delete --selector=...` for teardown, `port-forward` for port exposure, `logs -f` for log streaming. No TypeScript Kubernetes client is taken as a dependency.

**Consequences:**
- This **reverses D-013** for the Kubernetes substrate specifically. D-013 chose `dockerode` over CLI shellout for the Docker adapter because Docker's CLI is awkward for programmatic use (incomplete JSON output, ad-hoc flag conventions). The reverse trade-off holds for Kubernetes: `kubectl` is the canonical programmatic interface; the Bun-compatible library option is broken upstream with no committed fix.
- Speculum gains zero new TLS / HTTP / auth code. The runtime trust path is owned by `kubectl`. In-cluster auth, kubeconfig auth, exec-plugin auth, OIDC, AWS IAM auth — all are handled by kubectl, free.
- `kubectl` becomes a runtime dependency of the K8s adapter — documented in the adapter README and `docs/k8s-rbac.md`. CI images must include it.
- Subprocess overhead is non-trivial (~50–150ms per `kubectl get` invocation). Acceptable for test-infrastructure use; not a high-throughput path. Logs and port-forward are long-lived subprocesses, so per-call overhead does not stack there.
- One Bun-specific detail captured for the implementation: `Bun.spawn`'s `proc.stdout` is a web `ReadableStream`. Feed it to `readline` via `Readable.fromWeb(proc.stdout)` — direct use throws `input.on is not a function`. This is a one-line wrapper at every streaming site.
- If `@kubernetes/client-node` becomes Bun-compatible later, switching is internal to the adapter and does not affect the SPI. This ADR is not retired by that change unless we want it to be.

---

## D-020. Kubernetes adapter — per-Pod `Service` for in-cluster DNS

**Context:** D-017 chose bare Pods + `kubectl port-forward` for the deploy-mode Kubernetes adapter. Port-forward gives the test runner on the dev machine a local TCP endpoint to each Pod, but it does nothing for **cross-component traffic inside the cluster.** In the petstore-SLA suite, nginx must reach three petstore Pods, the petstore Pods must reach two redis Pods, and the redis replica must reach the redis primary. The Docker harness solves this with `host.docker.internal:<pinned-host-port>` — every container hops back to the host's published port. That idiom does not translate to Kubernetes: Pods cannot route to the dev machine's localhost, and pinning hostPort across restarts is fragile (TIME_WAIT on chaos restarts, conflicts on multi-suite parallelism).

The K8s-native answer is a `Service` per component instance: a stable in-cluster DNS name (`<component>` or `<component>-<instance>`) that components reference in their env wiring. The same name resolves identically on every Pod in the namespace, regardless of where the target was scheduled.

**Decision:** The deploy-mode adapter creates one `Service` per Pod that has ports, alongside the Pod + ConfigMap from D-017.

- **Naming:** `sanitiseDnsLabel(<speculum.component>[-<speculum.instance>])`. Stable across the test session — restarts of the same component reuse the same Service name.
- **Selector:** the unique per-Pod label `speculum.podname=<podName>`. The adapter writes that label onto the Pod alongside the orchestrator-set labels. This makes the Service 1:1 with its Pod (no risk of cross-instance traffic when two Pods share `speculum.component` + `speculum.instance` — e.g. mid-chaos when an old Pod is terminating while the new one is starting).
- **Ports:** one Service port per `StartSpec.ports` entry, with `port == targetPort == Number(name)`. The K8s adapter's `StartSpec.ports` keys are the container port (D-017).
- **Labels:** the same `speculum=1`, `speculum.session`, `speculum.component`, `speculum.instance` labels the Pod and ConfigMap carry, so the existing label-scan teardown sweeps Services too.
- **Lifecycle:** Service is applied after the Pod becomes Ready (Pod-Ready failures don't leak Services). Service deletion is appended to `stop()` and to the bulk session-teardown (`delete pods,configmaps,services -l speculum=1,speculum.session=<uuid>`).
- **Cross-component env wiring:** `tests/petstore-example/env.ts` switches on `SPECULUM_ADAPTER === "k8s"` and uses the Service DNS names (`redis-primary`, `redis-replica`, `petstore-one|two|three`) on the **container** port (6379, 8080) instead of `host.docker.internal` on the pinned host port. The Docker / in-memory paths are unchanged.
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

A Speculum test holds a reference to `Started.ports[name]` and connects to `127.0.0.1:<port>` repeatedly. The contract that makes test code portable across substrates is that the local port stays the same for the lifetime of the runtime. If the port flaps on every backend churn, test code has to refresh its references — bleeding substrate concerns up into tests.

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

**Context:** Attach mode (D-018) derives the K8s `Service` name from `speculum.component` (+ optional instance) labels. That convention works when the Speculum-internal name matches the real cluster's Service name, but breaks the moment a user attaches to an existing Service whose name was decided by ops (`my-real-prod-nginx`, `payments-api-v2`, etc.). The Binding needs a substrate-specific escape hatch — but stuffing K8s-specific fields onto `Binding` itself bleeds substrate concerns into the substrate-agnostic core, and a generic `Binding<Cfg>` parameter would virally propagate through every helper and test signature.

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
- The opt-in surface gains one required field. Discovery scripts (e.g. `tests/petstore-example/scripts/derive-speculum.ts`) must emit the Deployment name alongside the Service name; the reference derive script does this by finding the Deployment whose `spec.template.metadata.labels` satisfies the Service's `spec.selector`.
- All 15 petstore-example tests pass under attach mode, including the previously-trivially-green resilience tests (which now exercise real failure) and the previously-failing primary-outage test (which now passes for real because petstore Pods actually observe their redis-primary endpoint disappear).
- RBAC for attach + chaos: read everything previously listed in D-018, plus `patch` on `deployments/scale` in the target namespace. Without `allowChaos: true` the read-only attach RBAC is unchanged — still safe against prod.
- `just test-petstore-k8s-attach` chains `deploy → derive → test → teardown` so cluster state is never leaked even when the suite fails. Teardown deletes the entire `speculum-petstore-attach` namespace.
- Cross-namespace attach (D-022) still composes: the paused-attaches registry remains keyed by `${namespace}/${serviceName}` and now also carries the Deployment name and the per-binding kubectl client.


---

## D-024. Framework lifecycle telemetry via an opt-in observer stream

**Context:** Speculum had exactly one notion of "event" — `EventBus<Cat>` / `logParser` (D-006): the *domain events of the system under test*, parsed from container logs, typed against a Blueprint catalog, asserted on by tests. They only exist *after* a container is up and streaming logs.

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
- **Presentation is not Speculum's job (yet).** This decision ships the *stream*, not a reporter. A default terminal progress reporter, a GitHub Actions `::group::` reporter, and a `--timing` phase-breakdown reporter are natural follow-ups that consume `ObserverEvent` without further core changes.
- **Follow-up:** the K8s adapter currently threads the `emit` parameter (signature-compatible) but does not yet emit; wiring `image.*`, `container.*`, and K8s-specific `portforward.*` / `endpoints.*` events is a bounded next step.

---

## D-025. Docker Compose attach adapter — discovery via compose labels + non-destructive guard

**Context:** The Docker adapter (D-013) has always owned a single deploy mode: pull an image, create a container, manage its full lifecycle. After the Kubernetes adapter gained an attach mode (D-018) — point an existing test suite at already-running cluster workloads without provisioning anything — the same pattern became desirable for Docker Compose. A user runs `docker compose up` to stand up their stack, then points the same SLA test suite at those containers without Speculum creating, pulling, or removing anything. The thesis is "same suite, five substrates": in-memory simulator, Docker deploy, Docker Compose attach, Kubernetes deploy, Kubernetes attach.

**Decision:**

- **Mode selection at factory time:** `createDockerAdapter({ mode: "deploy" | "attach", project?: string, ... })`. `mode` mirrors the K8s adapter's `createK8sAdapter` option. Mode is a structural property of the adapter instance — matches D-003. `Adapter.start` dispatches to a private `startAttach` path; the 7-method SPI (D-004) is unchanged.
- **Discovery via Compose labels.** Containers are found via `dockerode.listContainers` filtered on two labels: `com.docker.compose.project=<project>` (the compose project name, defaulting to the directory name) and `com.docker.compose.service=<service>`. By convention the compose service name maps to the Speculum component by name (`speculum.component` label, with optional `--scale` suffix `<service>-<n>`). The `containerNumber` field (default 1) targets a specific scaled instance. A Binding may override any of these via `adapter: { compose: { attach: { project, service, containerNumber, port } } }` — per the D-022 declaration-merging slot.
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
- The petstore example gains a 5th mode (`SPECULUM_ADAPTER=docker-attach`) running the same 15-test SLA suite. The thesis "same suite, five substrates" holds.
- Attach mode reads only: `listContainers` (list) + `getContainer` + `inspect` (read). No image pulls, no container creation, no network creation. Safe to run against shared dev stacks.
- The must-publish-ports constraint is a user-facing documentation requirement, not a Speculum limitation. Stacks intended for Speculum attach mode need `ports:` on each service under test; the adapter surfaces the missing mapping as a typed error at `start` time.
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
- RBAC has no equivalent for Docker Compose, but the principle holds: with `allowChaos: false` (the default), Speculum touches only read operations against the Docker daemon when in attach mode. Safe to use against shared stacks.
- `chaos.start` re-inspects `HostPort` after `container.start()`. If the compose file maps a fixed host port the value is identical; if it maps an ephemeral range (`"8080"` without a host side) the remapped port is picked up correctly.
- All 15 petstore-example tests pass under `SPECULUM_ADAPTER=docker-attach`, including chaos-stop+start resilience tests that exercise real container outage.
