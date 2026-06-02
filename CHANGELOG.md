# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-06-02

Multi-port attach DX fix. Surfaced by a consumer (BRT) migrating to a
six-leg compose stack with two multi-port simulator services; their
hand-rolled `MULTI_PORT_ATTACH_KEYS` workaround stripped `attach.port`
from derive output so the binding's `spec.ports` could drive
resolution. The library now does this automatically.

### Fixed
- `deriveCompose` and `deriveK8s` emit `attach.port` only when the
  underlying compose service or k8s workload publishes exactly one
  container port. Multi-port services / workloads omit the field —
  the binding's `spec.ports` then drives full multi-port resolution
  via the adapter's existing fallback path
  (`override?.port !== undefined ? [...] : Object.keys(spec.ports)`).
  Previously derive auto-emitted the first declared port for every
  service, which silently disabled resolution for ports 2..N of any
  multi-port binding. (D-035)

### Docs
- `docs/attach-mode.md` per-field semantics table for
  `compose.attach.*` reframes `port`'s polarity — set means "narrow
  single-port override that ignores `spec.ports`"; absent means
  "resolve every `spec.ports` key, the correct default for multi-port
  services". Adds a "Multi-port attach services" subsection working
  through the override-by-extension pattern at the bind site.
- The same schema block now lists `onImageDrift` (added in D-028,
  D-032) alongside `allowChaos` — the previous omission was a
  documentation oversight, not a missing feature.

## [0.4.0] - 2026-05-29

Container ownership becomes a first-class SPI property; derive emits
topology only. Closes a defect where end-of-session `stopAll` could
`docker stop` an operator's attached compose stack. Surfaced by the
first consumer (BRT) adopting 0.3.1 in production.

### Changed (BREAKING)
- **`Started` SPI return now requires `owned: boolean`.** External adapter
  implementers must set it; Speculum uses it to distinguish containers it
  created from containers it merely attached to. (D-034)
- **`speculum derive compose|k8s` no longer emits `allowChaos` in derived
  output.** Derived adapter config carries topology only (project / service /
  port / namespace / deployment). Policy fields — `allowChaos`, `onImageDrift`
  — belong at the bind site, where the test author explicitly opts in per
  binding. Consumers that rely on chaos in attach mode must spread
  `allowChaos: true` into the adapter config at `bind()` time. (D-033)
- **Docker adapter `stop()` in attach mode now throws
  `chaos_unsupported_in_attach_mode` when `allowChaos` is unset**, mirroring
  the existing K8s adapter behaviour. The previous silent no-op masked
  misconfigured bindings. (D-034)

### Fixed
- `runtime.stop()` and `shared.stopAll()` no longer call `adapter.stop()` for
  containers Speculum did not create (`owned: false`). Closes a defect where
  attach-mode + `allowChaos: true` caused end-of-session `stopAll` to
  `docker stop` the operator's running stack. (D-034)
- Version-drift invalidation (`stopAllInMeta`) skips non-owned containers.
  Pure-attach mode continues to throw `attach_version_stale` as before. (D-034)

### Added
- `ComponentSnapshot` gains optional `owned?: boolean`; absent is treated as
  `true` for backward compatibility with pre-0.4.0 metadata files. (D-034)

### Docs
- `CONTRIBUTING.md` gains a Pre-release checklist that names the CLI
  spawn suite as the regression bar for `bin` dispatcher bugs, with a
  manual smoke-test snippet that exercises both `derive compose` and
  `derive k8s` from the built `dist/`. Documents the surprise from
  0.3.0 — library tests passed; the bin entry was broken.
- `CONTRIBUTING.md` gains a "Co-developing against a consumer repo via
  a `file:` pin" note: contributors must `bun run build` after any
  `src/cli/` change for the consumer's `bunx @expelledboy/speculum …`
  to see it, and a consumer switching from a `file:` to a semver pin
  should `rm -rf node_modules/@expelledboy/speculum && bun install`.
- `docs/attach-mode.md` troubleshooting table gains rows for
  `attach_dead_container` and `container_gone`, plus an "Upgrading
  from a pre-0.3.0 attach session" subsection that explains why
  bumping `Binding.version` does not dislodge a legacy snapshot
  (absent stored version → check is deliberately skipped, see D-027)
  and prescribes the one-time `rm .speculum-env/<envKey>.json` fix.

## [0.3.1] - 2026-05-28

Bugfix for the 0.3.0 `speculum derive` CLI and package-root re-exports.
Reported by the first consumer to adopt 0.3.0 against a real
`docker compose` stack; no library-API changes.

