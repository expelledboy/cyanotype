# AGENTS.md

Cyanotype — Bun-native test harness built around the **Component Blueprint**: a typed contract (API schemas + event catalog) that multiple Bindings (real container, in-process simulator) satisfy. The Adapter is the substrate seam.

Read in this order if you have time: [`docs/axioms.md`](docs/axioms.md) → [`docs/design.md`](docs/design.md) → [`CONVENTIONS.md`](CONVENTIONS.md).

## Commands

```sh
bun install                    # one-time
just lint                      # biome; warnings fail
just typecheck                 # tsc --noEmit
just test-core                 # harness functionality tests; Docker/K8s tests self-skip if unavailable
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
| Compose-stack reconciliation (`reconcileComposeStack`, `FingerprintSpec`) (D-031, D-032) | `src/compose.ts` |
| `cyanotype derive` CLI dispatch (`cyanotype derive compose|k8s`) (D-030) | `src/cli/index.ts` |
| Derive library + `loadDerivedCompose` (`deriveCompose`, `deriveK8s`, `loadDerivedCompose`) (D-030, D-032) | `src/cli/derive.ts` |
| Docker adapter (deploy + Compose attach modes; `onImageDrift`) (D-028) | `src/adapters/docker.ts` |
| In-process simulator adapter | `src/adapters/memory.ts` |
| Multi-substrate adapter (`createCompositeAdapter`) (D-038) | `src/adapters/composite.ts` |
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
- **`any`:** only in variance-widener positions — places where a specific generic (say `Binding<PetstoreBlueprint>`) must be assignable to a container that holds bindings of *any* Blueprint, and TypeScript's variance rules reject the narrower type. Use the existing `biome-ignore lint/suspicious/noExplicitAny` line with a one-line reason.
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
  image: "cyanotype/petstore:latest", version: "latest",
  config: cfg, env: { PORT: "8080", ... },
  ports: { http: cfg.httpPort },
  logParser: petstoreJsonLogParser,
});
```

`defineBlueprint` uses TS 5.0+'s `const` type-parameter modifier — without it the `events` catalog widens and `runtime.X.events.waitFor("NAME", { attributes })` loses typed-attribute checking. Don't "simplify" the helper signature.

## Verification gate

Before declaring a change done:

1. `just lint` — 0 diagnostics. `just lint-fix` applies the safe ones.
2. `just typecheck` — 0 errors.
3. `just test` — all green. If a test fails because of your change, fix the root cause rather than loosen the assertion.
4. `just check-no-leaks` — silent, exit 0. If it names containers, the `bun:test` preload teardown is broken; fix that before anything else. It filters on `cyanotype.substrate=docker` rather than `cyanotype=1`, because on a runtime shared with Kubernetes (OrbStack, Docker Desktop) Pods carry the same `cyanotype` labels and would read as Docker leaks.

## Releasing

Two workflows, and what actually triggers them:

- `.github/workflows/ci.yml` runs on `pull_request` targeting `master` **and on nothing else** — there is deliberately no push trigger, because the pre-merge run already validates the merge result. It runs `bun install --frozen-lockfile`, `lint`, `typecheck`, `build`, `bun run test` (which is `tests/core/` only), and `bun pm pack --dry-run`.
- `.github/workflows/release.yml` runs on pushing a tag matching `v*.*.*`. It runs `bun run prepublishOnly`, publishes to npm through Trusted Publishers OIDC (no token; provenance is automatic), then extracts the matching CHANGELOG section and creates a GitHub Release from it.

**Therefore: a commit is only ever validated by CI as part of a pull request.** Never tag a branch. A tag on an unmerged branch publishes code CI has never run against, from a commit outside `master`'s history, and attests provenance to a ref nobody can find later.

The cycle:

1. Open a PR into `master`. CI runs here — this is the only automated validation the repository performs.
2. Land the release prep *in that PR*: move `CHANGELOG.md` `[Unreleased]` entries into a `## [X.Y.Z] - YYYY-MM-DD` block, re-point the `[Unreleased]` link definition at the new tag, and set `version` in `package.json`.
3. Merge to `master`.
4. Tag `master`, not the branch: `git checkout master && git pull && git tag vX.Y.Z && git push --tags`.

### Check these by hand before tagging — the automation does not

- **The CHANGELOG section must exist and match the tag exactly.** `release.yml` validates it *after* `npm publish`, so a mismatch means the package is already on the registry when the workflow fails. npm forbids republishing a version ever, and unpublish is time-limited. Dry-run the workflow's own extraction first:
  ```sh
  awk -v v=X.Y.Z '$0 ~ "^## \\[" v "\\]" {i=1;next} i && /^## \[/{exit} i' CHANGELOG.md
  ```
- **`package.json` version must equal the tag.** Nothing compares them. Tagging `v0.6.0` while `package.json` says `0.5.0` publishes `0.5.0`, which fails late with a registry conflict — or silently ships the wrong version if that number was never published.
- **Run the substrate suites.** Neither workflow runs `tests/petstore-example/` against Docker or Kubernetes; CI and release both stop at `tests/core/`. All five are a human responsibility before tagging:
  ```sh
  just test-petstore-memory         # no Docker, no cluster
  just test-petstore-docker         # Cyanotype owns the containers
  just test-petstore-docker-attach  # brings a Compose stack up, attaches, tears down
  just test-petstore-k8s            # Cyanotype deploys the workloads
  just test-petstore-k8s-attach     # deploys a fixture stack, attaches, deletes the namespace
  ```
- **Smoke the published CLI.** `bun run build` emits it to `dist/cli/index.js`, which is what `package.json`'s `bin.cyanotype` points at; run it as `bun dist/cli/index.js derive …`. `tests/core/cli-derive.test.ts` exercises `deriveCompose`/`deriveK8s` as pure functions and so cannot catch argv parsing or subcommand routing — 0.3.0 shipped a broken dispatcher for exactly that reason. The commands to run, with assertions that actually fail, are the pre-release checklist in `CONTRIBUTING.md`; work through the rest of that checklist too.
- **`bun.lock` must be current.** Both workflows install with `--frozen-lockfile`; a drifted lockfile fails them before anything useful runs.

## What requires an ADR

A change to: the Blueprint shape, the Binding shape, the Adapter SPI, the `Environment` reserved-name set, the event-bus model, the cross-process registry semantics, the mount-as-content contract.

Format: **Context** → **Decision** → **Consequences**, appended to `docs/decisions.md` with a TOC entry at the top.
