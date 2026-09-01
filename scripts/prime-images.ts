#!/usr/bin/env bun
/**
 * Gate: every upstream image this run needs is present locally, under the name
 * the fixtures already use.
 *
 * Pulls each image from the mirror in `tests/support/images.json` and retags it
 * to its original name. Nothing downstream knows the mirror exists — the
 * Dockerfiles, Kubernetes manifests and Compose files keep the references they
 * already had, so CI and a laptop run identical strings.
 *
 * WHY NOT JUST PULL FROM DOCKER HUB. Anonymous pulls are capped at 100 per six
 * hours per IPv4 address, and GitHub's hosted runners share addresses with
 * every other tenant. Our own six pulls per run are irrelevant to that budget;
 * somebody else's exhaust it. Pulling from a registry with no such cap removes
 * the dependency rather than shrinking it.
 *
 * FALLS BACK TO THE SOURCE. A missing mirror tag is not fatal: the image is
 * pulled from its original registry instead and the run continues, degraded to
 * the rate limit it was trying to avoid. That is deliberate — the mirror exists
 * to remove a flake, and a mirror outage that HARD-FAILED every build would be
 * a worse flake than the one it prevents. The fallback is reported, so a
 * silently-empty mirror shows up as noise rather than as nothing.
 *
 * Gate contract: silent and exit 0 when every image is present; otherwise the
 * whole story between two `[GATE]` lines and a non-zero exit.
 */

import { readFileSync } from "node:fs";

type Image = { source: string; mirror: string; id: string; usedBy: string };
type Manifest = { registry: string; images: Image[] };

const manifest = JSON.parse(
  readFileSync("tests/support/images.json", "utf8"),
) as Manifest;

const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

const fail = (lines: string[]): never => {
  console.error("[GATE] prime-images");
  for (const l of lines) console.error(l);
  console.error("[GATE] prime-images");
  process.exit(1);
};

const problems: string[] = [];
const fellBack: string[] = [];

for (const img of manifest.images) {
  const mirrorRef = `${manifest.registry}/${img.mirror}`;

  let have = run(["docker", "pull", "--quiet", mirrorRef]).exitCode === 0;
  if (have) {
    const tagged = run(["docker", "tag", mirrorRef, img.source]);
    if (tagged.exitCode !== 0) {
      problems.push(`Could not retag ${mirrorRef} as ${img.source}:`, tagged.stderr.toString().trim());
      continue;
    }
  } else {
    fellBack.push(`${img.source} — no mirror tag at ${mirrorRef}`);
    have = run(["docker", "pull", "--quiet", img.source]).exitCode === 0;
  }

  if (!have) {
    problems.push(
      `${img.source} could not be pulled from the mirror or from its source.`,
      `  used by: ${img.usedBy}`,
    );
    continue;
  }

  // Verify only when the mirror has recorded an id AND we are on the platform
  // it recorded. The config digest differs per architecture, so a mismatch on
  // arm64 against an amd64 record would be noise, not a finding.
  if (img.id !== "" && process.arch === "x64") {
    const got = run(["docker", "inspect", "--format", "{{.Id}}", img.source]).stdout.toString().trim();
    if (got !== img.id) {
      problems.push(
        `${img.source} is not the image tests/support/images.json records.`,
        `  expected ${img.id}`,
        `  got      ${got}`,
        `  Refresh the mirror, or update the record if the change was intended.`,
      );
    }
  }
}

if (fellBack.length > 0) {
  console.error(`[prime-images] fell back to the source registry for ${fellBack.length} image(s):`);
  for (const f of fellBack) console.error(`  ${f}`);
  console.error("  Run the mirror-images workflow to populate them.");
}

if (problems.length > 0) {
  fail([
    "Not every upstream image this run needs is available.",
    "",
    ...problems,
  ]);
}
