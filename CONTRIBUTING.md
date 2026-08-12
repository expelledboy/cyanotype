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

### Co-developing against a consumer repo via a `file:` pin

If a consumer pins Cyanotype locally — e.g. `"@expelledboy/cyanotype": "file:../../path/to/this-checkout"` — then `bunx @expelledboy/cyanotype derive ...` from the consumer side resolves against the **on-disk `dist/cli/index.js`** of this checkout. The CLI is only emitted by `bun run build` (`tsc -p tsconfig.build.json`). Two consequences:

- After changing anything under `src/cli/`, run `bun run build` in this repo before retrying `bunx` from the consumer side. Otherwise `bunx` invokes a stale (or, if `dist/` is absent, fails outright with "could not determine executable").
- After switching a consumer from a `file:` pin to a semver pin (e.g. `^0.3.1`), delete the consumer's `node_modules/@expelledboy/cyanotype` and re-run `bun install` — Bun does not always replace a directory-symlinked dep with a fresh tarball.

Switch to a semver pin once your library change has landed in a published release; that avoids the dist/build coupling entirely.

## Run the tests

```sh
# Type-check.
just typecheck

# Harness functionality tests — exercises adapters/orchestrator directly, not via the example; Docker/K8s tests self-skip when unavailable.
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

**Docker Compose attach mode is non-destructive and requires manual teardown.** When running `CYANOTYPE_ADAPTER=docker-attach`, Cyanotype never removes the Compose stack's containers — they must be stopped with `docker compose down` when you're done. `just clean-containers` will **not** catch Compose containers because they lack the `cyanotype=1` label that the cleanup filter targets.

If you wire your own integration suite for a Cyanotype-based project, you'll need the same pattern:

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

## Pre-release checklist

Before tagging any `v*.*.*` and triggering `release.yml`:

- `just typecheck && bun run build && just test-core` must all be green.
- **Exercise the bin entry end-to-end.** Library tests in
  `tests/core/cli-derive.test.ts` cover `deriveCompose` and `deriveK8s`
  as pure functions; they do not catch `src/cli/index.ts` argv-parsing
  or subcommand-routing bugs. The spawn suite in the same file (under
  `describe("cyanotype derive (CLI dispatch)", ...)`) does — and 0.3.0
  shipped with a broken dispatcher because no test ever ran the bin
  itself. The dispatch suite is the regression bar; do not relax it.
  Manual smoke before publish:
  ```sh
  bun run build
  bun dist/cli/index.js derive compose \
    --compose tests/support/compose/petstore-attach/compose.yaml \
    --out - --project petstore-attach \
    | jq '.bankingSim, .payswitch' >/dev/null
  bun dist/cli/index.js derive k8s \
    --k8s tests/support/k8s/petstore-attach/all.yaml \
    --out - | jq 'keys | length' >/dev/null
  ```
- The CHANGELOG `[Unreleased]` section is non-empty and reads coherently
  as a release-note. Move it to `[X.Y.Z] - YYYY-MM-DD` in the release
  commit; `release.yml` feeds it to the GitHub Release body.

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
  observer.ts           Framework lifecycle event stream (D-024)
  reporter.ts           createConsoleReporter — built-in stream consumer
  runtime.ts            Runtime<E> + ChaosControls<E>
  shared.ts             createSharedEnvs — atomic file claim
  compose.ts            reconcileComposeStack + FingerprintSpec (D-031)
  adapters/
    docker.ts           dockerode + SIGINT cleanup; onImageDrift policy (D-028)
    memory.ts           Factory-registry in-process adapter
    kubernetes.ts       K8s adapter (deploy + attach modes), reconnection layer
    kubectl.ts          kubectl subprocess wrapper (D-019)
  cli/
    index.ts            cyanotype derive CLI dispatch (bin entry) (D-030)
    derive.ts           deriveCompose / deriveK8s / loadDerivedCompose (D-030, D-032)
  index.ts              Public surface (.d.ts emitted by tsc at build)

tests/
  preload.ts            bun:test global setup + teardown (afterAll → shared.stopAll)
  core/                 Harness self-tests (in-memory adapter)
  fakes/                Reusable in-process simulators for Blueprints
  petstore-example/     End-to-end SLA suite (runs across all five adapters)
  support/containers/   Dockerfiles for the test images
  support/k8s/
    petstore-attach/    K8s manifests for the k8s-attach fixture topology
  support/compose/
    petstore-attach/    Docker Compose stack for the docker-attach fixture topology

docs/
  axioms.md             The seven forces — contract-derived constraints
  decisions.md          Append-only ADRs
  design.md             Architecture map, concept relationships, type flows
  attach-mode.md        Walkthrough for attach mode against K8s clusters and Docker Compose stacks
  k8s-rbac.md           RBAC requirements + cluster setup for the K8s adapter

bunfig.toml             Registers tests/preload.ts as the test preload
CONVENTIONS.md          Coding discipline (read before writing code)
CONTRIBUTING.md         You are here
AGENTS.md               Slim brief for AI coding agents (a subset of the above + hard rules)
README.md               Marketing / usage intro
```

## License

MIT — see [`LICENSE`](./LICENSE). Contributions are accepted under the same license.
