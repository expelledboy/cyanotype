#!/usr/bin/env bun
/**
 * Thin wrapper around the shipped `src/cli/derive` library functions.
 *
 * Usage (K8s):
 *   bun tests/petstore-example/scripts/derive-cyanotype.ts \
 *     --k8s tests/support/k8s/petstore-attach/all.yaml \
 *     --out tests/petstore-example/derived.json
 *
 * Usage (Compose):
 *   bun tests/petstore-example/scripts/derive-cyanotype.ts \
 *     --compose tests/support/compose/petstore-attach/compose.yaml \
 *     --out tests/petstore-example/derived-compose.json
 */

import { writeFileSync } from "node:fs";
import { deriveCompose, deriveK8s } from "../../../src/cli/derive.js";

const args = (() => {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const k8s = get("--k8s");
  const compose = get("--compose");
  const out = get("--out");
  if ((!k8s && !compose) || !out) {
    console.error(
      "usage: derive-cyanotype.ts (--k8s <dir-or-file> | --compose <file>) --out <file-or-->",
    );
    process.exit(2);
  }
  return { k8s, compose, out };
})();

const derived: Record<string, unknown> = args.compose
  ? deriveCompose(args.compose)
  : deriveK8s(args.k8s!);

const json = JSON.stringify(derived, null, 2);
if (args.out === "-") process.stdout.write(json + "\n");
else writeFileSync(args.out, json + "\n");
