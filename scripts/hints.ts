#!/usr/bin/env bun
/**
 * Print every error Cyanotype raises, with the condition that raises it and
 * the hint the reader gets — so the part no test can prove can still be
 * audited in one pass.
 *
 * Two of the three layers guarding hints are automatic: `hint-claims.test.ts`
 * proves a hint references things that exist, `hint-remedies.test.ts` proves
 * the advice works for errors whose remedy is executable in-process. Neither
 * can judge whether prose ADVICE is sound — whether "check if the pod is
 * Pending or crash-looping" is the right thing to tell someone. That needs a
 * reader, and a reader needs the whole set in front of them rather than 60
 * throw sites to find first.
 *
 * Usage: `just hints` (all), `just hints k8s` (filter by kind or file).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return srcFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });

type Entry = { kind: string; loc: string; guard: string; hint: string };

const collect = (): Entry[] => {
  const out: Entry[] = [];
  for (const file of srcFiles("src")) {
    const raw = readFileSync(file, "utf8");
    // Blank comments rather than deleting them, so documented example throws are
    // not mistaken for errors WITHOUT shifting every line number after them.
    // Deleting produced locations 10-25 lines low, and picked the `when:` guard
    // off the wrong line — the catalogue exists for the review no test can do,
    // so pointing at the wrong line is the one thing it must not do.
    const text = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^(\s*)\/\/.*$/gm, "$1");
    const lines = text.split("\n");
    for (const m of text.matchAll(/(?:throw|reject\()\s*\{/g)) {
      let depth = 0;
      let i = (m.index ?? 0) + m[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) break; }
      }
      const block = text.slice(m.index ?? 0, i + 1);
      const kind = block.match(/kind:\s*"([a-z0-9_]+)"/)?.[1];
      if (kind === undefined) continue;

      const lineNo = text.slice(0, m.index ?? 0).split("\n").length;
      let guard = "";
      for (let k = lineNo - 1; k >= Math.max(0, lineNo - 7); k--) {
        const L = (lines[k] ?? "").trim();
        if (/^(if|} else if)\s*\(/.test(L) || /^\}?\s*catch\b/.test(L)) { guard = L; break; }
      }

      // Stop at a shorthand property (`names,`) as well as `name:` — otherwise
      // extraction runs past the hint and prints trailing field names as prose.
      const hintRaw = block.match(/hint:\s*([\s\S]*?)(?:,\n\s*\}|,\n\s*\w+\s*[,:])/)?.[1] ?? "";
      const hint = hintRaw
        .replace(/`\s*\+\s*`/g, "")
        .replace(/\$\{([^}]*)\}/g, (_s, expr: string) => `<${expr.trim().split(/[.(\s]/)[0]}>`)
        .replace(/\\?[`"]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      out.push({ kind, loc: `${file}:${lineNo}`, guard: guard.slice(0, 90), hint });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.loc.localeCompare(b.loc));
};

const wrap = (s: string, width: number, indent: string): string => {
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (`${cur} ${w}`.trim().length > width) { lines.push(cur.trim()); cur = w; }
    else cur += ` ${w}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.map((l) => indent + l).join("\n");
};

const filter = process.argv[2];
const entries = collect().filter((e) =>
  filter === undefined || e.kind.includes(filter) || e.loc.includes(filter));

let withHint = 0;
for (const e of entries) {
  if (e.hint !== "") withHint++;
  console.log(`\n\x1b[1m${e.kind}\x1b[0m  \x1b[2m${e.loc}\x1b[0m`);
  if (e.guard !== "") console.log(`  \x1b[2mwhen:\x1b[0m ${e.guard}`);
  console.log(e.hint === ""
    ? "  \x1b[2m(internal — no hint, by design)\x1b[0m"
    : wrap(e.hint, 84, "  "));
}
console.log(`\n${entries.length} throw sites, ${withHint} with a hint, ${entries.length - withHint} internal.`);
console.log("Audit: does each hint's advice actually resolve the condition above it?");
