#!/usr/bin/env bun
/**
 * Copy every image in `tests/support/images.json` from its source registry to
 * this repository's GitHub Container Registry namespace, and record what was
 * copied.
 *
 * Run by `.github/workflows/mirror-images.yml`, monthly. Not a gate: it prints
 * what it did, because a human reads the resulting diff to see whether a
 * floating upstream tag moved.
 *
 * The recorded `id` is the image CONFIG digest, which survives being copied
 * between registries — the manifest digest does not, so it could not verify
 * anything on the far side. It is platform-specific, and this workflow runs on
 * linux/amd64, which is what `scripts/prime-images.ts` checks against.
 */

import { readFileSync, writeFileSync } from "node:fs";

type Image = { source: string; mirror: string; id: string; usedBy: string };
type Manifest = { registry: string; images: Image[] };

const PATH = "tests/support/images.json";
const manifest = JSON.parse(readFileSync(PATH, "utf8")) as Manifest;

const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

const must = (cmd: string[]): string => {
  const r = run(cmd);
  if (r.exitCode !== 0) {
    console.error(`\`${cmd.join(" ")}\` failed:\n${r.stderr.toString()}`);
    process.exit(1);
  }
  return r.stdout.toString().trim();
};

let changed = 0;
for (const img of manifest.images) {
  const mirrorRef = `${manifest.registry}/${img.mirror}`;
  must(["docker", "pull", "--quiet", img.source]);
  const id = must(["docker", "inspect", "--format", "{{.Id}}", img.source]);
  must(["docker", "tag", img.source, mirrorRef]);
  must(["docker", "push", "--quiet", mirrorRef]);

  if (img.id !== id) {
    console.log(`${img.source}: ${img.id === "" ? "first mirror" : "upstream moved"} -> ${id}`);
    img.id = id;
    changed += 1;
  } else {
    console.log(`${img.source}: unchanged`);
  }
}

writeFileSync(PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n${changed} of ${manifest.images.length} image(s) changed.`);
