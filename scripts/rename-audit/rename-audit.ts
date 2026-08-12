#!/usr/bin/env bun
/**
 * Cyanotype rename progress auditor.
 * Usage: bun scripts/rename-audit/rename-audit.ts [flags]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  SCRIPT_VERSION,
  matchContent,
  patterns,
  residualSamples,
  type PatternMatchCounts,
} from "./patterns.ts";
import {
  formatOpsGates,
  isHygieneRoot,
  OPS_GATES,
  REQUIRED_POST_ROOTS,
} from "./gates.ts";

const EXIT = {
  ok: 0,
  residual: 1,
  badArgs: 2,
  missingRoot: 3,
  missingBaseline: 4,
  regression: 5,
  io: 6,
} as const;

type Zone = "library" | "consumer" | "infra" | "simulator";
type RootRole = "required" | "hygiene";

type RootConfig = {
  id: string;
  path: string;
  zone?: Zone;
  role?: RootRole;
  include?: string[];
  exclude?: string[];
};

type AuditConfig = {
  campaign: string;
  resolveRoot?: string;
  baselinePath: string;
  exclude: string[];
  include?: string[];
  roots: RootConfig[];
};

type Mode = "pre" | "post" | "baseline";

type Cli = {
  configPath?: string;
  mode: Mode;
  writeBaseline: boolean;
  rootFilter: string[] | null;
  skipMissingRoots: boolean | null;
  requireAllRoots: boolean | null;
  failOnRegression: boolean | null;
  json: boolean;
  samples: number;
  listPatterns: boolean;
  includeDist: boolean;
  checklist: boolean;
};

type RootScan = {
  id: string;
  zone?: Zone;
  path: string;
  skipped: boolean;
  skipReason?: string;
  filesScanned: number;
  filesSkippedBinary: number;
  oldHits: number;
  newTokenHits: number;
  byPatternOld: Record<string, number>;
  byPatternNew: Record<string, number>;
  byGroupOld: Record<string, number>;
  byGroupNew: Record<string, number>;
  residualFiles: Array<{ path: string; oldHits: number }>;
  samples: Array<{ ref: string; line: number; col: number; snippet: string }>;
};

type BaselineRoot = {
  oldHits: number;
  byPattern: Record<string, number>;
  byGroup: Record<string, number>;
};

type Baseline = {
  createdAt: string;
  campaign: string;
  scriptVersion: number;
  roots: Record<string, BaselineRoot>;
  totals: {
    oldHits: number;
    byPattern: Record<string, number>;
    byGroup: Record<string, number>;
  };
};

function die(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    mode: "pre",
    writeBaseline: false,
    rootFilter: null,
    skipMissingRoots: null,
    requireAllRoots: null,
    failOnRegression: null,
    json: false,
    samples: 20,
    listPatterns: false,
    includeDist: false,
    checklist: false,
  };

  const take = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) {
      die(EXIT.badArgs, `missing value for ${argv[i]}`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--config":
        cli.configPath = take(i);
        i++;
        break;
      case "--mode": {
        const m = take(i);
        i++;
        if (m !== "pre" && m !== "post" && m !== "baseline") {
          die(EXIT.badArgs, `invalid --mode ${m} (pre|post|baseline)`);
        }
        cli.mode = m;
        break;
      }
      case "--write-baseline":
        cli.writeBaseline = true;
        cli.mode = "baseline";
        break;
      case "--roots":
        cli.rootFilter = take(i)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i++;
        break;
      case "--skip-missing-roots":
        cli.skipMissingRoots = true;
        break;
      case "--require-all-roots":
        cli.requireAllRoots = true;
        break;
      case "--fail-on-regression":
        cli.failOnRegression = true;
        break;
      case "--no-fail-on-regression":
        cli.failOnRegression = false;
        break;
      case "--json":
        cli.json = true;
        break;
      case "--samples": {
        const n = Number(take(i));
        i++;
        if (!Number.isFinite(n) || n < 0) die(EXIT.badArgs, `--samples must be >= 0`);
        cli.samples = Math.floor(n);
        break;
      }
      case "--list-patterns":
        cli.listPatterns = true;
        break;
      case "--checklist":
        cli.checklist = true;
        break;
      case "--include-dist":
        cli.includeDist = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(EXIT.ok);
      default:
        die(EXIT.badArgs, `unknown argument: ${a}`);
    }
  }
  return cli;
}

function printHelp(): void {
  console.error(`Cyanotype rename audit

bun scripts/rename-audit/rename-audit.ts
  [--config PATH]
  [--mode pre|post|baseline]
  [--write-baseline]
  [--roots id,id]
  [--skip-missing-roots]
  [--require-all-roots]
  [--fail-on-regression|--no-fail-on-regression]
  [--json]
  [--samples N]
  [--list-patterns]
  [--checklist]
  [--include-dist]
`);
}

function expandEnv(raw: string): string {
  return raw
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-((?:\\.|[^\\}])*)\}/g, (_, key: string, def: string) => {
      const v = process.env[key];
      if (v !== undefined && v !== "") return v;
      return def.replace(/\\(.)/g, "$1");
    })
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, b, c) => {
      const key = (b ?? c) as string;
      return process.env[key] ?? "";
    });
}

function resolveConfigPath(cli: Cli): string {
  if (cli.configPath) return path.resolve(cli.configPath);
  if (process.env.CYANOTYPE_RENAME_AUDIT_CONFIG) {
    return path.resolve(process.env.CYANOTYPE_RENAME_AUDIT_CONFIG);
  }
  const local = path.resolve("scripts/rename-audit/config.local.json");
  if (fs.existsSync(local)) return local;
  const here = path.resolve("scripts/rename-audit/config.json");
  if (fs.existsSync(here)) return here;
  const example = path.resolve("scripts/rename-audit/config.example.json");
  if (fs.existsSync(example)) return example;
  die(EXIT.badArgs, "no config found (pass --config or create scripts/rename-audit/config.local.json)");
}

function loadConfig(configPath: string): AuditConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    die(EXIT.io, `failed to read config ${configPath}: ${String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(EXIT.badArgs, `invalid JSON config ${configPath}: ${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") die(EXIT.badArgs, "config must be an object");
  const c = parsed as Record<string, unknown>;
  if (typeof c.campaign !== "string") die(EXIT.badArgs, "config.campaign required");
  if (typeof c.baselinePath !== "string") die(EXIT.badArgs, "config.baselinePath required");
  if (!Array.isArray(c.exclude)) die(EXIT.badArgs, "config.exclude must be an array");
  if (!Array.isArray(c.roots)) die(EXIT.badArgs, "config.roots must be an array");
  return c as AuditConfig;
}

/** Convert a simple glob (**, *, ?, {a,b}) to a RegExp matched against a relative posix path. */
function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/");
  if (g.startsWith("./")) g = g.slice(2);

  let re = "^";
  let i = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      re += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
        continue;
      }
      const body = g.slice(i + 1, end);
      const alts = body.split(",").map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
      re += `(?:${alts.join("|")})`;
      i = end + 1;
      continue;
    }
    if (".+^$()|[]\\".includes(ch)) re += `\\${ch}`;
    else re += ch;
    i++;
  }
  re += "$";
  return new RegExp(re);
}

