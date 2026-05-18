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
