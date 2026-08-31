# AGENTS.md

Cyanotype — Bun-native test harness built around the **Component Blueprint**: a typed contract (API schemas + event catalog) that multiple Bindings (real container, in-process simulator) satisfy. The Adapter is the substrate seam.

Read in this order if you have time: [`docs/axioms.md`](docs/axioms.md) → [`docs/design.md`](docs/design.md) → [`CONVENTIONS.md`](CONVENTIONS.md).

## Commands

```sh
bun install                    # one-time
just lint                      # biome; warnings fail
just typecheck                 # tsc --noEmit
just test-unit                 # pure suite; no Docker, no cluster — the inner loop
just test-substrate            # adapter integration against real Docker + Kubernetes
just test-core                 # both of the above
just build-test-images         # one-time: builds petstore + redis-configurable
just test                      # full suite against real Docker
just clean-containers          # manual reset; not needed on the normal path
just pre-release               # the release bar; checks everything, tags nothing
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
| Runtime invariants — cross-module agreements (D-042) | `src/invariants.ts` |
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
| Harness unit tests — pure, no substrate | `tests/core/` |
| Adapter integration against real Docker / Kubernetes | `tests/substrate/` |
| Test setup/teardown hooks | `tests/preload.ts` (registered in `bunfig.toml`) |
| Release + leak gates, attach-suite chain | `scripts/` (one-line `just` recipes call these) |
| K8s + Docker Compose attach walkthrough | `docs/attach-mode.md` |
| K8s RBAC + cluster setup | `docs/k8s-rbac.md` |

## Hard rules

- **Comments:** default to none. Add one only when the *why* is non-obvious — a hidden constraint, a workaround for a specific bug, behaviour that would surprise a reader. Instead of `// stop the container`, name the variable so the line reads itself.
- **Assertions:** validate at boundaries; trust types internally. Instead of `assert(name != null)` in the orchestrator, use the boundary check `createEnvironment` already performs. The one exception is `invariant()` from `src/invariants.ts`, for an agreement between two modules that no signature can state and whose violation surfaces somewhere else entirely — off unless this repo's own suite is running, or `CYANOTYPE_INVARIANTS=1`. Never `assert`. See D-042 and `CONVENTIONS.md`.
- **`any`:** only in variance-widener positions — places where a specific generic (say `Binding<PetstoreBlueprint>`) must be assignable to a container that holds bindings of *any* Blueprint, and TypeScript's variance rules reject the narrower type. Use the existing `biome-ignore lint/suspicious/noExplicitAny` line with a one-line reason.
- **Errors:** tagged objects, not classes. `throw { kind: "probe_timeout", lastError, elapsedMs }` — never `throw new Error(...)` except for "this should be impossible" cases.
- **Tests:** `expect(...)` only. No `sleep(N)`-style waits — use `waitFor(predicate, opts)` from `tests/petstore-example/test-helpers.ts`.
- **ADRs:** append-only. Never edit an existing entry in `docs/decisions.md`. If a decision is wrong, write a new ADR that retires it. Note that ADRs written before the adapter tests moved out of `tests/core/` cite `tests/core/<name>.test.ts` paths for files that now live in `tests/substrate/` — the paths are historical, the decisions stand.

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
3. `just test-unit` — all green, and fast enough to run constantly. `just test` for the full sweep before you are done. If a test fails because of your change, fix the root cause rather than loosen the assertion.
4. `just check-no-leaks` — silent, exit 0. If it names containers, the `bun:test` preload teardown is broken; fix that before anything else. It filters on `cyanotype.substrate=docker` rather than `cyanotype=1`, because on a runtime shared with Kubernetes (OrbStack, Docker Desktop) Pods carry the same `cyanotype` labels and would read as Docker leaks. An unreachable daemon fails it — a check that cannot look must not report success.

## Chaos tests and the shared registry

The cross-process registry (`createSharedEnvs`) is what lets parallel test
workers share one environment: the first process starts the containers, every
other one attaches. For read-only suites that is correct and fast.

**Chaos suites are not safe to run concurrently against a shared environment.**
`getTargetEnv` guards against attaching to the *wrong* environment; nothing
guards against two processes attaching to the *right* one and both mutating it.
Two runs of a chaos suite will stop and restart the same component underneath
each other, and the failures look like flakiness in the system under test rather
than interference between runs.

If you are measuring or debugging a chaos suite, run one at a time, and do not
delete the namespace or `.cyanotype-env` immediately before a run — a suite that
starts into that churn produces failures that are yours, not the code's.

**Clear `.cyanotype-env` when switching substrates.** Environment metadata is
keyed by env key alone (`<stateDir>/<envKey>.json`) and records nothing about
which substrate wrote it, so a Kubernetes run inherits the file a Compose-attach
run left behind. Nothing breaks outright — `adapter.exists()` is asked about a
container id from the other substrate, says no, and the environment is started
fresh — but the invalidate-and-restart is slow and has been observed to produce
spurious failures when suites run back to back. `rm -rf .cyanotype-env` between
`CYANOTYPE_ADAPTER` changes.

