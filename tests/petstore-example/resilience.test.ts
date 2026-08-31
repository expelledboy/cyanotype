/**
 * Resilience — tests that own container lifecycle.
 *
 *   1. Stop one petstore mid-test; nginx keeps serving via the others.
 *   2. Stop redis primary; reads survive (replica), writes fail fast (503).
 *   3. Stop redis replica; reads still survive via primary.
 *
 * WHY these tests carry explicit timeouts.
 *
 * `chaos.start` resolves when the Blueprint's readiness probe passes, which on
 * Kubernetes runs over the test runner's port-forward. The petstores reach
 * Redis over in-cluster Service DNS and re-establish their clients on their own
 * schedule. Measured across instrumented runs, dependents became usable 4303ms,
 * 4356ms and 5338ms after `chaos.start` returned.
 *
 * `bun:test` kills a test at 5000ms unless given a timeout. That default sits
 * inside the measured recovery distribution, so these two tests failed roughly
 * one run in six — reported as "this test timed out after 5000ms", which reads
 * like a hung test rather than a budget a few hundred milliseconds too tight.
 * The per-test timeout is the binding constraint; raising the poll budget alone
 * does nothing, because the runner stops the test first.
 *
 * Two numbers, deliberately ordered. `RECOVERY_BUDGET_MS` bounds how long a
 * poll waits, and the per-test timeout is larger, so a genuine failure surfaces
 * as a `wait_for_timeout` carrying its trajectory rather than as an opaque kill
 * from the runner. Neither bounds correctness: a component that is actually
 * broken never recovers and fails either way. This is the standard Jepsen
 * shape — heal the fault, let the system quiesce, then read.
 */

/** Poll budget: clear of the measured 4.3-5.3s dependent-recovery window. */
const RECOVERY_BUDGET_MS = 20_000;

/** Per-test ceiling. Must exceed RECOVERY_BUDGET_MS — see the note above. */
const CHAOS_TEST_TIMEOUT_MS = 30_000;

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
      { timeoutMs: RECOVERY_BUDGET_MS, intervalMs: 100, description: "primary-down to surface as 503" },
    );

    const list = await runtime.nginx.api.http.listPets();
    expect(Array.isArray(list)).toBe(true);

    await expect(
      runtime.nginx.api.http.createPet({ name: "ShouldFail" }),
    ).rejects.toMatchObject({ status: 503 });
  }, CHAOS_TEST_TIMEOUT_MS);

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
      { timeoutMs: RECOVERY_BUDGET_MS, intervalMs: 100, description: "reads to survive replica outage" },
    );
    expect(Array.isArray(list)).toBe(true);
  }, CHAOS_TEST_TIMEOUT_MS);

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
