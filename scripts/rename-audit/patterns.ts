export type PatternGroup =
  | "package"
  | "cli"
  | "env"
  | "label"
  | "path"
  | "image"
  | "error-kind"
  | "brand"
  | "url"
  | "consumer-fixture";

export type Pattern = {
  id: string;
  old: string;
  neu: string;
  /** default true */
  caseSensitive?: boolean;
  group: PatternGroup;
};

/**
 * Canonical Speculum → Cyanotype OLD→NEW registry.
 * Apply via longest-first non-overlapping scan (see matchContent).
 * Compound / longer tokens are listed before shorter; brand-lower is last.
 */
export const patterns: Pattern[] = [
  // package
  {
    id: "pkg-scoped",
    old: "@expelledboy/speculum",
    neu: "@expelledboy/cyanotype",
    group: "package",
  },
  {
    id: "pkg-deep-import-double",
    old: '"speculum/',
    neu: '"cyanotype/',
    group: "package",
  },
  {
    id: "pkg-deep-import-single",
    old: "'speculum/",
    neu: "'cyanotype/",
    group: "package",
  },

  // url
  {
    id: "repo-slug-url",
    old: "github.com/expelledboy/speculum",
    neu: "github.com/expelledboy/cyanotype",
    group: "url",
  },
  {
    id: "repo-slug-bare",
    old: "expelledboy/speculum",
    neu: "expelledboy/cyanotype",
    group: "url",
  },
  {
    id: "npm-package-url",
    old: "npmjs.com/package/@expelledboy/speculum",
    neu: "npmjs.com/package/@expelledboy/cyanotype",
    group: "url",
  },

  // env (before brand-upper / BRT bare)
  {
    id: "env-brt-alias",
    old: "BRT_SPECULUM_ADAPTER",
    neu: "BRT_CYANOTYPE_ADAPTER",
    group: "env",
  },
  {
    id: "env-compose-project",
    old: "SPECULUM_COMPOSE_PROJECT",
    neu: "CYANOTYPE_COMPOSE_PROJECT",
    group: "env",
  },
  {
    id: "env-k8s-namespace",
    old: "SPECULUM_K8S_NAMESPACE",
    neu: "CYANOTYPE_K8S_NAMESPACE",
    group: "env",
  },
  {
    id: "env-k8s-context",
    old: "SPECULUM_K8S_CONTEXT",
    neu: "CYANOTYPE_K8S_CONTEXT",
    group: "env",
  },
  {
    id: "env-k8s-mode",
    old: "SPECULUM_K8S_MODE",
    neu: "CYANOTYPE_K8S_MODE",
    group: "env",
  },
  {
    id: "env-state-dir",
    old: "SPECULUM_STATE_DIR",
    neu: "CYANOTYPE_STATE_DIR",
    group: "env",
  },
  {
    id: "env-observer",
    old: "SPECULUM_OBSERVER",
    neu: "CYANOTYPE_OBSERVER",
    group: "env",
  },
  {
    id: "env-adapter",
    old: "SPECULUM_ADAPTER",
    neu: "CYANOTYPE_ADAPTER",
    group: "env",
  },
  {
    id: "env-historic-marker",
    old: "SPECULUM_HISTORIC_MARKER",
    neu: "CYANOTYPE_HISTORIC_MARKER",
    group: "env",
  },

  // error-kind
  {
    id: "err-missing-label",
    old: "missing_speculum_label",
    neu: "missing_cyanotype_label",
    group: "error-kind",
  },

  // labels (dotted before bare)
  {
    id: "label-component",
    old: "speculum.component",
    neu: "cyanotype.component",
    group: "label",
  },
  {
    id: "label-instance",
    old: "speculum.instance",
    neu: "cyanotype.instance",
    group: "label",
  },
  {
    id: "label-session",
    old: "speculum.session",
    neu: "cyanotype.session",
    group: "label",
  },
  {
    id: "label-podname",
    old: "speculum.podname",
    neu: "cyanotype.podname",
    group: "label",
  },
  {
    id: "label-deployment",
    old: "speculum.deployment",
    neu: "cyanotype.deployment",
    group: "label",
  },
  {
    id: "label-env",
    old: "speculum.env",
    neu: "cyanotype.env",
    group: "label",
  },
  {
    id: "label-equals-one",
    old: "speculum=1",
    neu: "cyanotype=1",
    group: "label",
  },
  {
    id: "label-quoted-key",
    old: 'labels["speculum"]',
    neu: 'labels["cyanotype"]',
    group: "label",
  },
  {
    id: "label-colon-one",
    old: 'speculum: "1"',
    neu: 'cyanotype: "1"',
    group: "label",
  },

  // path / runtime dirs / namespaces
  {
    id: "state-dir-env",
    old: ".speculum-env",
    neu: ".cyanotype-env",
    group: "path",
  },
  {
    id: "state-dir-state",
    old: ".speculum-state",
    neu: ".cyanotype-state",
    group: "path",
  },
  {
    id: "mount-prefix",
    old: "speculum-mounts",
    neu: "cyanotype-mounts",
    group: "path",
  },
  {
    id: "etc-mount",
    old: "/etc/speculum",
    neu: "/etc/cyanotype",
    group: "path",
  },
  {
    id: "compose-project-petstore",
    old: "speculum-petstore-attach",
    neu: "cyanotype-petstore-attach",
    group: "path",
  },
  {
    id: "ns-default",
    old: "speculum-tests",
    neu: "cyanotype-tests",
    group: "path",
  },
  {
    id: "ns-attach-tests",
    old: "speculum-attach-tests",
    neu: "cyanotype-attach-tests",
    group: "path",
  },
  {
    id: "rbac-deploy",
    old: "speculum-deploy",
    neu: "cyanotype-deploy",
    group: "path",
  },
  {
    id: "rbac-attach",
    old: "speculum-attach",
    neu: "cyanotype-attach",
    group: "path",
  },
  {
    id: "pod-name-prefix",
    old: "speculum-",
    neu: "cyanotype-",
    group: "path",
  },

  // image
  {
    id: "img-petstore-sla",
    old: "speculum/petstore-sla",
    neu: "cyanotype/petstore-sla",
    group: "image",
  },
  {
    id: "img-petstore",
    old: "speculum/petstore",
    neu: "cyanotype/petstore",
    group: "image",
  },
  {
    id: "img-redis",
    old: "speculum/redis-configurable",
    neu: "cyanotype/redis-configurable",
    group: "image",
  },
  {
    id: "img-health-example",
    old: "speculum-health-example",
    neu: "cyanotype-health-example",
    group: "image",
  },
  {
    id: "img-ns-prefix",
    old: "speculum/",
    neu: "cyanotype/",
    group: "image",
  },

  // consumer-fixture
  {
    id: "fixture-stack-yaml",
    old: "mc-topology-b-six-leg-speculum",
    neu: "mc-topology-b-six-leg-cyanotype",
    group: "consumer-fixture",
  },
  {
    id: "fixture-stack-yaml-short",
    old: "mc-topology-b-speculum",
    neu: "mc-topology-b-cyanotype",
    group: "consumer-fixture",
  },
  {
    id: "fn-get-adapter",
    old: "getSpeculumAdapter",
    neu: "getCyanotypeAdapter",
    group: "consumer-fixture",
  },
  {
    id: "doc-speculum-for-brt",
    old: "speculum-for-brt",
    neu: "cyanotype-for-brt",
    group: "consumer-fixture",
  },
  {
    id: "doc-speculum-lab",
    old: "speculum-lab",
    neu: "cyanotype-lab",
    group: "consumer-fixture",
  },
  {
    id: "derive-speculum-script",
    old: "derive-speculum",
    neu: "derive-cyanotype",
    group: "consumer-fixture",
  },
  {
    id: "adr-speculum",
    old: "adr-speculum",
    neu: "adr-cyanotype",
    group: "consumer-fixture",
  },
  {
    id: "fixture-speculum-yaml",
    old: "speculum.yaml",
    neu: "cyanotype.yaml",
    group: "consumer-fixture",
  },
  {
    id: "hello-speculum",
    old: "hello-speculum",
    neu: "hello-cyanotype",
    group: "consumer-fixture",
  },

  // cli
  {
    id: "cli-prefix-bracket",
    old: "[speculum]",
    neu: "[cyanotype]",
    group: "cli",
  },
  {
    id: "cli-bin-json",
    old: '"speculum": "./dist/cli/index.js"',
    neu: '"cyanotype": "./dist/cli/index.js"',
    group: "cli",
  },
  {
    id: "cli-bunx-scoped",
    old: "bunx @expelledboy/speculum",
    neu: "bunx @expelledboy/cyanotype",
    group: "cli",
  },
  {
    id: "cli-argv-token",
    old: "speculum derive",
    neu: "cyanotype derive",
    group: "cli",
  },

  // brand (title / upper before lower catch-all)
  {
    id: "brand-title",
    old: "Speculum",
    neu: "Cyanotype",
    group: "brand",
  },
  {
    id: "brand-upper",
    old: "SPECULUM",
    neu: "CYANOTYPE",
    group: "brand",
  },
  {
    id: "brand-lower",
    old: "speculum",
    neu: "cyanotype",
    group: "brand",
  },
];

