/**
 * Typed API — demonstrates F3 (typed clients from declared schemas, no
 * codegen). The route map in env.ts is the single source of truth; the
 * client surface is derived. Drift between schema and tests is a compile
 * error, not a runtime surprise.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { Runtime } from "../../src/index";
import { shared } from "./harness";
import type { PetstoreSlaEnv } from "./env";

describe("petstore-sla / typed API contract", () => {
  let runtime: Runtime<PetstoreSlaEnv>;

  beforeAll(async () => { runtime = await shared.ensure("petstore-sla"); }, 120_000);

  test("createPet — request and response are schema-typed", async () => {
    const created = await runtime.petstore.one.api.http.createPet({ name: "Fido" });
    //    ^? { id: string; name: string }
    expect(created.name).toBe("Fido");
    expect(typeof created.id).toBe("string");
  });

  test("getPet — path params are type-checked", async () => {
    const created = await runtime.petstore.one.api.http.createPet({ name: "Lookup" });
    const fetched = await runtime.petstore.one.api.http.getPet(created.id);
    expect(fetched.id).toBe(created.id);
  });

  test("contract drift is caught at compile time", () => {
    const _typeguard = async () => {
      // @ts-expect-error — `name` is required by CreatePetInput
      await runtime.petstore.one.api.http.createPet({});
      // @ts-expect-error — route not in the declared map
      await runtime.petstore.one.api.http.updatePet("abc", { name: "x" });
    };
    expect(typeof _typeguard).toBe("function");
  });

  test("nginx exposes the same contract as upstream (LB type-safe edge)", async () => {
    const viaLb = await runtime.nginx.api.http.listPets();
    expect(Array.isArray(viaLb)).toBe(true);
  });
});