function matchesAnyGlob(relPosix: string, globs: string[]): boolean {
  const candidates = [relPosix, relPosix.replace(/^\.\//, "")];
  // also match patterns that target only basename segments
  for (const glob of globs) {
    const re = globToRegExp(glob);
    for (const c of candidates) {
      if (re.test(c)) return true;
      if (re.test(`./${c}`)) return true;
      // trailing slash variants: ensure **/.git/** matches .git/objects/...
      if (!c.endsWith("/") && re.test(`${c}/`)) return true;
    }
    // directory-style: if any path component is excluded at that level
    const parts = relPosix.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth + 1).join("/");
      if (re.test(prefix) || re.test(`${prefix}/`)) return true;
    }
  }
  return false;
}

function isProbablyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n));
    return true;
  } catch {
    return false;
  }
}

function walkFiles(rootAbs: string, excludeGlobs: string[]): string[] {
  const out: string[] = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      if (ent.isDirectory()) {
        if (matchesAnyGlob(rel, excludeGlobs) || matchesAnyGlob(`${rel}/`, excludeGlobs)) continue;
        // always skip .git and node_modules early even if glob oddities
        if (ent.name === ".git" || ent.name === "node_modules") continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (matchesAnyGlob(rel, excludeGlobs)) continue;
      out.push(abs);
    }
  }
  return out;
}