## Failures: invariant, or error?

Every failure Cyanotype raises is one of two things, and picking wrong is the
common mistake. **Ask who broke it.**

| | `invariant()` | thrown error |
|---|---|---|
| Who broke it | Cyanotype, or an Adapter implementing our SPI | the consumer, in their own code or config |
| Who can fix it | us | them |
| When it runs | only when enabled (our suite, or `CYANOTYPE_INVARIANTS=1`) | always |
| Carries a `hint` | no | yes, if consumer-facing |

**Reach for `invariant()`** when the rule is an agreement between two of *our*
modules that no signature can state, and breaking it surfaces somewhere else
entirely — the session label one module stamps versus the one another sweeps; a
Service selector being a subset of the Pod labels it selects; a container we do
not own never reaching `adapter.stop`. Write it
`invariant(() => held, "the rule as a property", () => detail)`. **Both
arguments are thunks** so that nothing runs when invariants are off; a plain
boolean is evaluated at the call site regardless, which once made a *disabled*
check crash a consumer with `undefined is not an object`.

**Reach for a thrown error** when a consumer's own code caused it — a Binding
that omits a declared `portName`, `use()` before `ensure()`, an Environment
edited under a persisted one. It must fail for everyone, at the boundary where
it is still explicable, and it owes them a `hint`.

**Reach for neither** when a type, a boundary validator or a chokepoint already
covers it. Duplicating those is the noise D-012 bans.

### Writing a `hint`

State what was done, why it is wrong, and the fix. The tagged fields address
programs; the `hint` addresses the person reading the failure.

- **Never reference this repository's tooling.** A consumer has no `just`
  recipes of ours. Say "delete the `<envKey>.json` under your stateDir and stop
  containers labelled `cyanotype=1`", not "run `just clean-containers`".
- **Be accurate about scope and recovery.** Check the claim before writing it.
  `use()` is scoped to the `createSharedEnvs` handle, not the file. `stopAll()`
  will not clean containers a *previous* process started, so never suggest it
  for that.
- **Name the fix, not just the fact.** "Add `admin: \"auto\"` to that Binding's
  ports" beats "the port is missing".
- **Internal errors stay bare.** A hint nobody can act on is noise — and if you
  cannot write one, the error is probably internal and may want to be an
  `invariant()` instead.

**A hint may only state what a test proves or the claim lint resolves. Anything
else says what to CHECK, not what to do.** A hint that lies is worse than no
hint — the reader acts on it, and the fix they try cannot work. Three shipped
before this rule existed: advice to run a `just` recipe consumers do not have,
a scope claim that was simply wrong, and a remedy (`stopAll()`) that exists but
cannot do the thing it was offered for.

Three layers keep hints honest, and they cover different failures:

| layer | catches | run it |
|---|---|---|
| `tests/core/hint-claims.test.ts` | a hint naming something that does not exist — a renamed method, a dead config path, a moved doc, an unvetted shell command | automatic |
| `tests/core/hint-remedies.test.ts` | advice that does not work: it triggers the error, performs the remedy, asserts it resolves | automatic |
| `just hints` | everything else — whether the prose is *sound*. Prints every error, its trigger and its hint, so the set can be read in one pass | by a human or agent |

The first two are the reason a hint may reference an API or a config path at
all. If your advice cannot be proven by either, phrase it as something to
check ("kubectl describe pod shows which") rather than a remedy to follow, and
it stays honest without a test.

`tests/core/error-classification.test.ts` enforces the rest: every
`throw { kind: ... }` in `src/` must be listed as consumer-facing or internal,
consumer-facing ones must carry a `hint`, internal ones must not, and no hint
may mention our own tooling. Adding an error without classifying it fails the
suite — deliberately, so the decision happens while the author still knows who
can trigger it. See D-042 and D-043.

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

### `just pre-release` is the bar

One command, and it refuses rather than skips. It checks the tree (clean, on
`master`, in sync with origin, tag unused, CHANGELOG dated and non-empty for
`package.json`'s version, lockfile frozen), then runs lint, typecheck, build, a
smoke of the built CLI, the core tests, all five substrate suites, and the leak
gate. Structural failures stop it before the slow half and say so. It never
tags, pushes or publishes.

Three reasons it exists, none of which the workflows cover:

- **The CHANGELOG is validated after `npm publish`.** `release.yml` extracts the
  section for the tag *after* the package is on the registry, so a missing or
  undated section means a published version and a failed workflow — and npm
  forbids republishing a version.
- **Nothing compares `package.json` to the tag.** `GITHUB_REF_NAME` appears once
  in `release.yml`, in the notes step.
- **Neither workflow runs the substrate suites.** `bun run test` is `tests/core/`
  only, so Docker and Kubernetes are otherwise never exercised before a publish.

## What requires an ADR

A change to: the Blueprint shape, the Binding shape, the Adapter SPI, the `Environment` reserved-name set, the event-bus model, the cross-process registry semantics, the mount-as-content contract.

Format: **Context** → **Decision** → **Consequences**, appended to `docs/decisions.md` with a TOC entry at the top.
