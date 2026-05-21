# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/expelledboy/speculum/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/expelledboy/speculum/releases/tag/v0.2.0
[0.1.0]: https://github.com/expelledboy/speculum/releases/tag/v0.1.0
