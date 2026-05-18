/**
 * Resilience — tests that own container lifecycle.
 *
 *   1. Stop one petstore mid-test; nginx keeps serving via the others.
 *   2. Stop redis primary; reads survive (replica), writes fail fast (503).
 *   3. Stop redis replica; reads still survive via primary.
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import type { Runtime } from "../../src/index";
import { shared } from "./harness";
import { summarise, waitFor } from "./test-helpers";
import type { PetstoreSlaEnv } from "./env";

describe("petstore-sla / resilience under chaos", () => {
  let runtime: Runtime<PetstoreSlaEnv>;

  beforeAll(async () => { runtime = await shared.ensure("petstore-sla"); }, 120_000);

  afterEach(async () => {
    await runtime.chaos.start("petstore", "two").catch(() => {});
    await runtime.chaos.start("redis", "primary").catch(() => {});
    await runtime.chaos.start("redis", "replica").catch(() => {});
  });

  test("nginx keeps serving when one petstore is stopped", async () => {
    await runtime.chaos.stop("petstore", "two");

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        runtime.nginx.api.http.listPets()
          .then(() => ({ status: 200, latencyMs: 0 }))
          .catch(() => ({ status: 503, latencyMs: 0 })),
      ),
    );
    const stats = summarise(results);
    expect(stats.success / stats.total).toBeGreaterThanOrEqual(0.8);
  });

  test("reads survive a redis primary outage; writes fail fast", async () => {
    await runtime.chaos.stop("redis", "primary");

    await waitFor(
      async () => {
        try {
          await runtime.nginx.api.http.createPet({ name: "probe" });
          return false;
        } catch (e) {
          return (e as { status?: number }).status === 503;
        }
      },
      { timeoutMs: 5_000, intervalMs: 100, description: "primary-down to surface as 503" },
    );

    const list = await runtime.nginx.api.http.listPets();
    expect(Array.isArray(list)).toBe(true);

    await expect(
      runtime.nginx.api.http.createPet({ name: "ShouldFail" }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test("reads survive a redis replica outage", async () => {
    await runtime.chaos.stop("redis", "replica");

    const list = await waitFor(
      async () => {
        try {
          const r = await runtime.nginx.api.http.listPets();
          return Array.isArray(r) ? r : false;
        } catch {
          return false;
        }
      },
      { timeoutMs: 5_000, intervalMs: 100, description: "reads to survive replica outage" },
    );
    expect(Array.isArray(list)).toBe(true);
  });

  test("chaos.stop is type-safe", () => {
    const _typeguard = () => {
      // @ts-expect-error — multi-instance slot; instance is required
      void runtime.chaos.stop("redis");
      // @ts-expect-error — "tertiary" is not a declared redis instance
      void runtime.chaos.stop("redis", "tertiary");
      // @ts-expect-error — "typo" is not a declared component
      void runtime.chaos.stop("typo");
    };
    expect(typeof _typeguard).toBe("function");
  });
});
