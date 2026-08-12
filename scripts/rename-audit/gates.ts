/**
 * Confidence freeze (2026-08-12, revised publish sequence).
 * Residual scan cannot see these. Printed on every audit run.
 *
 * Publish sequence (Approach A — no npm rename exists):
 *   1. Commit Wave-1 source (0 residual in library)
 *   2. Push + `gh repo rename cyanotype`
 *   3. Local `npm publish` bootstrap of @expelledboy/cyanotype@0.5.0 (token/session)
 *   4. Trusted Publisher → expelledboy/cyanotype + release.yml; revoke bootstrap token if used
 *   5. Tag v0.5.0 for OIDC path on subsequent releases (or rely on bootstrap as the 0.5.0 artifact)
 *   6. `npm deprecate @expelledboy/speculum` (do not unpublish 0.4.2)
 *   7. Wave-2 consumer freeze (BRT + crimson + sims)
 *
 * No dual-publish. No stub re-export. No cyanotype@0.4.2. No README-only 0.4.3.
 * JFrog only proxies npm + vuln scan — not a rename gate.
 */
export type OpsGate = {
  id: string;
  /** What must not proceed until this is true */
  blocks: "wave1-merge" | "wave1-publish" | "wave2-freeze";
  kind: "git" | "manual";
  check: string;
};

export const OPS_GATES: OpsGate[] = [
  {
    id: "wave1-atomic-wire",
    blocks: "wave1-merge",
    kind: "git",
    check: "Label writers (orchestrator) + readers (docker/k8s/derive) + fixtures flip in one commit. No dual-read.",
  },
  {
    id: "wave1-changelog-050",
    blocks: "wave1-merge",
    kind: "git",
    check: "CHANGELOG contains ## [0.5.0] and 0 residual brand in the file. Release workflow fails without the section.",
  },
  {
    id: "gh-repo-rename",
    blocks: "wave1-publish",
    kind: "manual",
    check: "Rename GitHub repo expelledboy/speculum → cyanotype BEFORE first Trusted Publisher config (OIDC binds exact owner/repo). `gh repo rename cyanotype`. Update local git remote.",
  },
  {
    id: "npm-bootstrap",
    blocks: "wave1-publish",
    kind: "manual",
    check: "From library root (logged-in npm): bun run build && npm publish --access public. First publish creates @expelledboy/cyanotype@0.5.0. Prefer this as the real 0.5.0 artifact (not a placeholder).",
  },
  {
    id: "trusted-publisher",
    blocks: "wave1-publish",
    kind: "manual",
    check: "After package exists: Trusted Publisher for @expelledboy/cyanotype → repo expelledboy/cyanotype + workflow release.yml. Then OIDC tags work; revoke any bootstrap token.",
  },
  {
    id: "npm-deprecate-old",
    blocks: "wave1-publish",
    kind: "manual",
    check: "npm deprecate '@expelledboy/speculum' 'Renamed to @expelledboy/cyanotype@^0.5.0 (breaking: wire/labels). Do not unpublish 0.4.2.'",
  },
  {
    id: "cluster-3-svc",
    blocks: "wave2-freeze",
    kind: "manual",
    check: "kubectl: exactly 3 Services with cyanotype.component ∈ {networkSimulator, blSimulator, payswitch} on plt-dev AFTER Helm/TF redeploy and BEFORE BRT 0.5.0 attach. crimson run-brt hard-counts 3.",
  },
  {
    id: "brt-pin",
    blocks: "wave2-freeze",
    kind: "manual",
    check: "Align crimson run-brt checkout pin (was v1.1.0) with BRT main (was 1.2.0) in the freeze PR.",
  },
  {
    id: "house-check-fences",
    blocks: "wave2-freeze",
    kind: "git",
    check: "BRT lab-fence requires package string; lib-fence regex; suites-and-seeds env names — same PR as package rename or house-check is red.",
  },
  {
    id: "worktree-hygiene",
    blocks: "wave2-freeze",
    kind: "manual",
    check: "Deploy only from crimson-deploy master. crimson-deploy-* local worktrees are hygiene roots, not ship targets.",
  },
];

export const REQUIRED_POST_ROOTS = [
  "library",
  "brt",
  "crimson-deploy",
  "bl-simulator",
  "network-simulator",
] as const;

export const HYGIENE_ROOTS = [
  "crimson-deploy-brt-slice",
  "crimson-deploy-brt-helm",
  "crimson-deploy-brt-trigger",
  "crimson-deploy-run-brt",
  "crimson-deploy-run-brt-eks",
  "crimson-deploy-run-brt-npm",
] as const;

export function isHygieneRoot(id: string): boolean {
  return (HYGIENE_ROOTS as readonly string[]).includes(id);
}

export function formatOpsGates(): string {
  const lines = [
    "OPS GATES (git scan cannot see these — publish Approach A)",
    "  Residual 0 is necessary, not sufficient.",
    "  Sequence: commit → gh rename → npm publish bootstrap → Trusted Publisher → deprecate old → Wave-2.",
    "  No dual-publish / stub. JFrog proxies npm (not a rename gate).",
  ];
  for (const g of OPS_GATES) {
    lines.push(`  [${g.blocks}] ${g.id} (${g.kind}): ${g.check}`);
  }
  return lines.join("\n");
}
