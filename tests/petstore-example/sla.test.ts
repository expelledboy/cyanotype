/**
 * SLA assertions — availability and tail-latency targets under steady load.
 *
 * Pulls together F1 (we own the topology), F3 (typed calls keep the load
 * loop honest), and F6 (load goes through nginx → 3 instances). The point
 * of this suite is to show that Cyanotype doesn't fight you when you want
 * to write *quantitative* assertions, not just smoke checks.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { Runtime } from "../../src/index";
import { shared } from "./harness";
import { summarise, type RequestResult } from "./test-helpers";
import type { PetstoreSlaEnv } from "./env";

const measure = async (fn: () => Promise<unknown>): Promise<RequestResult> => {
  const start = Date.now();
  try { await fn(); return { status: 200, latencyMs: Date.now() - start }; }
  catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return { status, latencyMs: Date.now() - start };
  }
};

describe("petstore-sla / SLA targets", () => {
  let runtime: Runtime<PetstoreSlaEnv>;

  beforeAll(async () => { runtime = await shared.ensure("petstore-sla"); }, 120_000);

  test("GET /v1/pets — availability ≥ 95%, p95 ≤ 500ms", async () => {
    const results: RequestResult[] = [];
    for (let i = 0; i < 40; i++) results.push(await measure(() => runtime.nginx.api.http.listPets()));

    const stats = summarise(results);
    expect(stats.success / stats.total).toBeGreaterThanOrEqual(0.95);
    expect(stats.p95).toBeLessThanOrEqual(500);
  });

  test("POST /v1/pets — write SLA: availability ≥ 95%, p95 ≤ 800ms", async () => {
    const results: RequestResult[] = [];
    for (let i = 0; i < 20; i++) {
      results.push(await measure(() => runtime.nginx.api.http.createPet({ name: `Sla-${i}` })));
    }

    const stats = summarise(results);
    expect(stats.success / stats.total).toBeGreaterThanOrEqual(0.95);
    expect(stats.p95).toBeLessThanOrEqual(800);
  });
});