function emptyPatternMaps(): {
  byPatternOld: Record<string, number>;
  byPatternNew: Record<string, number>;
  byGroupOld: Record<string, number>;
  byGroupNew: Record<string, number>;
} {
  const byPatternOld: Record<string, number> = {};
  const byPatternNew: Record<string, number> = {};
  const byGroupOld: Record<string, number> = {};
  const byGroupNew: Record<string, number> = {};
  for (const p of patterns) {
    byPatternOld[p.id] = 0;
    byPatternNew[p.id] = 0;
    byGroupOld[p.group] = 0;
    byGroupNew[p.group] = 0;
  }
  return { byPatternOld, byPatternNew, byGroupOld, byGroupNew };
}

function mergeCounts(into: PatternMatchCounts | ReturnType<typeof emptyPatternMaps>, from: PatternMatchCounts): void {
  for (const p of patterns) {
    (into.byPatternOld as Record<string, number>)[p.id] =
      ((into.byPatternOld as Record<string, number>)[p.id] ?? 0) + (from.byPatternOld[p.id] ?? 0);
    (into.byPatternNew as Record<string, number>)[p.id] =
      ((into.byPatternNew as Record<string, number>)[p.id] ?? 0) + (from.byPatternNew[p.id] ?? 0);
  }
  for (const g of Object.keys(from.byGroupOld)) {
    (into.byGroupOld as Record<string, number>)[g] =
      ((into.byGroupOld as Record<string, number>)[g] ?? 0) + (from.byGroupOld[g] ?? 0);
    (into.byGroupNew as Record<string, number>)[g] =
      ((into.byGroupNew as Record<string, number>)[g] ?? 0) + (from.byGroupNew[g] ?? 0);
  }
}

function scanRoot(
  root: RootConfig,
  rootAbs: string,
  excludeGlobs: string[],
  sampleBudget: number,
): RootScan {
  const maps = emptyPatternMaps();
  let oldHits = 0;
  let newTokenHits = 0;
  let filesScanned = 0;
  let filesSkippedBinary = 0;
  const residualFiles: Array<{ path: string; oldHits: number }> = [];
  const samples: RootScan["samples"] = [];

  const files = walkFiles(rootAbs, excludeGlobs);
  for (const abs of files) {
    const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(fs.readFileSync(abs));
    } catch {
      filesSkippedBinary++;
      continue;
    }
    if (!isProbablyText(bytes)) {
      filesSkippedBinary++;
      // still scan relative path for residual / patterns
      const pathHits = matchContent(rel);
      oldHits += pathHits.residual;
      newTokenHits += pathHits.totalNewPatternHits;
      mergeCounts(maps, pathHits);
      if (pathHits.residual > 0) {
        residualFiles.push({ path: rel, oldHits: pathHits.residual });
        if (samples.length < sampleBudget) {
          samples.push({ ref: `${root.id}:${rel}`, line: 0, col: 1, snippet: rel });
        }
      }
      continue;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      filesSkippedBinary++;
      continue;
    }

    filesScanned++;
    const contentHits = matchContent(text);
    const pathHits = matchContent(rel);

    const fileResidual = contentHits.residual + pathHits.residual;
    oldHits += fileResidual;
    newTokenHits += contentHits.totalNewPatternHits + pathHits.totalNewPatternHits;
    mergeCounts(maps, contentHits);
    mergeCounts(maps, pathHits);

    if (fileResidual > 0) {
      residualFiles.push({ path: rel, oldHits: fileResidual });
      if (samples.length < sampleBudget) {
        const lineSamples = residualSamples(text, sampleBudget - samples.length);
        for (const s of lineSamples) {
          if (samples.length >= sampleBudget) break;
          samples.push({
            ref: `${root.id}:${rel}`,
            line: s.line,
            col: s.col,
            snippet: s.snippet,
          });
        }
        if (pathHits.residual > 0 && samples.length < sampleBudget) {
          samples.push({ ref: `${root.id}:${rel}`, line: 0, col: 1, snippet: rel });
        }
      }
    }
  }

  residualFiles.sort((a, b) => b.oldHits - a.oldHits);

  return {
    id: root.id,
    zone: root.zone,
    path: rootAbs,
    skipped: false,
    filesScanned,
    filesSkippedBinary,
    oldHits,
    newTokenHits,
    byPatternOld: maps.byPatternOld,
    byPatternNew: maps.byPatternNew,
    byGroupOld: maps.byGroupOld,
    byGroupNew: maps.byGroupNew,
    residualFiles,
    samples,
  };
}

