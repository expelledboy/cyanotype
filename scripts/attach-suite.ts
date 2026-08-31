#!/usr/bin/env bun
/**
 * Run the petstore example against a pre-deployed stack, then tear that stack
 * down whether the suite passed or not.
 *
 * The teardown-on-failure is the whole reason this is a script rather than two
 * recipe lines: attach mode is non-destructive by design, so nothing else will
 * remove a Compose project or a Kubernetes namespace, and a failed run would
 * otherwise leave one behind for the next run to trip over.
 *
 * Bringing the stack up and deriving its topology stay as `just` dependencies —
 * they are single commands and belong in the manifest.
 */

const SUBSTRATES = {
  docker: {
    env: { CYANOTYPE_ADAPTER: "docker-attach" },
    teardown: "teardown-petstore-docker-attach",
  },
  k8s: {
    env: {
      CYANOTYPE_ADAPTER: "k8s-attach",
      CYANOTYPE_K8S_CONTEXT: process.env.CYANOTYPE_K8S_CONTEXT ?? "orbstack",
    },
    teardown: "teardown-petstore-k8s-attach",
  },
} as const;

const which = process.argv[2] as keyof typeof SUBSTRATES | undefined;
const chosen = which ? SUBSTRATES[which] : undefined;
if (!chosen) {
  console.error(`usage: bun scripts/attach-suite.ts <${Object.keys(SUBSTRATES).join("|")}>`);
  process.exit(2);
}

const suite = Bun.spawnSync(["bun", "test", "tests/petstore-example"], {
  env: { ...process.env, ...chosen.env },
  stdout: "inherit",
  stderr: "inherit",
});

const teardown = Bun.spawnSync(["just", chosen.teardown], {
  stdout: "inherit",
  stderr: "inherit",
});

// The suite's verdict is what the caller asked for; a teardown failure is
// reported but must not disguise a green suite as a red one.
if (teardown.exitCode !== 0) {
  console.error(`[attach-suite] teardown '${chosen.teardown}' exited ${teardown.exitCode}`);
}
process.exit(suite.exitCode ?? 1);
