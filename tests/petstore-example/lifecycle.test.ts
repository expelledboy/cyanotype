/**
 * Lifecycle — demonstrates F1 (test owns lifecycle), F5 (runtime invisible),
 * F6 (typed multi-instance paths).
 *
 * No `docker-compose up` step. The test code itself brings the environment
 * up via `shared.ensure(...)` and reads the resolved interfaces.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { Runtime } from "../../src/index";
import { shared } from "./harness";
import type { PetstoreSlaEnv } from "./env";

describe("petstore-sla / lifecycle", () => {
  let runtime: Runtime<PetstoreSlaEnv>;

  beforeAll(async () => { runtime = await shared.ensure("petstore-sla"); }, 120_000);

  test("all components expose resolved interfaces (F1, F5)", () => {
    expect(runtime.nginx.interface.http.uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(runtime.redis.primary.interface.redis.uri).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
  });

  test("multi-instance paths are typed and individually addressable (F6)", () => {
    for (const inst of [runtime.petstore.one, runtime.petstore.two, runtime.petstore.three]) {
      expect(inst.interface.http.uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    }
    // Compile-time guard: instance keys are the literal record keys, not `string`.
    // @ts-expect-error — "four" is not a declared petstore instance.
    void runtime.petstore.four;
  });
});
