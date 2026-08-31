#!/usr/bin/env bun
/**
 * Gate: no Cyanotype-owned Docker containers survive the suite.
 *
 * Silent and exit 0 when clean. On a miss, the whole story between two
 * `[GATE]` lines and a non-zero exit.
 *
 * Filters on `cyanotype.substrate=docker`, not `cyanotype=1`: where one
 * container runtime is shared with Kubernetes (OrbStack, Docker Desktop), Pods
 * carry the same `cyanotype` and `cyanotype.session` labels and would be
 * counted as Docker leaks.
 *
 * An unreachable daemon FAILS. A gate that cannot look is not a gate that
 * passes — the shell version of this check reported success when `docker ps`
 * errored, because the empty output read as "nothing leaked".
 */

const FILTER = "label=cyanotype.substrate=docker";

const docker = (args: string[]) =>
  Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });

const fail = (lines: string[]): never => {
  console.error("[GATE] check-no-leaks");
  for (const l of lines) console.error(l);
  console.error("[GATE] check-no-leaks");
  process.exit(1);
};

const ids = docker(["ps", "-aq", "--filter", FILTER]);
if (ids.exitCode !== 0) {
  fail([
    "Could not ask Docker what is running, so this gate cannot vouch for anything.",
    "",
    ids.stderr.toString().trim(),
    "",
    "Start the daemon and re-run. A leak check that cannot reach Docker must",
    "refuse rather than report success.",
  ]);
}

if (ids.stdout.toString().trim() === "") process.exit(0);

fail([
  docker(["ps", "-a", "--filter", FILTER]).stdout.toString().trimEnd(),
  "",
  "Teardown left these behind. tests/preload.ts owns suite teardown;",
  "`just clean-containers` clears them by hand.",
]);
