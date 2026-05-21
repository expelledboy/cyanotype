/**
 * Console reporter — a reference consumer of the observer stream (D-024).
 *
 * `createConsoleReporter()` returns an `Observer` that renders the framework
 * lifecycle as readable lines on stderr (so test stdout stays clean). It is
 * the out-of-the-box answer to "provisioning is slow and silent": pass it as
 * `observer` on `OrchestratorOptions` / `SharedOptions`.
 *
 * Line shape: `speculum  <glyph>  <component>  <message>`. The `speculum`
 * prefix distinguishes harness lines from test-runner output in a CI log;
 * the glyph is a single-width state mark (`✓` done, `✗` failed, `·` info).
 *
 * Image pull progress repaints a single `\r` line on a TTY and is suppressed
 * off a TTY (CI logs stay terse — only `pulling` / `pulled` show). Container
 * create/start sub-steps are intentionally not rendered — they are noise next
 * to the `ready` line that follows.
 */

import type { Observer, ObserverEvent } from "./observer.js";

export type ConsoleReporterOptions = {
  /** Sink for rendered text. Default: `process.stderr.write`. */
  readonly write?: (text: string) => void;
  /** Render per-layer image pull progress. Default: true on a TTY, else false. */
  readonly progress?: boolean;
};

const PREFIX = "speculum";
const DONE = "✓";
const FAIL = "✗";
const INFO = "·";

const fmtMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}s`;
};

const errSummary = (e: unknown): string => {
  if (e && typeof e === "object") {
    const o = e as { kind?: unknown; message?: unknown };
    if (typeof o.kind === "string") return o.kind;
    if (typeof o.message === "string") return o.message.split("\n")[0]!.slice(0, 60);
  }
  return String(e).slice(0, 60);
};

/** Drop the registry/path prefix from an image ref: `a.io/x/y:1` → `…/y:1`. */
const shortImage = (ref: string): string => {
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ref : `…/${ref.slice(slash + 1)}`;
};

const BAR_WIDTH = 12;
const bar = (percent: number): string => {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));
  return `▕${"█".repeat(filled)}${" ".repeat(BAR_WIDTH - filled)}▏`;
};

/**
 * Column label. `environment.component_ready` is component-scoped despite its
 * `environment.` prefix — only the rollup events get the pseudo-label.
 */
const ENV_LEVEL = new Set(["environment.starting", "environment.ready", "environment.failed"]);
const labelFor = (e: ObserverEvent): string => {
  const name = ENV_LEVEL.has(e.type) ? "environment"
    : e.type.startsWith("substrate.") ? "substrate"
    : e.component;
  return (name ?? INFO).padEnd(12);
};

export const createConsoleReporter = (opts: ConsoleReporterOptions = {}): Observer => {
  const isTty = Boolean((process.stderr as { isTTY?: boolean }).isTTY);
  const write = opts.write ?? ((t: string): void => { process.stderr.write(t); });
  const showProgress = opts.progress ?? isTty;

  // Per-component sum of layer current/total bytes, for an aggregate percent.
  const pull = new Map<string, { current: number; total: number }>();
  let progressActive = false;
  let lastPaint = 0;

  const line = (text: string): void => {
    if (progressActive) { write("\n"); progressActive = false; }
    write(`${text}\n`);
  };
  const out = (glyph: string, e: ObserverEvent, msg: string): void =>
    line(`${PREFIX}  ${glyph}  ${labelFor(e)}${msg}`);

  return (e: ObserverEvent): void => {
    switch (e.type) {
      case "environment.starting":
        line("");
        out(INFO, e, `starting · ${e.componentCount} component(s)`);
        break;
      case "substrate.connected":
        out(DONE, e, `connected · ${fmtMs(e.latencyMs)}`);
        break;
      case "substrate.connect_failed":
        out(FAIL, e, `connect failed · ${errSummary(e.error)}`);
        break;
      case "image.cache_hit":
        out(INFO, e, "image cached");
        break;
      case "image.pull_started":
        out(INFO, e, `image pulling · ${shortImage(e.image)}…`);
        break;
      case "image.pull_progress": {
        if (!showProgress || !isTty) break;
        if (e.layerId !== undefined && e.current !== undefined && e.total) {
          pull.set(`${e.component ?? INFO}/${e.layerId}`, { current: e.current, total: e.total });
        }
        const now = Date.now();
        if (now - lastPaint < 100) break;
        lastPaint = now;
        let cur = 0, tot = 0;
        for (const [k, v] of pull) {
          if (k.startsWith(`${e.component ?? INFO}/`)) { cur += v.current; tot += v.total; }
        }
        const percent = tot > 0 ? Math.round((cur / tot) * 100) : (e.percent ?? 0);
        write(`\r${PREFIX}  ${INFO}  ${labelFor(e)}image ${bar(percent)} ${String(percent).padStart(3)}%`);
        progressActive = true;
        break;
      }
      case "image.pulled":
        out(INFO, e, `image pulled · ${fmtMs(e.durationMs)}`);
        break;
      case "image.pull_failed":
        out(FAIL, e, `image pull failed · ${errSummary(e.error)}`);
        break;
      case "probe.started":
        out(INFO, e, `probe running · ${e.probeKind} · ≤${fmtMs(e.timeoutMs)}`);
        break;
      case "probe.attempt":
        out(FAIL, e, `probe attempt ${e.attempt} · ${errSummary(e.error)} · ${fmtMs(e.elapsedMs)}`);
        break;
      case "probe.timed_out":
        out(FAIL, e, `probe timed out · ${e.attempts} attempt(s) · ${fmtMs(e.elapsedMs)}`);
        break;
      case "environment.component_ready":
        out(DONE, e, `ready · ${e.done}/${e.total} · ${fmtMs(e.durationMs)}`);
        break;
      case "environment.ready":
        out(DONE, e, `ready · ${fmtMs(e.durationMs)}`);
        line("");
        break;
      case "environment.failed":
        out(FAIL, e, `failed at ${e.phase} · ${errSummary(e.error)}`);
        line("");
        break;
      case "chaos.stopping":
        out(INFO, e, "chaos stopping…");
        break;
      case "chaos.started":
        out(DONE, e, "chaos restarted");
        break;
      default:
        // substrate.connecting, image.resolving, probe.ready, container.*,
        // chaos.stopped/starting — intentionally not rendered.
        break;
    }
  };
};