const RESIDUAL = "speculum";

export type PatternMatchCounts = {
  residual: number;
  byPatternOld: Record<string, number>;
  byPatternNew: Record<string, number>;
  byGroupOld: Record<string, number>;
  byGroupNew: Record<string, number>;
  totalOldPatternHits: number;
  totalNewPatternHits: number;
};

function indexOfNeedle(
  haystack: string,
  needle: string,
  from: number,
  caseSensitive: boolean,
): number {
  if (caseSensitive) return haystack.indexOf(needle, from);
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/** Non-overlapping residual hits of case-insensitive "speculum". */
export function countResidual(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  let pos = 0;
  while (pos < lower.length) {
    const i = lower.indexOf(RESIDUAL, pos);
    if (i === -1) break;
    count++;
    pos = i + RESIDUAL.length;
  }
  return count;
}

export type ResidualSample = {
  line: number;
  col: number;
  snippet: string;
};

export function residualSamples(text: string, limit: number): ResidualSample[] {
  if (limit <= 0) return [];
  const out: ResidualSample[] = [];
  const lower = text.toLowerCase();
  let pos = 0;
  while (pos < lower.length && out.length < limit) {
    const i = lower.indexOf(RESIDUAL, pos);
    if (i === -1) break;
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    const lastNl = before.lastIndexOf("\n");
    const col = i - (lastNl === -1 ? 0 : lastNl + 1) + 1;
    const lineStart = lastNl === -1 ? 0 : lastNl + 1;
    const lineEnd = text.indexOf("\n", i);
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
    out.push({
      line,
      col,
      snippet: lineText.length > 120 ? `${lineText.slice(0, 117)}...` : lineText,
    });
    pos = i + RESIDUAL.length;
  }
  return out;
}

type Needle = { id: string; needle: string; group: PatternGroup; caseSensitive: boolean };

function longestFirstCount(text: string, needles: Needle[]): Map<string, number> {
  const sorted = [...needles].sort((a, b) => {
    const d = b.needle.length - a.needle.length;
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  });
  const counts = new Map<string, number>();
  let cursor = 0;
  while (cursor < text.length) {
    let bestIdx = Infinity;
    let best: Needle | null = null;
    for (const n of sorted) {
      const found = indexOfNeedle(text, n.needle, cursor, n.caseSensitive);
      if (found === -1) continue;
      if (
        found < bestIdx ||
        (found === bestIdx && best !== null && n.needle.length > best.needle.length) ||
        (found === bestIdx && best !== null && n.needle.length === best.needle.length && n.id < best.id) ||
        (found === bestIdx && best === null)
      ) {
        bestIdx = found;
        best = n;
      }
    }
    if (!best) break;
    counts.set(best.id, (counts.get(best.id) ?? 0) + 1);
    cursor = bestIdx + best.needle.length;
  }
  return counts;
}

function emptyGroupCounts(): Record<string, number> {
  const g: Record<string, number> = {};
  for (const p of patterns) g[p.group] = 0;
  return g;
}

/** Longest-first old-token and new-token counts + residual substring count. */
export function matchContent(text: string): PatternMatchCounts {
  const oldNeedles: Needle[] = patterns.map((p) => ({
    id: p.id,
    needle: p.old,
    group: p.group,
    caseSensitive: p.caseSensitive !== false,
  }));
  const newNeedles: Needle[] = patterns.map((p) => ({
    id: p.id,
    needle: p.neu,
    group: p.group,
    caseSensitive: p.caseSensitive !== false,
  }));

  const oldCounts = longestFirstCount(text, oldNeedles);
  const newCounts = longestFirstCount(text, newNeedles);

  const byPatternOld: Record<string, number> = {};
  const byPatternNew: Record<string, number> = {};
  const byGroupOld = emptyGroupCounts();
  const byGroupNew = emptyGroupCounts();
  let totalOldPatternHits = 0;
  let totalNewPatternHits = 0;

  for (const p of patterns) {
    const o = oldCounts.get(p.id) ?? 0;
    const n = newCounts.get(p.id) ?? 0;
    byPatternOld[p.id] = o;
    byPatternNew[p.id] = n;
    byGroupOld[p.group] = (byGroupOld[p.group] ?? 0) + o;
    byGroupNew[p.group] = (byGroupNew[p.group] ?? 0) + n;
    totalOldPatternHits += o;
    totalNewPatternHits += n;
  }

  return {
    residual: countResidual(text),
    byPatternOld,
    byPatternNew,
    byGroupOld,
    byGroupNew,
    totalOldPatternHits,
    totalNewPatternHits,
  };
}

export const SCRIPT_VERSION = 3;
