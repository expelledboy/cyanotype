# Design

> How the pieces fit. Reads top-down: from user test code, through types, through the orchestrator, to the Adapter, to the substrate.

## The seam diagram

```
      ┌───────────────────────────────────────────────────┐
      │  Test file (substrate-blind, binding-blind)       │
      │  runtime.petstore.api.http.createPet({...})       │
      │  runtime.petstore.events.waitFor("PAYMENT_OK")    │
      │  runtime.chaos.stop("redis", "primary")           │
      └──────────────────────────┬────────────────────────┘
                                │   uses Blueprint surface
                                ▼
                         ┌─────────────┐
                         │  Blueprint  │   (typed contract — A1 + A2)
                         └──────┬──────┘
                                │   satisfied by ≥ 1
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
         ┌────────────┐  ┌────────────┐  ┌────────────┐
         │  Binding   │  │  Binding   │  │  Binding   │
         │  real v1   │  │  real v2   │  │ simulator  │
         │  image:X   │  │  image:Y   │  │  image:Z*  │
         └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
               │               │               │
               ▼               ▼               ▼
                       ┌───────────────┐
                       │    Adapter    │   (substrate seam — B1)
                       │  Docker / K8s │
                       │  / in-memory  │
                       │  / Compose    │
                       └───────────────┘
```

`*` The in-memory adapter resolves `image:Z` against its `{ factories: Record<image, FakeFactory> }` registry — that's how a simulator Binding becomes a running in-process handler. Same Binding shape; the Adapter decides what `image: string` means for the substrate it owns.

## The concept map

Six user-facing entities. Each maps to a TypeScript type. Inference helpers (`defineBlueprint`, `bind`, `createEnvironment`) drive type capture but are not required — plain objects satisfying the types work.

