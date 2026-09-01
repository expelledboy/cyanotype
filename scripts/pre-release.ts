#!/usr/bin/env bun
/**
 * Gate: is this tree releasable?
 *
 * The pre-release checklist in AGENTS.md and CONTRIBUTING.md, executed instead
 * of read. Silent on stdout and exit 0 when everything holds; on a miss, every
 * failing check between two `[GATE]` lines and a non-zero exit. Progress goes
 * to stderr so a five-minute run is not a blank screen.
 *
 * It refuses rather than skips. If Docker or the cluster is unreachable, the
 * substrate suites have not run, and a release bar that quietly drops them is
 * not a bar. Nothing here is opt-out for that reason, which is why every suite
 * below runs with CYANOTYPE_REQUIRE_DOCKER and CYANOTYPE_REQUIRE_K8S set: those
 * turn an absent substrate into a failure rather than a skip.
 *
 * IT IS A STRICT SUPERSET OF CI, deliberately. Everything the pull-request
 * workflow runs, this runs too, plus the things only a release cares about —
 * git state, tag availability, the CHANGELOG section the release workflow will
 * extract, the built command-line interface, and the petstore example against
 * all five substrates. Two of those the workflow cannot cover at all: the
 * Kubernetes example paths, for the reason below.
 *
 * POINT CYANOTYPE_K8S_CONTEXT AT A SHARED-IMAGE-STORE CLUSTER (OrbStack,
 * Docker Desktop) BEFORE RUNNING THIS. The petstore example drives six
 * components at once, and the Kubernetes adapter opens one `kubectl
 * port-forward` per component with no recovery for one that dies after
 * establishing. On kind that produced 2 clean runs in 5, and identically on
 * k3d. The default context is a kind cluster, so running this gate unset will
 * fail intermittently for a reason that has nothing to do with the release.
 *
 * What it deliberately does NOT do: tag, push, or publish. It answers "may
 * this be released", not "release it".
 */

import { readFileSync } from "node:fs";

type Check = { readonly name: string; readonly run: () => string[] | null };

/**
 * Every check runs with the substrates DEMANDED. Without these the Kubernetes
 * suites skip when no cluster answers, and a release gate that skips is the
 * thing this file exists not to be.
 */
const REQUIRE_SUBSTRATES = { CYANOTYPE_REQUIRE_DOCKER: "1", CYANOTYPE_REQUIRE_K8S: "1" };

const sh = (cmd: string[], env?: Record<string, string>) =>
  Bun.spawnSync(cmd, {
    env: { ...process.env, ...REQUIRE_SUBSTRATES, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

/** Run a command purely for its exit code; on failure surface what it printed. */
const mustPass = (cmd: string[], hint: string): string[] | null => {
  const r = sh(cmd);
  if (r.exitCode === 0) return null;
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trimEnd();
  return [hint, "", out.split("\n").slice(-25).join("\n")];
};

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const version = pkg.version;
const tag = `v${version}`;

/**
 * Cheap checks describing the tree itself. They gate the expensive ones:
 * being on the wrong branch is not something five minutes of Kubernetes tests
 * can tell you anything about.
 */
const structural: Check[] = [
  {
    name: "working tree is clean",
    run: () => {
      const dirty = sh(["git", "status", "--porcelain"]).stdout.toString().trim();
      return dirty === "" ? null : ["Uncommitted changes:", "", dirty];
    },
  },
  {
    name: `on master (tags belong on master, not a branch)`,
    run: () => {
      const branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
      if (branch === "master") return null;
      return [
        `On '${branch}'. CI runs only on pull requests, so a tag here would`,
        "publish code no CI has validated, from a commit outside master's history.",
        "Open a PR, let CI pass, merge, then run this on master.",
      ];
    },
  },
  {
    name: "master is in sync with origin",
    run: () => {
      const fetched = sh(["git", "fetch", "--quiet", "origin", "master"]);
      if (fetched.exitCode !== 0) {
        return ["Could not fetch origin/master:", "", fetched.stderr.toString().trim()];
      }
      const counts = sh(["git", "rev-list", "--left-right", "--count", "HEAD...origin/master"])
        .stdout.toString().trim().split(/\s+/);
      const [ahead, behind] = [Number(counts[0] ?? 0), Number(counts[1] ?? 0)];
      if (ahead === 0 && behind === 0) return null;
      return [
        `Local master is ${ahead} ahead / ${behind} behind origin/master.`,
        "Release from a commit that is actually on the remote — the tag has to",
        "point at something other people can fetch.",
      ];
    },
  },
  {
    name: `tag ${tag} does not already exist`,
    run: () => {
      const local = sh(["git", "tag", "--list", tag]).stdout.toString().trim();
      if (local !== "") return [`Tag ${tag} already exists locally.`];
      const remote = sh(["git", "ls-remote", "--tags", "origin", tag]).stdout.toString().trim();
      if (remote !== "") return [`Tag ${tag} already exists on origin.`];
      return null;
    },
  },
  {
    name: `CHANGELOG has a dated section for ${version}`,
    run: () => {
      // The same extraction release.yml performs — but it runs it AFTER
      // `npm publish`, so a miss there means a published package and a failed
      // workflow, and npm never lets that version be republished.
      const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
      const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
      if (start < 0) {
        return [
          `No '## [${version}]' section in CHANGELOG.md.`,
          "release.yml extracts this AFTER publishing, so the package would be on",
          "npm before the workflow failed — and npm forbids republishing a version.",
        ];
      }
      if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}/.test(lines[start] ?? "")) {
        return [`'${lines[start]}' is missing a ' - YYYY-MM-DD' date.`];
      }
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => l.startsWith("## ["));
      const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
      return body === "" ? [`The ${version} section is empty; it becomes the release body.`] : null;
    },
  },
  {
    name: "bun.lock matches package.json",
    run: () => mustPass(
      ["bun", "install", "--frozen-lockfile"],
      "Both workflows install with --frozen-lockfile; a drifted lockfile fails them.",
    ),
  },
];

