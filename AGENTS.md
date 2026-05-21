# AGENTS.md

Speculum — Bun-native test harness built around the **Component Blueprint**: a typed contract (API schemas + event catalog) that multiple Bindings (real container, in-process simulator) satisfy. The Adapter is the substrate seam.

Read in this order if you have time: [`docs/axioms.md`](docs/axioms.md) → [`docs/design.md`](docs/design.md) → [`CONVENTIONS.md`](CONVENTIONS.md).

## Commands

```sh
bun install                    # one-time
just typecheck                 # tsc --noEmit
just test-core                 # in-memory adapter only, no Docker images
just build-test-images         # one-time: builds petstore + redis-configurable
just test                      # full suite against real Docker
just clean-containers          # manual reset; not needed on the normal path
```

`bun test` alone is sufficient — `tests/preload.ts` handles teardown.

## File map

| Concern | File |
|---|---|
| Blueprint contract | `src/blueprint.ts` |
| Binding instantiation | `src/binding.ts` |
| Environment composition | `src/environment.ts` |
| Adapter SPI | `src/adapter.ts` |
| Framework lifecycle observer stream (D-024) | `src/observer.ts` |
| Built-in console reporter for the observer stream | `src/reporter.ts` |
| Orchestrator (start/attach/chaos) | `src/orchestrator.ts` |
| Multi-env registry | `src/shared.ts` |
| Docker adapter (deploy + Compose attach modes) | `src/adapters/docker.ts` |
| In-process simulator adapter | `src/adapters/memory.ts` |
| K8s adapter (deploy + attach modes, reconnection layer) | `src/adapters/kubernetes.ts` |
| kubectl subprocess wrapper (D-019) | `src/adapters/kubectl.ts` |
| Public surface | `src/index.ts` (`.d.ts` is tsc-emitted at build) |
| End-to-end smoke (runs across all five adapters) | `tests/petstore-example/` |
| Harness self-tests | `tests/core/` |
| Test setup/teardown hooks | `tests/preload.ts` (registered in `bunfig.toml`) |
| K8s + Docker Compose attach walkthrough | `docs/attach-mode.md` |
| K8s RBAC + cluster setup | `docs/k8s-rbac.md` |

## Hard rules

- **Comments:** default to none. Add one only when the *why* is non-obvious — a hidden constraint, a workaround for a specific bug, behaviour that would surprise a reader. Instead of `// stop the container`, name the variable so the line reads itself.
- **Assertions:** validate at boundaries; trust types internally. Instead of `assert(name != null)` in the orchestrator, use the boundary check `createEnvironment` already performs.
- **`any`:** only in variance-widener positions. Use the existing `biome-ignore lint/suspicious/noExplicitAny` line with a one-line reason.
- **Errors:** tagged objects, not classes. `throw { kind: "probe_timeout", lastError, elapsedMs }` — never `throw new Error(...)` except for "this should be impossible" cases.
- **Tests:** `expect(...)` only. No `sleep(N)`-style waits — use `waitFor(predicate, opts)` from `tests/petstore-example/test-helpers.ts`.
- **ADRs:** append-only. Never edit an existing entry in `docs/decisions.md`. If a decision is wrong, write a new ADR that retires it.

## Canonical pattern

A component is a Blueprint (contract) wrapped by a Binding factory (substrate-bound instantiation):

```ts
const petstoreBlueprint = defineBlueprint({
  portNames: ["http"] as const,
  interface: (cfg, env, ports) => ({
    http: iface({ uri: `http://localhost:${ports.http}`, protocol: http(petstoreRoutes) }),
  }),
  events: petstoreEvents,
  readiness: { interfaceName: "http", path: "/health" },
});

const petstore = (cfg: PetstoreCfg) => bind(petstoreBlueprint, {
  image: "speculum/petstore:latest", version: "latest",
  config: cfg, env: { PORT: "8080", ... },
  ports: { http: cfg.httpPort },
  logParser: petstoreJsonLogParser,
});
```

`defineBlueprint` uses TS 5.0+'s `const` type-parameter modifier — without it the `events` catalog widens and `runtime.X.events.waitFor("NAME", { attributes })` loses typed-attribute checking. Don't "simplify" the helper signature.

## Verification gate

Before declaring a change done:

1. `just typecheck` — 0 errors.
2. `just test` — all green. If a test fails because of your change, fix the root cause rather than loosen the assertion.
3. `docker ps -aq --filter label=speculum=1 | wc -l` should print `0`. If containers leak, the `bun:test` preload teardown is broken — fix that before anything else.

## What requires an ADR

A change to: the Blueprint shape, the Binding shape, the Adapter SPI, the `Environment` reserved-name set, the event-bus model, the cross-process registry semantics, the mount-as-content contract.

Format: **Context** → **Decision** → **Consequences**, appended to `docs/decisions.md` with a TOC entry at the top.
