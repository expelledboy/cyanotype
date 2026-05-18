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