/** The suites. Minutes, not seconds — only reached once the tree looks sane. */
const verification: Check[] = [
  { name: "lint", run: () => mustPass(["bun", "run", "lint"], "`bun run lint` failed.") },
  { name: "typecheck", run: () => mustPass(["bun", "run", "typecheck"], "`bun run typecheck` failed.") },
  { name: "build", run: () => mustPass(["bun", "run", "build"], "`bun run build` failed.") },
  {
    name: "published CLI answers correctly",
    run: () => {
      // tests/core/cli-derive.test.ts covers deriveCompose/deriveK8s as pure
      // functions and cannot catch argv parsing or subcommand routing. 0.3.0
      // shipped a broken dispatcher for exactly that reason.
      const bin = "dist/cli/index.js";
      const derive = (args: string[]) => {
        const r = sh(["bun", bin, ...args]);
        if (r.exitCode !== 0) return { err: `\`${args.join(" ")}\` exited ${r.exitCode}` };
        try {
          return { json: JSON.parse(r.stdout.toString()) as Record<string, never> };
        } catch {
          return { err: `\`${args.join(" ")}\` did not emit JSON` };
        }
      };

      const compose = derive([
        "derive", "compose",
        "--compose", "tests/support/compose/petstore-attach/compose.yaml",
        "--out", "-", "--project", "petstore-attach",
      ]);
      if (compose.err) return [compose.err];
      const service = (compose.json as Record<string, { compose?: { attach?: { service?: string } } }>)
        ["redis.primary"]?.compose?.attach?.service;
      if (service !== "cache-leader") {
        return [`derive compose: redis.primary resolved to '${service}', expected 'cache-leader'`];
      }

      const k8s = derive([
        "derive", "k8s", "--k8s", "tests/support/k8s/petstore-attach/all.yaml", "--out", "-",
      ]);
      if (k8s.err) return [k8s.err];
      const keys = Object.keys(k8s.json as object);
      if (keys.length !== 6) return [`derive k8s: ${keys.length} components, expected 6 — ${keys.join(", ")}`];

      // A dispatcher bug shows up as accepting bad input, not as wrong output.
      const misuse = sh(["bun", bin, "derive", "bogus"]);
      if (misuse.exitCode !== 2) {
        return [`\`derive bogus\` exited ${misuse.exitCode}, expected 2 — misuse must be refused`];
      }
      return null;
    },
  },
  { name: "core tests", run: () => mustPass(["bun", "test", "tests/core/"], "tests/core/ failed.") },
  {
    name: "adapter suites",
    run: () => mustPass(["bun", "test", "tests/substrate/"], "tests/substrate/ failed."),
  },
  {
    name: "package contents",
    run: () => mustPass(["bun", "pm", "pack", "--dry-run"], "`bun pm pack --dry-run` failed."),
  },
  {
    name: "petstore example (memory, docker, docker-attach, k8s, k8s-attach)",
    run: () => {
      // CI runs the first three. The two Kubernetes paths run nowhere else —
      // see the note at the top about which cluster they need.
      for (const recipe of [
        "test-petstore-memory",
        "test-petstore-docker",
        "test-petstore-docker-attach",
        "test-petstore-k8s",
        "test-petstore-k8s-attach",
      ]) {
        process.stderr.write(`    ${recipe}\n`);
        const failed = mustPass(["just", recipe], `\`just ${recipe}\` failed.`);
        if (failed) return failed;
      }
      return null;
    },
  },
  {
    name: "no leaked containers",
    run: () => mustPass(["bun", "scripts/check-no-leaks.ts"], "Containers survived the suites."),
  },
];

const failures: string[] = [];

const runPhase = (phase: readonly Check[]): void => {
  for (const check of phase) {
    process.stderr.write(`  ${check.name}\n`);
    const detail = check.run();
    if (detail) failures.push(`— ${check.name}`, ...detail.map((l) => `  ${l}`), "");
  }
};

const refuse = (extra: readonly string[] = []): never => {
  console.error("[GATE] pre-release");
  for (const line of failures) console.error(line);
  for (const line of extra) console.error(line);
  console.error(`Not releasable as ${tag}.`);
  console.error("[GATE] pre-release");
  process.exit(1);
};

runPhase(structural);
if (failures.length > 0) {
  // Name what did not run. A gate that quietly drops half its checks reads as
  // a narrower failure than it actually is.
  refuse(["Stopped here — lint, typecheck, build, the CLI smoke and the substrate suites did not run."]);
}

runPhase(verification);
if (failures.length > 0) refuse();

process.stderr.write(`\nready to tag ${tag}\n`);
process.exit(0);
