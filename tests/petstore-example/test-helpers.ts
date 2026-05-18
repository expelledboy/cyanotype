/**
 * Load-generation helpers used by the SLA suites. Independent of Speculum;
 * a real consumer would write their own, or use `autocannon` / `k6`.
 */

export type RequestResult = { status: number; latencyMs: number };
export type LoadStats     = { total: number; success: number; p95: number; avg: number };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until truthy or `timeoutMs` elapses. Captured throws surface on timeout. */
export const waitFor = async <T>(
  predicate: () => Promise<T> | T,
  opts: { timeoutMs: number; intervalMs?: number; description?: string },
): Promise<T> => {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 50;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await sleep(interval);
  }
  throw {
    kind: "wait_for_timeout",
    description: opts.description ?? "predicate did not become truthy",
    timeoutMs: opts.timeoutMs,
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
