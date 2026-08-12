#!/usr/bin/env bun
/**
 * cyanotype CLI — shipped as `bin.cyanotype` in package.json.
 *
 * Commands:
 *   cyanotype derive compose --compose <file> --out <file|-> [--project <name>]
 *   cyanotype derive k8s     --k8s <dir|file>  --out <file|->
 */

import { writeFileSync } from "node:fs";
import { deriveCompose, deriveK8s } from "./derive.js";

const argv = process.argv.slice(2);

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const usage = (): never => {
  process.stderr.write(
    [
      "Usage:",
      "  cyanotype derive compose --compose <file> --out <file|-> [--project <name>]",
      "  cyanotype derive k8s     --k8s <dir|file>  --out <file|->",
      "",
    ].join("\n"),
  );
  process.exit(2);
};

const [cmd, sub] = argv;

if (cmd !== "derive" || (sub !== "compose" && sub !== "k8s")) {
  usage();
}

const out = flag("--out");
if (!out) {
  process.stderr.write("error: --out is required\n");
  usage();
}

let derived: Record<string, unknown>;

if (sub === "compose") {
  const composePath = flag("--compose");
  if (!composePath) {
    process.stderr.write("error: --compose is required\n");
    usage();
  }
  const project = flag("--project");
  derived = deriveCompose(composePath!, project);
} else {
  // sub === "k8s"
  const k8sPath = flag("--k8s");
  if (!k8sPath) {
    process.stderr.write("error: --k8s is required\n");
    usage();
  }
  derived = deriveK8s(k8sPath!);
}

const json = JSON.stringify(derived, null, 2);
if (out === "-") process.stdout.write(json + "\n");
else writeFileSync(out!, json + "\n");
