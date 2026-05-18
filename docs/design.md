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
                       └───────────────┘
```

`*` The in-memory adapter resolves `image:Z` against its `{ factories: Record<image, FakeFactory> }` registry — that's how a simulator Binding becomes a running in-process handler. Same Binding shape; the Adapter decides what `image: string` means for the substrate it owns.

## The concept map

Six user-facing entities. Each maps to a TypeScript type. Inference helpers (`defineBlueprint`, `bind`, `createEnvironment`) drive type capture but are not required — plain objects satisfying the types work.

| Entity | What it is | Where |
|---|---|---|
| **`Blueprint<C, E, I, A>`** | The typed contract. Declares port *names*, a factory `(config, env, resolvedPorts) => I`, an optional custom api factory, an `events` catalog, and readiness/health probes. Substrate-agnostic — no `image`, no `mounts`. | `src/blueprint.ts` |
| **`Binding<B>`** | A Blueprint paired with substrate-bound fields: `image`, `version`, `config: C`, `env: E`, host port assignments, optional `mounts`, optional `logParser`, optional `labels`. | `src/binding.ts` |
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
│  Speculum types (src/*.ts)                                      │
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
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
   Docker             Kubernetes         In-memory
   (dockerode)        (future)           (factory registry,
                                          real ports)
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
| `index.d.ts` | Re-exports of all public TYPES | The type contract |
| `index.ts` | Re-exports of all public VALUES (factories, helpers) | The runtime entry |

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
   ─ pick the Adapter — Docker or in-memory — this is the real-vs-fake seam
   ─ `const shared = createSharedEnvs({ "petstore-sla": env }, { adapter, stateDir, mode, getTargetEnv })`

5. Test calls shared.ensure(envKey)
   ─ atomic file claim on <stateDir>/<envKey>.json
   ─ winner: start containers, write metadata, rewrite state to "running"
   ─ loser:  poll metadata until state === "running", then attach
   ─ stale "starting" file (> 90 s) → reclaim
   ─ dead containers (adapter.exists === false) → start fresh
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

**What's out of scope (would require a new ADR to add):**

- Network-level chaos (latency injection, packet loss) — add via Toxiproxy as a user-provided Binding in their environment
- Distributed tracing assertions — different from log-event assertions; would integrate with OTel via a separate concern
- Performance/load testing — out of charter
- Persistent event log / audit trail — explicitly excluded
- Pre-packaged Blueprints (no `PostgresBlueprint`, no `RedisBlueprint`) — users author their own; the contract makes it cheap

## Non-goals worth saying out loud

- Speculum is not a unit-test framework. It runs *inside* Bun/Jest/Vitest.
- Speculum is not a UI test framework. Playwright owns that.
- Speculum does not own the schema authoring story. Zod schemas are user-defined. We just consume them.
- Speculum does not provide pre-packaged service modules. The Blueprint contract makes user-authored definitions cheap.
