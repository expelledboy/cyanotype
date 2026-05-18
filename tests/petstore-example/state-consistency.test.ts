/**
 * State consistency — demonstrates F6 (multi-instance composition) by
 * proving that a write through any petstore instance is observable through
 * every other instance, via the shared redis primary.
 *
 * This is the kind of test that justifies addressing instances *by name*:
 * you cannot write the assertion "all three see the same pet" without
 * being able to talk to each of them individually.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { Runtime } from "../../src/index";
import { shared } from "./harness";
import { sleep } from "./test-helpers";
import type { PetstoreSlaEnv } from "./env";

describe("petstore-sla / state consistency across instances", () => {
  let runtime: Runtime<PetstoreSlaEnv>;

  beforeAll(async () => { runtime = await shared.ensure("petstore-sla"); }, 120_000);

  test("a write on `one` is readable on `two` and `three`", async () => {
    const created = await runtime.petstore.one.api.http.createPet({ name: "SharedPet" });

    await sleep(500); // replication slack

    for (const inst of [runtime.petstore.two, runtime.petstore.three] as const) {
      const seen = await inst.api.http.getPet(created.id);
      expect(seen.id).toBe(created.id);
      expect(seen.name).toBe("SharedPet");
    }
  });
});
