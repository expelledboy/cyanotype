/**
 * A hint may not cite a field the thrown object does not carry.
 *
 * This is the gap neither other layer can see. `hint-claims.test.ts` resolves
 * call-shaped and dotted references (`ensure()`, `adapter.k8s.attach.service`);
 * a bare noun like `matched` is neither, so when `sequence_timeout` told readers
 * to consult a `matched` field that had never existed, nothing failed. Two full
 * review rounds missed it too — it took a human-style read to notice.
 *
 * The convention it enforces: **backtick the evidence you name.** A hint saying
 * "`seen` shows how far it got" is checkable; "seen shows how far it got" is
 * prose and indistinguishable from ordinary English ("these names", "the file
 * names"). Backticks are cheap, they read better, and they make the claim
 * mechanical.
 *
 * Only bare identifiers are treated as field references. Anything with a dot,
 * parens, a space, or an `=` is an API name, config path, label or command —
 * those are `hint-claims.test.ts`'s job.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return srcFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });

/**
 * Bare backticked identifiers that are deliberately not fields of the throw.
 * Each needs a reason, so the escape hatch cannot quietly become the norm.
 */
const NOT_A_FIELD = new Map<string, string>([
  ["auto", "the literal port value a Binding assigns, not a field of the error"],
  ["warn", "an onImageDrift policy value"],
  ["ignore", "an onImageDrift policy value"],
  ["fail", "an onImageDrift policy value"],
  ["ports", "a field of the consumer's Binding, not of this error"],
  ["portNames", "a field of the consumer's Blueprint, not of this error"],
  ["mounts", "a field of the consumer's Binding, not of this error"],
  ["logParser", "a field of the consumer's Binding, not of this error"],
  ["readiness", "a field of the consumer's Blueprint, not of this error"],
  ["timeoutMs", "an option on the consumer's probe declaration"],
  ["project", "a compose project name the consumer configures"],
  ["deployment", "a Kubernetes object name, not a field of this error"],
  ["namespace", "a Kubernetes namespace, not a field of this error"],
  ["stateDir", "an option the consumer passes to createSharedEnvs"],
  ["envKey", "the environment key the consumer chose"],
  ["instance", "a component instance name the consumer chose"],
  ["component", "a component name the consumer chose"],
  ["cyanotype", "the label key stamped on containers"],
  ["FROM_START", "an exported checkpoint constant"],
]);

type Site = { file: string; kind: string; fields: Set<string>; hint: string };

const sites = (): Site[] => {
  const out: Site[] = [];
  for (const file of srcFiles("src")) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:throw|reject\()\s*\{/g)) {
      let depth = 0;
      let i = (m.index ?? 0) + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) break; }
      }
      const block = text.slice(m.index ?? 0, i + 1);
      const kind = block.match(/kind:\s*"([a-z0-9_]+)"/)?.[1];
      const hint = block.match(/hint:\s*([\s\S]*?)(?:,\n\s*\}|,\n\s*\w+:)/)?.[1];
      if (kind === undefined || hint === undefined) continue;

      // Field names: everything before the hint, as `name:` or shorthand `name,`.
      const head = block.slice(0, block.indexOf("hint:"));
      const fields = new Set(
        [...head.matchAll(/([a-zA-Z_]\w*)\s*[,:]/g)].map((f) => f[1] ?? ""),
      );
      out.push({ file, kind, fields, hint });
    }
  }
  return out;
};

describe("hint field references", () => {
  const all = sites();

  test("there are hinted throw sites to check", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  test("every backticked bare identifier in a hint is a field on that throw", () => {
    const bogus: string[] = [];
    for (const { file, kind, fields, hint } of all) {
      // Only literal text: an interpolation is the hint's own code.
      const literal = hint.replace(/\$\{[^}]*\}/g, " ");
      for (const m of literal.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g)) {
        const name = m[1] ?? "";
        if (fields.has(name) || NOT_A_FIELD.has(name)) continue;
        bogus.push(`${kind}: \`${name}\` is not a field of this throw — ${file}`);
      }
    }
    expect([...new Set(bogus)]).toEqual([]);
  });

  test("every NOT_A_FIELD exemption carries a reason", () => {
    for (const [name, reason] of NOT_A_FIELD) {
      expect(reason.length, `\`${name}\` needs a real justification`).toBeGreaterThan(15);
    }
  });
});
