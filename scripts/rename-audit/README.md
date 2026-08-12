# Cyanotype rename audit

Progress + gate tooling for the **Speculum → Cyanotype** big-bang rename.

**Goal:** every scanned root has **0** residual case-insensitive substrings `speculum` (content + relative paths). Package target: `@expelledboy/cyanotype`. Brand: **Cyanotype**.

This directory is audit-only — it does not perform the rename.

## Setup

From the library repo root:

```sh
# either export sibling paths (config.json)
export PAYSWITCH_BRT_TESTS=/path/to/payswitch-brt-tests
# … see config.json / config.example.json

# or copy config.example.json → config.local.json with absolute paths
# (config.local.json is gitignored; preferred when present)
```

**Config resolution (one list of roots):** `config.local.json` → `config.json` → `config.example.json`. The local file is the workstation impact-zone inventory.

The audit tooling directory `scripts/rename-audit/**` and baseline dir `.rename-audit/**` are excluded so campaign metadata does not pollute residual counts.

**Residual 0 is necessary, not sufficient.** Every `pre`/`post` report reprints **OPS GATES** from [gates.ts](gates.ts) (npm Trusted Publisher bootstrap, JFrog mirror, live 3-Service label count, BRT pin, house-check fences, crimson worktree hygiene). `bun scripts/rename-audit/rename-audit.ts --checklist` prints them alone.

`--mode post` without `--roots` requires **required** roots (`library`, `brt`, `crimson-deploy`, both simulators). Local `crimson-deploy-*` trees are `role: hygiene` — not ship targets; missing is OK unless `--require-all-roots`.

## First baseline (campaign start)

```sh
# entire impact zone (one list, one report)
bun scripts/rename-audit/rename-audit.ts --write-baseline

# progress during the rename
bun scripts/rename-audit/rename-audit.ts --mode pre

# done when residual is 0 everywhere
bun scripts/rename-audit/rename-audit.ts --mode post
```

Baseline lands in `.rename-audit/baseline.json` (gitignored). Filter with `--roots library,brt` when iterating one slice.

## Modes

| Mode | Purpose | Missing roots | Residual |
|---|---|---|---|
| `pre` (default) | Progress during migration | skip + WARN (default) | allowed |
| `post` | Done gate | fail (default) | must be 0 |
| `baseline` | Snapshot `oldHits` | same as pre defaults | n/a |

Flags: `--skip-missing-roots` / `--require-all-roots`, `--fail-on-regression` / `--no-fail-on-regression`, `--json`, `--samples N`, `--list-patterns`, `--checklist`, `--include-dist`, `--roots id,id`.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success for mode |
| 1 | residual remain in `post` |
| 2 | bad args / config |
| 3 | missing required root |
| 4 | baseline missing when needed for regression fail |
| 5 | regression vs baseline |
| 6 | I/O error |

## Package script

```sh
bun run rename-audit -- --mode pre --roots library
```