### Fixed
- `src/cli/index.ts` dispatched on the wrong argv token: after
  `const [cmd, sub, mode] = argv`, the third token of
  `derive compose --compose <path>` is `--compose`, not `compose`, so
  `if (mode === "compose")` was never true and every invocation fell
  through to "error: --k8s is required". Now branches on `sub`; the
  unused `mode` token is removed. A new test suite spawns the bin entry
  end-to-end (`tests/core/cli-derive.test.ts`) so future argv-parsing
  breakage at the dispatch level cannot ship green.
- `deriveCompose` and `deriveK8s` are now exported from
  `@expelledboy/speculum`. In 0.3.0 they were only reachable through
  the deep path `@expelledboy/speculum/dist/cli/derive.js` — not in the
  package's `exports` map and a typecheck hazard. The package-root
  import path documented in the 0.3.0 ADR is now actually what works.

### Changed
- All documentation that invoked the CLI as `bunx speculum …` now reads
  `bunx @expelledboy/speculum …`. The package is scoped, so the short
  form fails to resolve. Affects `docs/attach-mode.md`, the D-030 ADR
  consequences in `docs/decisions.md`.

## [0.3.0] - 2026-05-28

Consumer-driven feature batch — six additions that absorb glue Docker-attach
consumers were hand-rolling.

### Added
- `Binding.version` is now a cache key for the persisted environment. On
  re-ensure, a changed `Binding.version` stops the live containers via a
  new internal `stopAllInMeta` walk of the snapshot, deletes the metadata
  file, and re-races the start path — mirroring the dead-container
  invalidation. Pure-attach mode (no rebuild path) throws
  `{ kind: "attach_version_stale", envKey }` instead. The new
  `ComponentSnapshot.version` field is optional; absent stored versions
  skip the check, so metadata written by an older Speculum never
  false-invalidates (ADR D-027).
- Attach-mode image-drift detection. The Docker adapter compares the
  discovered container's image against the `Binding`'s expectation during
  `startAttach`, governed by `onImageDrift?: "warn" | "fail" | "ignore"`
  on `DockerAdapterOptions` and per-Binding via
  `AdapterConfig.compose.attach.onImageDrift` (default `"warn"`).
  `"fail"` throws `AttachImageDriftError`
  (`{ kind: "attach_image_drift", expected, actual, component }`). The
  comparison tolerates an exact match or an `@sha256:` digest suffix only
  — no looser prefix relationship (ADR D-028, D-032).
- `stack.*` observer phase covering compose-stack reconciliation:
  `stack.checking`, `stack.fresh`, `stack.stale` (carries `changedFields`),
  `stack.rebuilding`, `stack.rebuilt` (carries `durationMs`),
  `stack.attached` (carries `serviceCount`), `stack.failed` (carries
  `error`). The built-in console reporter renders the new events under a
  `"stack"` label column, parallel to `"substrate"` (ADR D-029).
- `speculum derive` CLI — first `bin` entry in the package. Subcommands
  `speculum derive compose --compose <f> --out <f|-> [--project <name>]`
  and `speculum derive k8s --k8s <d|f> --out <f|->`. Output is the
  binding-keyed JSON consumed at attach time. The pure library
  counterparts `deriveCompose(path, project?)` and `deriveK8s(path)` are
  also exported for in-process use. The petstore reference script is now
  a thin wrapper over the library (ADR D-030).
- `reconcileComposeStack(options) => Promise<ReconcileComposeResult>` —
  library-owned compose-stack staleness reconciliation. Options
  `{ project, composeFile, fingerprint, onStale?, observer?, stateDir?,
  force? }`. `fingerprint` is a `FingerprintSpec` — either a static
  `Array<{ name, file } | { name, value }>` or an async
  `() => Record<string, string>` for derived values. Returns
  `{ rebuilt, changedFields, durationMs }`. Emits the `stack.*` phase
  when an observer is supplied. `force: true` skips the fingerprint
  compare and goes straight to the rebuild path, emitting a `stack.stale`
  event with the synthetic marker `["<forced>"]` (ADR D-031, D-032).
- `loadDerivedCompose(path, expectedKeys)` — synchronous helper that
  reads the JSON emitted by `speculum derive compose`, validates each
  entry against `ComposeAdapterConfigSchema`, asserts every key in
  `expectedKeys` is present, and returns `Record<string, AdapterConfig>`.
  Three discriminated errors: `derived_compose_missing`,
  `derived_compose_invalid`, `derived_compose_missing_keys`.
  Synchronous on purpose — consumers invoke it from ensure-time setup,
  not module top level, so a missing derived file does not throw at
  import time (ADR D-032).
