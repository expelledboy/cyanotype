# petstore-sla — worked example

A realistic three-tier topology used as Speculum's use-site validation **and** as the canonical demo of what the harness is for.

```
client → nginx (round-robin) → 3× petstore → redis primary
                                            ↘ redis replica (reads)
```

## Layout

| File | What it shows | Axiom |
|---|---|---|
| `env.ts` | Blueprint + Binding definitions + environment composition | A1, A2, B2, B3 |
| `harness.ts` | `createSharedEnvs` + adapter wiring | B1, C1 |
| `lifecycle.test.ts` | Test owns container lifecycle; typed multi-instance paths | B1, B3, C2 |
| `typed-api.test.ts` | Schema-driven typed clients; drift = compile error | A1 |
| `typed-events.test.ts` | `waitFor` on typed event attributes | A2 |
| `state-consistency.test.ts` | Replication seen via per-instance addressing | B3 |
| `resilience.test.ts` | Chaos: `chaos.stop` mid-test; SLA degrades gracefully | C2 |
| `sla.test.ts` | Quantitative availability + p95 latency targets | A1, B3, C2 |

Each suite header maps explicitly to entries in [`docs/axioms.md`](../../docs/axioms.md). If you delete a suite, you should be able to point to the axiom that suite was protecting.

## Running

The suites use the real Docker adapter by default. Build the container images once before running:

```sh
just build-test-images
```

Then `bun test tests/petstore-example/` (Mac/Windows Docker Desktop only — petstore reaches the host-bound redis via `host.docker.internal`).

## Substrates

All five `SPECULUM_ADAPTER` values are supported. Prerequisites per substrate:

| Adapter | Prerequisite |
|---|---|
| `docker` | Docker running; images built (`just build-test-images`). |
| `docker-attach` | Compose stack up and `derived-compose.json` generated — `just test-petstore-docker-attach` handles both. |
| `memory` | None — runs entirely in-process with no Docker images required. |
| `k8s` | OrbStack (or another cluster) — `just test-petstore-k8s` builds, loads images, and deploys automatically. |
| `k8s-attach` | Pre-deployed cluster with the fixture stack; `just test-petstore-k8s-attach` deploys, derives, and tears down automatically. |
