# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/expelledboy/speculum/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/expelledboy/speculum/releases/tag/v0.1.0