- New exports from `src/index.ts`: `reconcileComposeStack`,
  `loadDerivedCompose`, `deriveCompose`, `deriveK8s`,
  `computeFingerprint`, `changedFingerprintFields`,
  `readStoredFingerprint`, `writeStoredFingerprint`. New type exports:
  `ReconcileComposeOptions`, `ReconcileComposeResult`, `FingerprintSpec`,
  `FingerprintInput`, `Fingerprint`, `ImageDriftPolicy`,
  `AttachImageDriftError`, `DerivedComposeMissingError`,
  `DerivedComposeInvalidError`, `DerivedComposeMissingKeysError`.

## [0.2.1] - 2026-05-22

Maintenance release — no changes to the published library code; CI/release
pipeline hardening and a contributor-docs fix.

### Changed
- CI and release workflows hardened: Bun package caching, a pinned Bun
  version, Node-24 action versions, a single verification pass per release
  (publish was re-running typecheck + build + tests a redundant second
  time), a concurrency guard on publish, and CHANGELOG-driven GitHub
  Release notes. CI no longer runs on push to `master` — the pre-merge
  pull-request run already covers it.
- `test-core` is now correctly documented as exercising the harness
  functionality directly (adapters, orchestrator); it was wrongly
  described as "in-memory adapter only".

## [0.2.0] - 2026-05-21

Docker Compose attach adapter, framework lifecycle observer stream, and built-in console reporter.

### Added
- Docker Compose attach adapter mode (`createDockerAdapter({ mode: "attach", project })`):
  containers discovered via `com.docker.compose.project`/`.service` labels; compose service
  maps to a Speculum component by convention (`speculum.component` label), overridable
  per-Binding via the `compose.attach` config slot (`{ project, service, containerNumber,
  port, allowChaos }`). A guard blocks `createContainer`/`pull`/`remove`; `stop`/`start`
  are also blocked unless `allowChaos: true`, which enables real `docker stop`/`start`
  chaos. Services under test must publish ports to the host. The same 15-test petstore SLA
  suite runs unchanged against this fifth substrate via `SPECULUM_ADAPTER=docker-attach`
  (ADR D-025, D-026).
- Framework lifecycle observer stream (ADR D-024): opt-in `observer` on
  `OrchestratorOptions` receives typed `substrate.*` / `image.*` / `container.*`
  / `probe.*` / `environment.*` / `chaos.*` telemetry — including throttled
  Docker image-pull progress and per-attempt readiness polling. Zero cost when
  unset, and a throwing reporter is isolated — it never aborts provisioning.
  Reachable via `OrchestratorOptions.observer` and forwarded from
  `SharedOptions.observer` through `createSharedEnvs`.
- `createConsoleReporter()` — a built-in reporter that renders the observer
  stream as `speculum`-prefixed stderr lines (state glyph + component column),
  with a live per-layer image-pull progress bar on a TTY. Renders the probe
  phase so a slow custom readiness check is not silent; shortens registry
  image refs. `environment.component_ready` is emitted with component scope so
  a reporter can attribute the `ready` line to its component.
- New exports: `createConsoleReporter`, `ConsoleReporterOptions`, `Observer`,
  `ObserverEvent`, `ObserverEventData`, `ObserverEnvelope`.

### Changed
- `justfile` reorganized; contributor recipes renamed: `test-k8s` →
  `test-adapter-k8s`, `test-k8s-attach` → `test-adapter-k8s-attach`.

## [0.1.0] - 2026-05-19

Initial public release. Developer preview — pre-1.0, expect minor-version breaking changes.

### Added
- Component Blueprint typed contract (API schemas + Zod event catalog)
- Binding system with adapter-pluggable substrate
- Four adapter modes: in-memory, Docker, Kubernetes deploy, Kubernetes attach
- Per-Binding adapter config via TypeScript declaration merging (ADR D-022)
- Real-chaos opt-in for K8s attach mode (ADR D-023): `allowChaos + deployment` lifts only the `scale` verb
- `startEnvironment` / `attachEnvironment` orchestrator entries
- `Runtime<E>` + typed `ChaosControls<E>` (compile-time instance args)
- Shared environment claim via `createSharedEnvs` (atomic O_CREAT|O_EXCL)
- Built-in fake helpers for petstore example (redis presence stub, nginx fail_timeout)
- 15-test petstore SLA suite passes unchanged across all four substrates

### Known limitations
- Bun runtime required (`engines.bun >=1.1.0`); test runner is `bun:test`
- Multi-port attach not yet supported (single scalar `attach.port`)
- Only HTTP and Opaque protocols implemented; TCP/gRPC/SOAP deferred
- OrbStack K8s degrades under prolonged port-forward + rollout-restart load (kind/remote recommended for sustained CI)

[Unreleased]: https://github.com/expelledboy/speculum/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/expelledboy/speculum/releases/tag/v0.2.1
[0.2.0]: https://github.com/expelledboy/speculum/releases/tag/v0.2.0
[0.1.0]: https://github.com/expelledboy/speculum/releases/tag/v0.1.0