function progressPct(current: number, baseline: number | undefined): number | null {
  if (baseline === undefined) return null;
  if (baseline === 0) return current === 0 ? 100 : 0;
  const raw = 100 * (1 - current / baseline);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function statusFor(
  oldHits: number,
  baseline: number | undefined,
): "done" | "not-started" | "in-progress" | "regressed" | "unknown" {
  if (oldHits === 0) return "done";
  if (baseline === undefined) return "unknown";
  if (oldHits > baseline) return "regressed";
  if (oldHits === baseline) return "not-started";
  return "in-progress";
}

function loadBaseline(baselineAbs: string): Baseline | null {
  if (!fs.existsSync(baselineAbs)) return null;
  try {
    const raw = fs.readFileSync(baselineAbs, "utf8");
    return JSON.parse(raw) as Baseline;
  } catch (e) {
    die(EXIT.io, `failed to read baseline ${baselineAbs}: ${String(e)}`);
  }
}

function writeBaselineFile(baselineAbs: string, baseline: Baseline): void {
  try {
    fs.mkdirSync(path.dirname(baselineAbs), { recursive: true });
    const tmp = `${baselineAbs}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, baselineAbs);
  } catch (e) {
    die(EXIT.io, `failed to write baseline ${baselineAbs}: ${String(e)}`);
  }
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function rpad(n: number | string, w: number): string {
  const s = String(n);
  if (s.length >= w) return s;
  return " ".repeat(w - s.length) + s;
}

function humanReport(
  campaign: string,
  mode: Mode,
  configPath: string,
  baseline: Baseline | null,
  baselinePath: string,
  roots: RootScan[],
  totals: { oldHits: number; newTokenHits: number; byPatternOld: Record<string, number>; byGroupOld: Record<string, number> },
  samples: RootScan["samples"],
  exitRationale: string,
): string {
  const lines: string[] = [];
  lines.push(`Cyanotype rename audit  campaign=${campaign}  mode=${mode}`);
  lines.push(`Config: ${configPath}`);
  if (baseline) {
    lines.push(
      `Baseline: ${baselinePath}  (${baseline.createdAt})  scriptVersion=${baseline.scriptVersion}`,
    );
  } else {
    lines.push(`Baseline: (none)  path=${baselinePath}`);
  }
  lines.push("");
  lines.push(
    `${pad("ROOT", 28)} ${rpad("OLD now", 9)} ${rpad("BASELINE", 9)} ${rpad("PROGRESS", 9)} ${rpad("NEW tokens", 11)} STATUS`,
  );

  for (const r of roots) {
    if (r.skipped) {
      lines.push(
        `${pad(r.id, 28)} ${rpad("-", 9)} ${rpad("-", 9)} ${rpad("-", 9)} ${rpad("-", 11)} skipped (${r.skipReason})`,
      );
      continue;
    }
    const base = baseline?.roots[r.id]?.oldHits;
    const pct = progressPct(r.oldHits, base);
    const st = statusFor(r.oldHits, base);
    lines.push(
      `${pad(r.id, 28)} ${rpad(r.oldHits, 9)} ${rpad(base ?? "-", 9)} ${rpad(pct === null ? "-" : `${pct}%`, 9)} ${rpad(r.newTokenHits, 11)} ${st}`,
    );
  }

  const totalBase = baseline?.totals.oldHits;
  const totalPct = progressPct(totals.oldHits, totalBase);
  lines.push("─".repeat(80));
  lines.push(
    `${pad("TOTAL", 28)} ${rpad(totals.oldHits, 9)} ${rpad(totalBase ?? "-", 9)} ${rpad(totalPct === null ? "-" : `${totalPct}%`, 9)} ${rpad(totals.newTokenHits, 11)}`,
  );
  lines.push("");

  lines.push("By group (old remaining):");
  const groups = Object.entries(totals.byGroupOld).sort((a, b) => b[1] - a[1]);
  for (const [g, n] of groups) {
    if (n === 0) continue;
    lines.push(`  ${pad(g, 18)} ${n}`);
  }
  lines.push("");

  lines.push("Pattern backlog (old remaining, top 15):");
  const top = Object.entries(totals.byPatternOld)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  if (top.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [id, n] of top) {
      lines.push(`  ${pad(id, 28)} ${n}`);
    }
  }
  lines.push("");

  lines.push(`Residual samples (max ${samples.length}):`);
  if (samples.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of samples) {
      const loc = s.line > 0 ? `${s.ref}:${s.line}` : s.ref;
      lines.push(`  ${loc}  ${JSON.stringify(s.snippet)}`);
    }
  }
  lines.push("");
  lines.push(formatOpsGates());
  lines.push("");
  lines.push(exitRationale);
  return lines.join("\n");
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.checklist) {
    if (cli.json) {
      console.log(JSON.stringify({ scriptVersion: SCRIPT_VERSION, opsGates: OPS_GATES, requiredPostRoots: REQUIRED_POST_ROOTS }, null, 2));
    } else {
      console.error(formatOpsGates());
      console.error(`required post roots: ${REQUIRED_POST_ROOTS.join(", ")}`);
      console.error("hygiene roots may be missing in --mode post without --require-all-roots");
    }
    process.exit(EXIT.ok);
  }

  if (cli.listPatterns) {
    const rows = patterns.map((p) => ({
      id: p.id,
      group: p.group,
      old: p.old,
      neu: p.neu,
      caseSensitive: p.caseSensitive !== false,
    }));
    if (cli.json) {
      console.log(JSON.stringify({ scriptVersion: SCRIPT_VERSION, patterns: rows }, null, 2));
    } else {
      console.error(`# ${patterns.length} patterns (scriptVersion=${SCRIPT_VERSION})`);
      for (const p of rows) {
        console.error(`${p.group}\t${p.id}\t${p.old}\t→\t${p.neu}`);
      }
    }
    process.exit(EXIT.ok);
  }

  const configPath = resolveConfigPath(cli);
  const config = loadConfig(configPath);
  const resolveRoot =
    config.resolveRoot !== undefined
      ? path.resolve(expandEnv(config.resolveRoot))
      : process.env.CYANOTYPE_RENAME_AUDIT_ROOT
        ? path.resolve(process.env.CYANOTYPE_RENAME_AUDIT_ROOT)
        : process.cwd();

  const mode: Mode = cli.writeBaseline ? "baseline" : cli.mode;

  // Default: fail on regression in pre when a baseline exists.
  // Explicit --fail-on-regression without a baseline → exit 4.
  // Explicit --no-fail-on-regression disables the check.
  const failOnRegressionExplicit = cli.failOnRegression;

  let rootConfigs = config.roots;
  if (cli.rootFilter) {
    const want = new Set(cli.rootFilter);
    const unknown = cli.rootFilter.filter((id) => !config.roots.some((r) => r.id === id));
    if (unknown.length > 0) die(EXIT.badArgs, `unknown root id(s): ${unknown.join(", ")}`);
    rootConfigs = config.roots.filter((r) => want.has(r.id));
  }

  const allowSkip = (root: RootConfig): boolean => {
    if (cli.requireAllRoots) return false;
    if (cli.skipMissingRoots) return true;
    if (root.role === "hygiene" || isHygieneRoot(root.id)) return true;
    return mode !== "post";
  };

  const baselineRel = expandEnv(config.baselinePath);
  const baselineAbs = path.isAbsolute(baselineRel)
    ? baselineRel
    : path.resolve(resolveRoot, baselineRel);

  const excludeBase = [...config.exclude];
  if (cli.includeDist) {
    for (let i = excludeBase.length - 1; i >= 0; i--) {
      if (excludeBase[i]!.includes("dist")) excludeBase.splice(i, 1);
    }
  }

  const scanned: RootScan[] = [];
  for (const root of rootConfigs) {
    const expanded = expandEnv(root.path).trim();
    if (!expanded) {
      if (allowSkip(root)) {
        console.error(`WARN: root "${root.id}" path empty after env expansion — skipping`);
        scanned.push({
          id: root.id,
          zone: root.zone,
          path: expanded,
          skipped: true,
          skipReason: "empty path / unset env",
          filesScanned: 0,
          filesSkippedBinary: 0,
          oldHits: 0,
          newTokenHits: 0,
          ...emptyPatternMaps(),
          residualFiles: [],
          samples: [],
        });
        continue;
      }
      die(EXIT.missingRoot, `root "${root.id}" path empty after env expansion (${root.path})`);
    }

    const rootAbs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(resolveRoot, expanded);

    if (!fs.existsSync(rootAbs)) {
      if (allowSkip(root)) {
        console.error(`WARN: root "${root.id}" missing at ${rootAbs} — skipping`);
        scanned.push({
          id: root.id,
          zone: root.zone,
          path: rootAbs,
          skipped: true,
          skipReason: "path does not exist",
          filesScanned: 0,
          filesSkippedBinary: 0,
          oldHits: 0,
          newTokenHits: 0,
          ...emptyPatternMaps(),
          residualFiles: [],
          samples: [],
        });
        continue;
      }
      die(EXIT.missingRoot, `root "${root.id}" missing at ${rootAbs}`);
    }

    const excludes = [...excludeBase, ...(root.exclude ?? []), ...(config.exclude ?? [])];
    // de-dupe
    const uniq = [...new Set(excludes)];
    try {
      const result = scanRoot(root, rootAbs, uniq, cli.samples);
      scanned.push(result);
    } catch (e) {
      die(EXIT.io, `scan failed for root "${root.id}": ${String(e)}`);
    }
  }

  if (mode === "post" && cli.rootFilter === null) {
    for (const id of REQUIRED_POST_ROOTS) {
      const r = scanned.find((s) => s.id === id);
      if (!r || r.skipped) {
        die(
          EXIT.missingRoot,
          `required post root "${id}" missing — freeze inventory incomplete (hygiene worktrees may skip; this one may not)`,
        );
      }
    }
  }

  const active = scanned.filter((r) => !r.skipped);
  const totalsMaps = emptyPatternMaps();
  let totalOld = 0;
  let totalNew = 0;
  const allSamples: RootScan["samples"] = [];
  for (const r of active) {
    totalOld += r.oldHits;
    totalNew += r.newTokenHits;
    for (const p of patterns) {
      totalsMaps.byPatternOld[p.id] =
        (totalsMaps.byPatternOld[p.id] ?? 0) + (r.byPatternOld[p.id] ?? 0);
      totalsMaps.byPatternNew[p.id] =
        (totalsMaps.byPatternNew[p.id] ?? 0) + (r.byPatternNew[p.id] ?? 0);
    }
    for (const g of Object.keys(r.byGroupOld)) {
      totalsMaps.byGroupOld[g] = (totalsMaps.byGroupOld[g] ?? 0) + (r.byGroupOld[g] ?? 0);
      totalsMaps.byGroupNew[g] = (totalsMaps.byGroupNew[g] ?? 0) + (r.byGroupNew[g] ?? 0);
    }
    for (const s of r.samples) {
      if (allSamples.length >= cli.samples) break;
      allSamples.push(s);
    }
  }

  if (mode === "baseline") {
    const rootsBaseline: Record<string, BaselineRoot> = {};
    for (const r of active) {
      rootsBaseline[r.id] = {
        oldHits: r.oldHits,
        byPattern: { ...r.byPatternOld },
        byGroup: { ...r.byGroupOld },
      };
    }
    const baseline: Baseline = {
      createdAt: new Date().toISOString(),
      campaign: config.campaign,
      scriptVersion: SCRIPT_VERSION,
      roots: rootsBaseline,
      totals: {
        oldHits: totalOld,
        byPattern: { ...totalsMaps.byPatternOld },
        byGroup: { ...totalsMaps.byGroupOld },
      },
    };
    writeBaselineFile(baselineAbs, baseline);
    const msg = `wrote baseline → ${baselineAbs}  roots=${active.length}  totalOldHits=${totalOld}`;
    if (cli.json) {
      console.log(JSON.stringify({ ok: true, baseline, path: baselineAbs }, null, 2));
    } else {
      console.error(msg);
    }
    process.exit(EXIT.ok);
  }

  const baseline = loadBaseline(baselineAbs);

  if (failOnRegressionExplicit === true && !baseline) {
    die(
      EXIT.missingBaseline,
      `baseline required for --fail-on-regression but missing: ${baselineAbs}\n  run with --write-baseline first, or omit --fail-on-regression`,
    );
  }

  const checkRegression =
    failOnRegressionExplicit !== false && mode === "pre" && baseline !== null;

  let exitCode: number = EXIT.ok;
  let exitRationale = `mode=${mode} → exit 0`;

  if (mode === "post") {
    if (totalOld > 0) {
      exitCode = EXIT.residual;
      exitRationale = `mode=post residualOld=${totalOld} → exit ${EXIT.residual}`;
    } else {
      exitRationale = `mode=post residualOld=0 → exit 0`;
    }
  } else if (mode === "pre") {
    if (checkRegression && baseline) {
      let regressed = false;
      if (totalOld > baseline.totals.oldHits) regressed = true;
      for (const r of active) {
        const b = baseline.roots[r.id];
        if (b && r.oldHits > b.oldHits) regressed = true;
      }
      if (regressed) {
        exitCode = EXIT.regression;
        exitRationale = `mode=pre regression vs baseline → exit ${EXIT.regression}`;
      } else {
        exitRationale = `mode=pre  residual allowed  regression=no → exit 0`;
      }
    } else {
      exitRationale = `mode=pre  residual allowed → exit 0`;
    }
  }

  const reportPayload = {
    campaign: config.campaign,
    mode,
    scriptVersion: SCRIPT_VERSION,
    configPath,
    baselinePath: baselineAbs,
    baseline: baseline
      ? { createdAt: baseline.createdAt, scriptVersion: baseline.scriptVersion, totals: baseline.totals }
      : null,
    roots: scanned.map((r) => {
      const base = baseline?.roots[r.id]?.oldHits;
      return {
        id: r.id,
        zone: r.zone,
        path: r.path,
        skipped: r.skipped,
        skipReason: r.skipReason,
        filesScanned: r.filesScanned,
        filesSkippedBinary: r.filesSkippedBinary,
        oldHits: r.oldHits,
        newTokenHits: r.newTokenHits,
        baselineOldHits: base ?? null,
        progressPct: progressPct(r.oldHits, base),
        status: r.skipped ? "skipped" : statusFor(r.oldHits, base),
        byPatternOld: r.byPatternOld,
        byPatternNew: r.byPatternNew,
        byGroupOld: r.byGroupOld,
        byGroupNew: r.byGroupNew,
        topResidualFiles: r.residualFiles.slice(0, 10),
      };
    }),
    totals: {
      oldHits: totalOld,
      newTokenHits: totalNew,
      baselineOldHits: baseline?.totals.oldHits ?? null,
      progressPct: progressPct(totalOld, baseline?.totals.oldHits),
      byPatternOld: totalsMaps.byPatternOld,
      byPatternNew: totalsMaps.byPatternNew,
      byGroupOld: totalsMaps.byGroupOld,
      byGroupNew: totalsMaps.byGroupNew,
    },
    samples: allSamples,
    opsGates: OPS_GATES,
    exitCode,
    exitRationale,
  };

  if (cli.json) {
    console.log(JSON.stringify(reportPayload, null, 2));
    console.error(exitRationale);
  } else {
    const text = humanReport(
      config.campaign,
      mode,
      configPath,
      baseline,
      baselineAbs,
      scanned,
      {
        oldHits: totalOld,
        newTokenHits: totalNew,
        byPatternOld: totalsMaps.byPatternOld,
        byGroupOld: totalsMaps.byGroupOld,
      },
      allSamples,
      exitRationale,
    );
    console.error(text);
  }

  process.exit(exitCode);
}

main();
