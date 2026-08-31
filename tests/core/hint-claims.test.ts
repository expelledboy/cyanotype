/**
 * Claim lint: a hint may not reference something that does not exist.
 *
 * The worst failure mode of a hint is a confident lie. Three real ones shipped
 * before this existed: advice to run a `just` recipe consumers do not have, a
 * scope claim that was wrong ("the same file"), and a remedy that cannot work
 * (`stopAll()` does not touch another process's containers).
 *
 * This catches the mechanical third of that: identifier-shaped claims that no
 * longer resolve. A method renamed, a config path removed, a doc moved — all
 * silently orphan every hint that mentions them, and nothing else in the build
 * would notice. It cannot catch behavioural claims; `tests/core/hint-remedies.test.ts`
 * proves those by executing them, and what neither can reach is reviewed via
 * `just hints`.
 *
 * Interpolations are stripped before extraction: `${missing.join(", ")}` is code
 * in the hint's own template, not a claim about Cyanotype's API.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return srcFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });

const SRC = srcFiles("src");
const ALL_SOURCE = SRC.map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * Source with the hint literals removed, and nothing else.
 *
 * The name index MUST be built from this, not from ALL_SOURCE. Hints live in
 * the same files they describe, so harvesting names from raw source lets a hint
 * vouch for itself: write `shared.ensureNope(...)` in a hint and the harvester
 * reads `.ensureNope(` straight back out of that string as evidence the method
 * exists. The first version of this lint did exactly that and passed its own
 * negative control.
 *
 * The hint spans are removed exactly. An earlier attempt stripped EVERY string
 * literal, which ate real code and made genuine API names like
 * `createEnvironment` look unresolved — a lint that cries wolf gets disabled.
 */
