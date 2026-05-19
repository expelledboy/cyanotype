# Contributing

> Workflow and process. Read [`CONVENTIONS.md`](./CONVENTIONS.md) first for the code-style rules and [`docs/axioms.md`](./docs/axioms.md) for the design constraints.

## Dev setup

You need:

- **[Bun](https://bun.sh)** `~1.3` or newer — the test runner and dev runtime.
- **Docker** running locally — for the integration tests against real images.
- **[just](https://github.com/casey/just)** — task runner. `brew install just`, or `nix develop` (the flake provides it).

Then:

```sh
bun install
```

## Run the tests

```sh
# Type-check.
just typecheck

# Harness self-tests (no Docker images needed; in-memory adapter only).
just test-core

# Full suite. Teardown runs automatically; back-to-back `bun test` invocations
# don't leak containers.
just test

# Build the test-image dependencies (one time).
just build-test-images

# Manual reset — for unusual situations (kill -9, partial state).
# Not needed on the normal path; the preload handles cleanup.
just clean-containers
```

### How teardown works

`bun test` runs all files in a single process. `bunfig.toml` registers `tests/preload.ts` as a preload script; that file's top-level `afterAll` (from `bun:test`) fires once after the entire run and calls `shared.stopAll()`. The harness stops cached runtimes, then reconnects briefly to force-clean any session-labelled stragglers, then disconnects. No orphan containers remain between runs.

If you wire your own integration suite for a Speculum-based project, you'll need the same pattern:

```ts
// tests/preload.ts
import { afterAll } from "bun:test";
import { shared } from "./your-harness";

afterAll(async () => {
  try { await shared.stopAll(); }
  catch (e) { console.error("[preload] stopAll failed:", e); }
});
```

```toml
# bunfig.toml
[test]
preload = ["./tests/preload.ts"]
```

## Making changes

### Code changes

- Follow `CONVENTIONS.md`.
- Every implementation module has a test file in `tests/core/<module>.test.ts`. Add tests for new behaviour there.
- The end-to-end example in `tests/petstore-example/` is the integration smoke; if your change affects orchestration or the Adapter SPI, it should still pass.
- `just typecheck` must be clean.
- `just test-core` must be clean. Then `just test` against real Docker.

### Architectural changes

Anything that touches a load-bearing concept (Blueprint shape, Adapter SPI, Environment composition, cross-process registry, event-bus typing) needs an ADR in `docs/decisions.md`.

The ADR process:

1. Open a draft PR with the change.
2. Add an entry to `docs/decisions.md` at the end. Format:
   ```
   ## D-NNN. Title

   **Context:** Why this came up.
   **Decision:** What we're doing.
   **Consequences:** What this enables, breaks, or forecloses.
   ```
3. The decisions file is **append-only**. Never edit an existing ADR. If a decision is wrong, add a new ADR that explicitly retires the old one — don't rewrite history.

### What to do when stuck

- **Spec ambiguous?** Stop and ask. Don't pick between two reasonable interpretations silently — that's how the project drifts.
- **Test would need a non-trivial fake?** Stop and ask. It's a design smell — the abstraction may need to move.
- **A module heading past 200 LoC?** Stop and ask. Either the module is eating a neighbour's job or the design is wrong.

## PR shape

- One concern per PR. If you're adding a feature and refactoring, split them.
- The PR description states the *why*: what problem this solves, what the alternatives were, what's now possible (or impossible). The diff explains the *what*.
- Tests in the same PR as the change.
- If you added an ADR, link to it from the PR description.

## Project layout

```
src/                    Library source
  blueprint.ts          Blueprint<C, E, I, A> + defineBlueprint
  binding.ts            Binding<B> + bind + type extractors
  environment.ts        Environment + createEnvironment (reserved-name validation)
  protocol.ts           Protocol union + HttpRouteMap + createHttpClient
  interface.ts          Interface<P> + iface() + ApiFromInterface
  helpers.ts            HelperContext + http helper
  events.ts             Typed EventCatalog + per-component EventBus
  probe.ts              Probe<I> + runProbe
  adapter.ts            Adapter SPI (7 methods) + StartSpec
  metadata.ts           Cross-process JSON snapshot schema
  orchestrator.ts       startEnvironment / attachEnvironment + chaos
  runtime.ts            Runtime<E> + ChaosControls<E>
  shared.ts             createSharedEnvs — atomic file claim
  adapters/
    docker.ts           dockerode + SIGINT cleanup
    memory.ts           Factory-registry in-process adapter
    kubernetes.ts       K8s adapter (deploy + attach modes), reconnection layer
    kubectl.ts          kubectl subprocess wrapper (D-019)
  index.ts, index.d.ts  Public surface

tests/
  preload.ts            bun:test global setup + teardown (afterAll → shared.stopAll)
  core/                 Harness self-tests (in-memory adapter)
  fakes/                Reusable in-process simulators for Blueprints
  petstore-example/     End-to-end SLA suite (runs across all four adapters)
  support/containers/   Dockerfiles for the test images

docs/
  axioms.md             The seven forces — contract-derived constraints
  decisions.md          Append-only ADRs
  design.md             Architecture map, concept relationships, type flows
  attach-mode.md        Walkthrough for k8s-attach against a pre-deployed cluster
  k8s-rbac.md           RBAC requirements + cluster setup for the K8s adapter

bunfig.toml             Registers tests/preload.ts as the test preload
CONVENTIONS.md          Coding discipline (read before writing code)
CONTRIBUTING.md         You are here
AGENTS.md               Slim brief for AI coding agents (a subset of the above + hard rules)
README.md               Marketing / usage intro
```

## License

MIT — see [`LICENSE`](./LICENSE). Contributions are accepted under the same license.
