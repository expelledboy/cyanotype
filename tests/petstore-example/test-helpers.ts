/**
 * Load-generation helpers used by the SLA suites. Independent of Cyanotype;
 * a real consumer would write their own, or use `autocannon` / `k6`.
 */

export type RequestResult = { status: number; latencyMs: number };
export type LoadStats     = { total: number; success: number; p95: number; avg: number };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until truthy or `timeoutMs` elapses.
 *
 * On timeout the thrown object carries the TRAJECTORY, not just the last error:
 * how many attempts were made, how long it ran, and a sample of what the
 * predicate actually observed over time. Without that, a timeout cannot
 * distinguish "never came close" from "recovering, just not fast enough" —
 * which is the difference between a broken component and a budget set too
 * tight, and it is not recoverable after the fact from a one-line failure.
 */
export const waitFor = async <T>(
  predicate: () => Promise<T> | T,
  opts: { timeoutMs: number; intervalMs?: number; description?: string },
): Promise<T> => {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const interval = opts.intervalMs ?? 50;
  const samples: string[] = [];
  let attempts = 0;
  let lastError: unknown;

  const note = (outcome: string): void => {
    const line = `+${Date.now() - started}ms ${outcome}`;
    samples.push(line);
    // Keep the first few and the last few: the shape of the trajectory is in
    // the ends, and an unbounded list would bury it.
    if (samples.length > 12) samples.splice(4, 1);
  };

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const result = await predicate();
      if (result) return result;
      note("falsy");
    } catch (e) {
      lastError = e;
      const kind = (e as { kind?: string; status?: number })?.kind
        ?? (e as { status?: number })?.status
        ?? String(e).slice(0, 60);
      note(`threw ${String(kind)}`);
    }
    await sleep(interval);
  }
  throw {
    kind: "wait_for_timeout",
    description: opts.description ?? "predicate did not become truthy",
    timeoutMs: opts.timeoutMs,
    elapsedMs: Date.now() - started,
    attempts,
    samples,
    lastError,
  };
};

export const summarise = (results: readonly RequestResult[]): LoadStats => {
  const total   = results.length;
  const success = results.filter((r) => r.status >= 200 && r.status < 400).length;
  const sorted  = [...results].map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95     = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
  const avg     = Math.round(sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length));
  return { total, success, p95, avg };
};