| Entity | What it is | Where |
|---|---|---|
| **`Blueprint<C, E, I, A>`** | The typed contract. Declares port *names*, a factory `(config, env, resolvedPorts) => I`, an optional custom api factory, an `events` catalog, and readiness/health probes. Substrate-agnostic — no `image`, no `mounts`. | `src/blueprint.ts` |
| **`Binding<B>`** | A Blueprint paired with substrate-bound fields: `image`, `version`, `config: C`, `env: E`, host port assignments, optional `mounts`, optional `logParser`, optional `labels`, optional `adapter?: AdapterConfig` (adapter-specific overrides — see [Adapter-specific Binding config](#adapter-specific-binding-config-d-022) below). | `src/binding.ts` |
| **`Environment`** | A record of named Bindings or multi-instance groups (`Record<instance, Binding>`). The composition. `createEnvironment(record)` validates reserved names. | `src/environment.ts` |
| **`Runtime<E>`** | What `startEnvironment` / `attachEnvironment` returns. Type-derived from the Environment. Components at the top level + `chaos` / `snapshot` / `metadata` / `stop` system ops. Exposes the Blueprint surface only — Binding substrate fields are invisible. | `src/runtime.ts` |
| **`Adapter`** | The IO boundary, and the single point where real-vs-fake is decided. Docker / K8s / in-memory implementations. Seven methods. | `src/adapter.ts` |
| **`SharedEnvs`** | The multi-env, multi-process registry. `createSharedEnvs(registry, options)` returns a handle with `ensure` / `attach` / `use` / `stopAll`. | `src/shared.ts` |

## The layer map

```
┌─────────────────────────────────────────────────────────────────┐
│  User test code                                                 │
│  ─────────────                                                  │
│  const runtime = await shared.ensure("petstore-sla");           │
│  await runtime.chaos.stop("redis", "primary");                  │
│  const pet = await runtime.petstore.one.api.http.createPet(…);  │
│  const ev  = await runtime.petstore.one.events.waitFor(…);      │
└─────────────────────────┬───────────────────────────────────────┘
                          │  Public API (src/index.ts + src/index.d.ts)
┌─────────────────────────┴───────────────────────────────────────┐
│  Cyanotype types (src/*.ts)                                      │
│  ──────────────                                                 │
│  Blueprint ◀── Binding ◀── Environment ◀── Runtime<E>           │
│      │            │           │              │                  │
│      │            │           │              ├── ChaosControls  │
│      │            │           │              └── snapshot, stop │
│      │            │                                             │
│      │   substrate fields (Binding):                            │
│      │     ├── image, version                                   │
│      │     ├── ports: { [name]: "auto" | number }               │
│      │     ├── env, mounts, labels                              │
│      │     └── logParser?                                       │
│      │                                                          │
│      contract fields (Blueprint):                               │
│      ├── portNames: readonly portName[]                         │
│      ├── interface: (config, env, resolvedPorts) => Iface       │
│      ├── api?:      (iface, helpers) => CustomApi               │
│      ├── events?:   EventCatalog                                │
│      └── readiness?, health?                                    │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────────┐
│  Orchestrator (src/orchestrator.ts)                             │
│  ────────────                                                   │
│  - Lifecycle dispatch: startEnvironment / attachEnvironment     │
│  - Per-binding setup: port resolution, mount tmpfiles, env wire │
│  - Interface enrichment (auto-host/port from URI)               │
│  - Probe runner (HTTP + custom)                                 │
│  - Log stream multiplexer → binding.logParser → typed events    │
│  - Chaos control: typed stop/start/restart by name + instance   │
│  - Snapshot: a getter that walks the live registry              │
└─────────────────────────┬───────────────────────────────────────┘
                          │  Adapter SPI (seven methods)
┌─────────────────────────┴───────────────────────────────────────┐
│  Adapter (src/adapter.ts — type only here; impls separate)      │
│  ───────                                                        │
│  - connect / disconnect / teardown      (session lifecycle)     │
│  - start / stop / logs / exists         (per-container)         │
│                                                                 │
│  The substrate seam, and the only place where real-vs-fake is   │
│  decided. Bindings declare image strings; adapters interpret.   │
└─────────────────────────┬───────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┬───────────────────┐
       ▼                  ▼                  ▼                   ▼
   Docker             Kubernetes         In-memory          Docker Compose
   (dockerode,        (kubectl,          (factory registry, (dockerode,
    deploy mode)       D-019;             real ports)        attach mode;
                       deploy +                              D-025, D-026)
                       attach modes)

   Composite (D-038) wraps any of the above and routes per component or
   per instance, so one Environment can span substrates — the component
   under test real, its dependencies simulated.
```

## The supporting types

Smaller pieces that live in their own files:

| File | Owns | Why a separate file |
|---|---|---|
| `protocol.ts` | `Protocol` discriminated union, `HttpRouteMap`, `HttpClient<R>`, `ApiOf<P>` | Multi-protocol heart; new protocols are new cases here |
| `interface.ts` | `Interface<P>`, `InterfaceRecord`, `ApiFromInterface<I>` | Multi-interface story; type-derivation lives here |
| `helpers.ts` | `HelperContext`, `HttpHelpers` | Passed to custom api factories; expands as new protocols add helpers |
| `events.ts` | `EventCatalog`, `Event<Cat, K>`, `EventBus<Cat>`, `LogParser` | Per-component typed event bus |
| `probe.ts` | `Probe<I>` (HTTP + custom), `runProbe` | Lives on Blueprint (readiness/health are part of the contract) |
| `metadata.ts` | `EnvironmentMetadata`, `SlotSnapshot`, `ComponentSnapshot` | Cross-process JSON snapshot; one concept, one file |
| `invariants.ts` | `invariant`, `enableInvariants` | Cross-module agreements types cannot state; off unless enabled (D-042) |
| `index.d.ts` | Re-exports of all public TYPES | The type contract |
| `index.ts` | Re-exports of all public VALUES (factories, helpers) | The runtime entry |

## Adapter-specific Binding config (D-022)

The Binding shape stays substrate-agnostic by construction. But some substrates have legitimate per-Binding configuration that doesn't belong in the core: a K8s attach Binding may need to override the Service name when the real cluster's name doesn't match the Cyanotype component label; a future Terraform-discovered Binding may need an endpoint hint; a Docker Binding may want to specify a network. Stuffing those onto `Binding` itself bleeds substrate concerns into the core, and a generic `Binding<Cfg>` parameter would virally propagate through every helper signature.

Resolved via TypeScript declaration merging:

```ts
// src/adapter.ts (core — substrate-agnostic)
export interface AdapterConfig {}                  // open, empty
export type StartSpec = { /* ... */ ; adapterConfig?: AdapterConfig };

// src/binding.ts
export type Binding<B> = { /* ... */ ; readonly adapter?: AdapterConfig };

// src/adapters/kubernetes.ts (each adapter augments from its own module)
declare module "../adapter" {
  interface AdapterConfig {
    k8s?: { attach?: { namespace?: string; service?: string; port?: number;
                       allowChaos?: boolean; deployment?: string } };
  }
}

// src/adapters/docker.ts (Docker Compose attach — D-025, D-028)
declare module "../adapter" {
  interface AdapterConfig {
    compose?: { attach?: { project?: string; service?: string;
                           containerNumber?: number; port?: number;
                           allowChaos?: boolean;
                           onImageDrift?: "warn" | "fail" | "ignore" } };
  }
}
```

Use sites:

```ts
// K8s attach — override Service name + opt in to real cluster chaos
bind(petstoreBlueprint, {
  image: "...", version: "...", config: {...}, env: {...}, ports: {...},
  adapter: { k8s: { attach: { service: "pet-svc-1", deployment: "pet-svc-1", allowChaos: true } } },
});

// Docker Compose attach — override compose project + service name, opt in to chaos
bind(petstoreBlueprint, {
  image: "...", version: "...", config: {...}, env: {...}, ports: {...},
  adapter: { compose: { attach: { project: "my-stack", service: "api", allowChaos: true } } },
});
```

Each adapter reads its own top-level key (`spec.adapterConfig?.k8s?.attach`, `spec.adapterConfig?.compose?.attach`) and ignores the rest. The two slots never collide.

Properties:
- The core stays generic-free — `Binding<B>` already carries one variance-sensitive type parameter and adding a second was a non-starter under `strictFunctionTypes`.
- Adapter additions are zero-cost on the core: a new adapter contributes a `declare module` block in its own file. No central registry, no enum, no switch.
- Users importing a Binding from an adapter-aware module get the merged interface automatically.
- The orchestrator's `buildSpec` forwards `binding.adapter` into `StartSpec.adapterConfig`; each adapter reads its own top-level key and ignores the rest.

Adapters that consume overrides honour them per-field, falling back to convention for any unset field. The K8s attach mode demonstrates this: omit `service` to fall back to label-derived discovery, omit `namespace` to use the adapter default, set `allowChaos: true` to opt in to real cluster chaos (which then requires `deployment` — see D-023). The Docker Compose attach mode is simpler: `allowChaos: true` alone is sufficient, because the container is the chaos unit and no controller name is needed (see D-026). The K8s walkthrough is in [`attach-mode.md`](attach-mode.md).

See [D-022](decisions.md#d-022-adapter-specific-binding-config-via-typescript-declaration-merging), [D-025](decisions.md#d-025-docker-compose-attach-adapter--discovery-via-compose-labels--non-destructive-guard), [D-026](decisions.md#d-026-docker-compose-attach-mode-chaos--containerstopstart-as-the-lifted-verbs).

## The lifecycle

```
1. User defines Blueprints
   ─ `const petstoreBlueprint = defineBlueprint({ portNames: ["http"], interface: (c, e, ports) => ({...}), events, readiness })`
   ─ pure contract: no image, no mounts, no env values

2. User writes binding factories
   ─ `const petstore = (cfg) => bind(petstoreBlueprint, { image, version, config: cfg, env, ports: {http: cfg.httpPort}, logParser })`
   ─ swap the image string and (optionally) the logParser for a simulator binding

3. User composes an Environment
   ─ `const env = createEnvironment({ redis: { primary: ..., replica: ... }, petstore: { one: ..., two: ... } })`
   ─ multi-instance is a nested record of Bindings; single-instance is just a Binding
   ─ reserved component names (start, stop, snapshot, metadata, chaos) are rejected at construction

4. User wires the harness
   ─ pick the Adapter — Docker (deploy), Docker Compose (attach), Kubernetes (deploy or attach), or in-memory — this is the real-vs-fake seam
   ─ `const shared = createSharedEnvs({ "petstore-sla": env }, { adapter, stateDir, mode, getTargetEnv })`

5. Test calls shared.ensure(envKey)
   ─ atomic file claim on <stateDir>/<envKey>.json
   ─ winner: start containers, write metadata, rewrite state to "running"
   ─ loser:  poll metadata until state === "running", then attach
   ─ stale "starting" file (> 90 s) → reclaim
   ─ different substrate (metadata.adapter !== adapter.name) → start fresh (D-041)
   ─ dead containers (adapter.exists === false) → start fresh
   ─ bumped Binding.version → stop those containers, then start fresh (D-027)
   ─ runs Blueprint readiness probes
   ─ wires log streams → binding.logParser → typed event buses
   ─ returns a Runtime<E> handle (typed from the literal env type)

6. Test interacts (Blueprint surface only — Binding is invisible)
   ─ runtime.svc.api.method(...) — typed call
   ─ runtime.svc.events.waitFor(...) — typed event assertion
   ─ runtime.chaos.stop(name, instance?) — typed disruption

7. Suite ends
   ─ shared.stopAll() — stop owned containers, delete metadata
   ─ adapter.teardown() — label-scan stragglers from any crashed runs
   ─ adapter.disconnect() — release session resources
```

## The observer stream (D-024)

Two unrelated things are both called "events" in Cyanotype — keep them apart:

| | `EventBus<Cat>` (D-006) | Observer stream (D-024) |
|---|---|---|
| Models | domain events of the system under test | framework's own lifecycle |
| Typed by | the Blueprint's event catalog | a fixed `ObserverEvent` union |
| Scope | per component | cross-cutting (substrate + every component) |
| Source | container logs → `logParser` | orchestrator + adapters |
| Consumer | tests (`events.waitFor(...)`) | a reporter (progress / CI / timing) |
| Exists | only once a container streams logs | from `environment.starting` onward |

The observer stream answers "why is provisioning slow / where did the time go".
It is **opt-in** — pass `observer` on `OrchestratorOptions`, or on
`SharedOptions` (`createSharedEnvs` forwards it); omitted = zero cost, silent.
`createEmitter` stamps the envelope (`seq`, `at`, `adapter`, and the
`component`/`instance`/`envKey` scope) centrally, so a reporter receives one
stable total order even across concurrent component starts.

```
environment.starting
  substrate.connecting → substrate.connected
  per component:
    image.resolving → (image.cache_hit | image.pull_started
                       → image.pull_progress* → image.pulled)
    container.creating → container.created → container.starting → container.started
    probe.started → probe.attempt* → (probe.ready | probe.timed_out)
    environment.component_ready
environment.ready          (or environment.failed at any phase)
chaos.stopping/stopped/starting/started   — on runtime.chaos.*

stack.checking → (stack.fresh | stack.stale → stack.rebuilding → stack.rebuilt)
              → stack.attached                                — on reconcileComposeStack
stack.failed   — on any thrown error during reconciliation
```

Substrate-internal events (`image.*`, `container.creating/created/starting/started`)
flow through an optional `emit` parameter on `Adapter.start`; everything else
the orchestrator emits directly. The SPI stays at seven methods (D-004) — `emit`
is a trailing optional argument.

**Emitting them is optional, and only the Docker adapter does today.** `emit` is
an optional parameter, so an adapter that ignores it still satisfies the SPI —
the Kubernetes adapter's `start` does not declare it and emits nothing. Under
Kubernetes a reporter therefore sees the orchestrator-level events only
(`probe.*`, `environment.*`, `chaos.*`) and no image or container phases. That
is a real gap rather than a design choice: it means the stream cannot answer
"where did the time go" on the substrate whose provisioning is slowest.

A throwing reporter is isolated inside `createEmitter` — telemetry never breaks
the thing it observes. Cyanotype ships one reference consumer,
`createConsoleReporter()` (`src/reporter.ts`), which renders the stream as
readable stderr lines (live per-layer pull bar on a TTY); pass it — or any
`(e: ObserverEvent) => void` — as `observer`.

## How types flow

Three flows worth understanding because they are where the TypeScript power earns its keep.

### Flow 1: Blueprint → typed API client

```ts
const petstoreRoutes = {
  createPet: { method: "POST", path: "/pets", request: CreatePetInput, response: PetSchema },
  getPet:    { method: "GET",  path: (id: string) => `/pets/${id}`,    response: PetSchema },
} as const satisfies HttpRouteMap;

const petstoreBlueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (config, env, resolvedPorts) => ({
    http: iface({
      uri: `http://localhost:${resolvedPorts.http}`,
      protocol: http(petstoreRoutes),
    }),
  }),
  events: petstoreEvents,
  readiness: { interfaceName: "http", path: "/health" },
});
```

The literal type of `petstoreBlueprint` carries the specific `routes` type through `Blueprint.interface`'s return type, and that flows through every `Binding` that wraps it. `ApiFromInterface<I>` extracts:

- `Iface["http"]["protocol"]` → `{ kind: "http"; routes: typeof petstoreRoutes }`
- `ApiOf<HttpProtocol<R>>` → `HttpClient<R>`
- `HttpClient<R>` → mapped type producing one method per route
- Each method's args come from `PathArgs<R>` + `BodyOf<R>` (body if POST/PUT/PATCH)
- Return type comes from `R["response"]` or `R["responseMode"]`

Net result: `runtime.petstore.one.api.http.createPet({ name: "Fido" })` typechecks with request `{ name: string }` and response inferred from `PetSchema`.

### Flow 2: Environment → typed Runtime

```ts
const env = createEnvironment({
  redis:    { primary: redis({...}), replica: redis({...}) },
  petstore: { one: petstore({...}), two: petstore({...}), three: petstore({...}) },
});
```

`Runtime<typeof env>` derives:

- `redis` (multi-instance slot) → `{ primary: Running<...>, replica: Running<...> }`
- `petstore` (multi-instance slot) → `{ one: Running<...>, two: Running<...>, three: Running<...> }`
- Plus `chaos`, `snapshot`, `metadata`, `stop` as siblings.

The `Running<B>` shape is derived from the Binding's Blueprint — only the Blueprint contributes to the runtime surface (the Binding is consumed by the orchestrator, not exposed to tests):

```ts
Running<B> = {
  ports: Record<string, number>;
  interface: IfaceOf<B>;
  api: ApiOfBlueprint<B>;
  events: EventsOf<B> extends EventCatalog ? EventBus<EventsOf<B>> : undefined;
};
```

### Flow 3: ChaosControls — type-safe args

```ts
runtime.chaos.stop("redis", "primary");   // ✓ — multi-instance, instance required
runtime.chaos.stop("redis");              // ✗ — missing instance (compile error)
runtime.chaos.stop("redis", "tertiary");  // ✗ — not in { primary, replica }
runtime.chaos.stop("nginx");              // ✓ — single-instance, no instance arg
runtime.chaos.stop("nginx", "one");       // ✗ — instance arg not allowed for single-instance
runtime.chaos.stop("typo");               // ✗ — not a component name
```

The `ChaosArgs<E, K>` conditional discriminates single-instance from multi-instance slots and produces the right argument tuple.

## Boundaries

**What's in scope:**

- Blueprint contract definition (typed APIs + typed events)
- Binding instantiation against a substrate
- Environment composition (single and multi-instance)
- Lifecycle (start / stop / restart / attach)
- Typed API derivation from declared schemas
- Typed event bus from log catalog declarations
- Multi-instance composition
- Multi-protocol per component
- Cross-process registry via JSON metadata
- Chaos primitives at the container level
- Mount-as-content config injection
- Per-Binding adapter-specific configuration via TypeScript declaration merging (D-022)
- One Environment spanning several substrates, routed by component and instance (D-038)
- Attach to pre-deployed substrates with verified non-destructive guarantees, plus an opt-in for real chaos — Kubernetes (D-018, D-022, D-023) and Docker Compose (D-025, D-026)

**What's out of scope (would require a new ADR to add):**

- Network-level chaos (latency injection, packet loss) — add via Toxiproxy as a user-provided Binding in their environment. Pod-level chaos against pre-deployed K8s workloads IS supported via the attach-mode opt-in (D-023).
- Distributed tracing assertions — different from log-event assertions; would integrate with OTel via a separate concern
- Performance/load testing — out of charter
- Persistent event log / audit trail — explicitly excluded
- Pre-packaged Blueprints (no `PostgresBlueprint`, no `RedisBlueprint`) — users author their own; the contract makes it cheap

## Non-goals worth saying out loud

- Cyanotype is not a unit-test framework. It runs *inside* Bun/Jest/Vitest.
- Cyanotype is not a UI test framework. Playwright owns that.
- Cyanotype does not own the schema authoring story. Zod schemas are user-defined. We just consume them.
- Cyanotype does not provide pre-packaged service modules. The Blueprint contract makes user-authored definitions cheap.