const SOURCE_WITHOUT_HINTS = ((): string => {
  let out = "";
  for (const file of SRC) {
    let text = readFileSync(file, "utf8");
    for (const m of [...text.matchAll(/hint:\s*([\s\S]{0,1600}?)[`"],\n/g)].reverse()) {
      const at = m.index ?? 0;
      text = `${text.slice(0, at)}\n${text.slice(at + m[0].length)}`;
    }
    out += `${text}\n`;
  }
  return out;
})();

/** Hint literals, with `${...}` interpolation removed. */
const hintTexts = (): { file: string; text: string }[] => {
  const out: { file: string; text: string }[] = [];
  for (const file of SRC) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/hint:\s*([\s\S]{0,1600}?)[`"],\n/g)) {
      const literal = (m[1] ?? "")
        .replace(/\$\{[^}]*\}/g, " ")   // interpolated expressions are code, not claims
        .replace(/`\s*\+\s*`/g, "")      // rejoin concatenated template pieces
        .replace(/[`"']/g, " ");
      out.push({ file, text: literal });
    }
  }
  return out;
};

/**
 * Names declared anywhere in src — exports, object keys, type members. Loose on
 * purpose: the goal is catching a claim that resolves to NOTHING, not proving
 * the reference is well-typed. TypeScript already does the latter for code, and
 * a hint is a string.
 */
const declaredNames = (): Set<string> => {
  const names = new Set<string>();
  for (const m of SOURCE_WITHOUT_HINTS.matchAll(/(?:export\s+(?:const|function|type|interface)\s+|readonly\s+|const\s+)([A-Za-z_]\w*)/g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  for (const m of SOURCE_WITHOUT_HINTS.matchAll(/^\s*([a-zA-Z_]\w*)\??\s*[:(]/gm)) if (m[1] !== undefined) names.add(m[1]);
  for (const m of SOURCE_WITHOUT_HINTS.matchAll(/\.([a-zA-Z_]\w*)\s*\(/g)) if (m[1] !== undefined) names.add(m[1]);
  return names;
};

const NAMES = declaredNames();

/**
 * Claims outside this repository. Each needs a reason: the lint cannot resolve
 * it, so a human decided it is real.
 */
const EXTERNAL_ALLOWLIST = new Map<string, string>([
  ["docker compose", "bringing the consumer's own Compose stack up, which attach mode requires and never does itself"],
  ["docker ps", "inspecting the consumer's own containers to see the state the error reports"],
  ["kubectl describe", "reading the consumer's own pod to distinguish unschedulable from crash-looping"],
  ["kubectl scale", "naming the write chaos performs, so the RBAC requirement is concrete"],
  ["kubectl port-forward", "naming the process the adapter spawns, so a reader can find and kill leaked ones — not a command we ask them to run"],
]);

/**
 * Words that make `<tool> <word>` a COMMAND rather than prose mentioning the
 * tool. Without this the check fires on "kubectl is using" and "kubectl and
 * make", which suggest nothing.
 */
const SUBCOMMANDS = new Set([
  "ps", "compose", "run", "logs", "inspect", "images", "pull", "start", "stop", "rm",
  "get", "describe", "apply", "delete", "scale", "exec", "wait", "port-forward",
  "rollout", "version", "config",
]);

describe("hint claims resolve", () => {
  const hints = hintTexts();

  test("there are hints to check", () => {
    expect(hints.length).toBeGreaterThan(30);
  });

  test("every API name a hint mentions exists in src", () => {
    const unresolved: string[] = [];
    for (const { file, text } of hints) {
      // `name(` with no space before the paren — a call, with or without
      // arguments. Matching only `name()` missed every reference that carries
      // one, which is most of them: a renamed `shared.ensure(envKey)` slipped
      // through the first version of this check.
      for (const m of text.matchAll(/\b([a-zA-Z_]\w*)\(/g)) {
        const name = m[1] ?? "";
        if (name !== "" && !NAMES.has(name)) unresolved.push(`${name}() — ${file}`);
      }
    }
    expect([...new Set(unresolved)]).toEqual([]);
  });

  test("every dotted config path a hint mentions exists in src", () => {
    const unresolved: string[] = [];
    for (const { file, text } of hints) {
      // `adapter.k8s.attach.deployment`, `adapter.compose.attach.allowChaos`
      for (const m of text.matchAll(/\badapter\.([a-zA-Z_][\w.]*)/g)) {
        for (const seg of (m[1] ?? "").split(".")) {
          if (seg && !NAMES.has(seg)) unresolved.push(`adapter.${m[1]} (segment "${seg}") — ${file}`);
        }
      }
    }
    expect([...new Set(unresolved)]).toEqual([]);
  });

  test("every mode: a hint names is a real SharedMode", () => {
    const modeUnion = readFileSync("src/shared.ts", "utf8").match(/SharedMode\s*=\s*([^;]+);/)?.[1] ?? "";
    const valid = new Set([...modeUnion.matchAll(/"(\w+)"/g)].map((m) => m[1]));
    expect(valid.size).toBeGreaterThan(1);
    const bad: string[] = [];
    for (const { file, text } of hints) {
      for (const m of text.matchAll(/mode:\s*(\w+)/g)) {
        if (m[1] !== undefined && !valid.has(m[1])) bad.push(`mode: ${m[1]} — ${file}`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  test("every file a hint points at exists AND is published to consumers", () => {
    // Existing in this repo is not enough. A hint is read by someone who
    // installed the package, so the path must be inside `package.json` files —
    // otherwise it is the same failure as telling them to run a `just` recipe
    // they do not have. `docs/` was referenced by hints for a release before
    // anyone noticed it was not shipped.
    const published: string[] = JSON.parse(readFileSync("package.json", "utf8")).files;
    const missing: string[] = [];
    const unpublished: string[] = [];
    for (const { file, text } of hints) {
      for (const m of text.matchAll(/\b((?:docs|src|scripts|tests)\/[\w./-]+)/g)) {
        // Trim trailing sentence punctuation: "see docs/k8s-rbac.md." is a
        // reference followed by a full stop, not a path ending in a dot.
        const ref = (m[1] ?? "").replace(/[.,;:]+$/, "");
        if (ref === "") continue;
        if (!existsSync(ref)) missing.push(`${ref} — ${file}`);
        else if (!published.some((root) => ref === root || ref.startsWith(`${root}/`))) {
          unpublished.push(`${ref} (not in package.json files) — ${file}`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
    expect([...new Set(unpublished)]).toEqual([]);
  });

  test("every env var a hint names is read by src", () => {
    const unread: string[] = [];
    for (const { file, text } of hints) {
      for (const m of text.matchAll(/\b(CYANOTYPE_[A-Z_]+)\b/g)) {
        if (m[1] !== undefined && !ALL_SOURCE.includes(m[1])) unread.push(`${m[1]} — ${file}`);
      }
    }
    expect([...new Set(unread)]).toEqual([]);
  });

  test("a command a hint tells you to run is allowlisted with a reason", () => {
    // Telling a consumer to run something is the highest-risk kind of hint: it
    // is the one they will act on verbatim. Each such command is vetted once,
    // here, with why it is legitimate to send them to a tool we do not own.
    const unlisted: string[] = [];
    for (const { file, text } of hints) {
      for (const m of text.matchAll(/\b(docker|kubectl)\s+([a-z-]+)/g)) {
        const tool = m[1] ?? "";
        const sub = m[2] ?? "";
        if (!SUBCOMMANDS.has(sub)) continue;   // prose mentioning the tool, not a command
        const phrase = `${tool} ${sub}`;
        if (!EXTERNAL_ALLOWLIST.has(phrase)) unlisted.push(`"${phrase}" — ${file}`);
      }
    }
    expect([...new Set(unlisted)]).toEqual([]);
  });

  test("every allowlisted command carries a reason", () => {
    for (const [phrase, reason] of EXTERNAL_ALLOWLIST) {
      expect(reason.length, `${phrase} needs a real justification`).toBeGreaterThan(20);
    }
  });
});
