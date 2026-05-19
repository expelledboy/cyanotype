# Axioms

> The load-bearing truths Speculum's design follows. Every decision in `decisions.md` either satisfies these axioms or explicitly retires one. They are not features — they are constraints the problem imposes.

## What Speculum is for

Speculum's central abstraction is the **Component Blueprint** — a typed contract describing what a component exposes (API schemas) and what it observably emits (a log-event catalog). Anything that satisfies the contract — the real production image, a hand-written in-process simulator, a prior version, a vendor-compatible alternative — is a valid **Binding** for that Blueprint.

A test file consumes the Blueprint surface (`runtime.X.api.method(...)`, `runtime.X.events.waitFor("...")`). It never names a Docker image, a port, a config file, or a substrate. The Adapter is the seam where substrate (Docker / Kubernetes / in-memory) is decided, and it is also where real-vs-simulator is decided: the Adapter interprets the Binding's `image: string` against the substrate it owns. One harness-level line flips a whole suite between real containers and in-process simulators — test code unchanged.

The two halves of that promise:

1. **A Blueprint declares a contract** — multi-protocol API surfaces with typed schemas, plus a typed event catalog. The contract carries no `image`, no `mounts`, no `env` values. Substrate-agnostic by construction.
2. **A Binding instantiates the Blueprint against a substrate** — pairs it with `image`, host port assignments, `env`, optional `mounts`, and a per-Binding `logParser` that converts the Binding's specific log format into the Blueprint's typed event catalog.

What this enables:

- **Fast inner-loop + high-trust outer-loop.** Develop against an in-process simulator binding (milliseconds per test). CI runs the identical suite against the real Docker binding (high confidence). No two test suites to maintain; no mock-vs-real drift.
- **Cross-implementation contract verification.** Multiple Bindings claiming the same Blueprint can be tested against the same suite — version-to-version, vendor-to-vendor, real-vs-simulator. The Blueprint is the cross-implementation contract.
- **Failure-mode coverage as code.** Because the Blueprint contract requires that tests own container lifecycle, container-level chaos becomes an `expect()` away. Real failover, primary-down semantics, p95 SLA assertions on real traffic — all in the same test file as the happy path.

## The seven forces

The seven forces are the constraints the Blueprint contract structurally imposes on any honest implementation. They group into three concerns: what the **contract** declares, what the **substrate** must support, and what the **test infrastructure** must provide.

### Group A — What the contract declares

#### A1. Multi-protocol API surfaces with typed schemas

A Blueprint can declare HTTP routes, raw-socket endpoints, or future TCP/SOAP/gRPC protocols — each carries its own schema and resolves to a typed client at the call site. The typed client is derived at runtime from the declared schema; no codegen step, no committed generated files. The user calls `runtime.X.api.http.createPet({ name })` and TypeScript knows the argument shape and return type from the route map.

Without this, the API drift between schema and tests is silent: refactoring a request shape doesn't break tests; the wrong response field name compiles fine and fails at runtime.

#### A2. Typed event catalogs from logs

A Blueprint declares the events it emits with per-event-name Zod schemas describing attribute shapes. A per-Binding `logParser` converts raw stdout lines into events that conform to the catalog. Tests call `runtime.X.events.waitFor("EVENT_NAME", { attributes: { status: 503 } }, 5_000)` with fully-typed attribute filters — wrong field names are compile errors.

Without this, log-event assertions are regex-greps that drift the moment anyone changes a log format. The events catalog is the contract; the parser per Binding makes "different log formats, same typed events" honest.

### Group B — What the substrate must support

#### B1. Substrate portability via the Adapter SPI

A single test file runs identically against Docker locally, an in-memory adapter for fast inner-loop, and a Kubernetes adapter for CI (deploy or attach mode). The Adapter SPI is seven methods (`connect` / `disconnect` / `teardown` / `start` / `stop` / `logs` / `exists`), and it is the *only* place real-vs-fake or Docker-vs-K8s is decided. Bindings declare `image: string`; adapters interpret what that means.

Without this, every team rewrites integration tests for staging or pays for two suites that drift.

#### B2. Mount-as-content config injection

Container config files are generated as **strings in TypeScript** (e.g. nginx config that references the resolved petstore host ports) and the Adapter writes them to bind-mounted tmpfiles. This is the mechanism for cross-container wiring (nginx → 3× petstore, redis replica → primary) without docker-compose's network layer or static host paths.

Without this, dynamic test topologies require pinning ports up front or writing config files to known host locations before the test runs.

#### B3. Multi-instance composition

Components can have named instances. `runtime.redis.primary` and `runtime.redis.replica` are first-class addresses with their own typed surfaces. Same for `runtime.petstore.one` / `.two` / `.three`. The instance argument on `runtime.chaos.stop("redis", "primary")` is required for multi-instance slots and prohibited for single-instance, enforced at compile time.

Without this, you cannot test replication, sharding, load-balanced topologies, or any pattern that requires distinguishing instances.

### Group C — What test infrastructure must provide

#### C1. Cross-process registry

Multiple test worker processes (Bun's `bun test` is per-file; Jest is per-worker) coordinate through one JSON metadata snapshot on disk. First worker starts containers and writes metadata; subsequent workers attach. The race is at invocation boundaries — concurrent terminals, watch mode, Jest workers — and is resolved by an atomic `O_CREAT|O_EXCL` claim with a staged state lifecycle ("starting" → "running") and a 90-second staleness threshold for crashed-mid-start recovery.

Without this, every worker starts its own copy of every container — catastrophic for any non-trivial environment, and brittle when the previous run was interrupted.

#### C2. Test-owned container lifecycle

Tests `start` / `stop` / `restart` containers themselves. No external `docker-compose up` step. This is what makes chaos and failover testing possible at all: you cannot kill a container mid-test if you don't own it.

Without this, integration tests cover the happy path; the failure modes that actually matter in production get tested by hand, or not at all.

## What dropping any force costs

| Force | What breaks if dropped |
|---|---|
| A1 typed APIs | Schema drift between contract and tests becomes silent |
| A2 typed events | Log-event assertions become regex-greps that drift silently |
| B1 Adapter SPI | Real-vs-simulator and Docker-vs-K8s become test-file concerns |
| B2 mount-as-content | Cross-container wiring requires host-path coordination |
| B3 multi-instance | Replication / sharding / load-balanced topologies are unaddressable |
| C1 cross-process registry | Parallel test workers conflict on containers |
| C2 lifecycle ownership | Chaos and failover become external tooling, not test code |

Each force is required for the Blueprint contract to be honestly satisfiable. The forces are not independent feature requests — they are what taking the contract seriously means in practice.

---

**Next:** see [`design.md`](./design.md) for how these forces shape the type layout, the orchestrator, and the Adapter SPI. See [`decisions.md`](./decisions.md) for the concrete decisions each axiom forced.
