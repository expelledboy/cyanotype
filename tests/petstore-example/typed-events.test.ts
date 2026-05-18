/**
 * Typed events — demonstrates F4 (typed event catalogs from logs).
 *
 * The petstore service declares an `EventCatalog` and a `LogParser`. The
 * harness streams stdout, parses each line, and routes parsed events to
 * the per-component bus. Tests assert on event *attributes*, not raw log
 * substrings — so changing a log format that still emits the same fields
 * does not break tests, and changing the fields *does* (compile-error).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { Runtime } from "../../src/index";
import { shared } from "./harness";
import type { PetstoreSlaEnv } from "./env";

describe("petstore-sla / typed event catalog", () => {
  let runtime: Runtime<PetstoreSlaEnv>;

  beforeAll(async () => { runtime = await shared.ensure("petstore-sla"); }, 120_000);

  test("waitFor matches on typed attributes", async () => {
    const evtPromise = runtime.petstore.one.events!.waitFor(
      "PETSTORE_REQUEST",
      { attributes: { method: "POST", instance: "one" } },
      5_000,
    );

    await runtime.petstore.one.api.http.createPet({ name: "EventDemo" });

    const evt = await evtPromise;
    expect(evt.attributes.method).toBe("POST");
    expect(evt.attributes.status).toBeGreaterThanOrEqual(200);
    expect(evt.attributes.status).toBeLessThan(300);
  });

  test("attribute shape is enforced at compile time", () => {
    // Compile-time only — wrapped to avoid runtime execution.
    const _typeguard = () => {
      // @ts-expect-error — `notARealField` is not in PETSTORE_REQUEST's schema
      void runtime.petstore.one.events!.waitFor("PETSTORE_REQUEST", { attributes: { notARealField: 1 } });
      // @ts-expect-error — event name not in the catalog
      void runtime.petstore.one.events!.waitFor("NOT_AN_EVENT", { attributes: {} });
    };
    expect(typeof _typeguard).toBe("function");
  });
});
