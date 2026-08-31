/**
 * The invariant mechanism itself.
 *
 * Two properties carry the design and are worth pinning: a violation must be a
 * tagged object (never a class, per CONVENTIONS.md), and when invariants are
 * OFF the `detail` thunk must not run. The second is the whole reason `detail`
 * is a thunk rather than a value — a consumer should not pay to build a
 * diagnostic for a check that is not enabled.
 *
 * `tests/preload.ts` enables invariants for this repository's suite, so these
 * tests restore the enabled state rather than assuming it.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  invariant, enableInvariants, disableInvariants, invariantsEnabled,
} from "../../src/invariants";

describe("invariants", () => {
  afterEach(() => { enableInvariants(); });

  test("the suite runs with invariants enabled", () => {
    expect(invariantsEnabled()).toBe(true);
  });

  test("a held invariant does nothing", () => {
    expect(() => invariant(() => true, "holds")).not.toThrow();
  });

  test("a violated invariant throws a tagged object, not a class", () => {
    let caught: unknown;
    try {
      invariant(() => false, "the stamped label matches the swept label", () => ({ a: 1 }));
    } catch (e) { caught = e; }

    expect(caught).toMatchObject({
      kind: "invariant_violated",
      invariant: "the stamped label matches the swept label",
      detail: { a: 1 },
    });
    expect(caught instanceof Error).toBe(false);
  });

  test("detail is omitted entirely when not supplied", () => {
    let caught: unknown;
    try { invariant(() => false, "no detail"); } catch (e) { caught = e; }
    expect(Object.hasOwn(caught as object, "detail")).toBe(false);
  });

  test("disabled: the CONDITION does not run either", () => {
    // The first version took `held` as a plain boolean, so JavaScript evaluated
    // it at the call site whether or not invariants were on. Consumers paid for
    // every condition, and a condition touching something absent threw
    // `undefined is not an object` — a disabled check crashing a consumer.
    disableInvariants();
    let ran = 0;
    invariant(() => { ran += 1; return true; }, "must not run");
    expect(ran).toBe(0);
  });

  test("disabled: a condition that would throw does not throw", () => {
    disableInvariants();
    const absent = undefined as unknown as Record<string, number>;
    expect(() => invariant(() => absent.http === 1, "would crash")).not.toThrow();
  });

  test("the detail thunk does not run when the invariant holds", () => {
    let built = 0;
    invariant(() => true, "holds", () => { built += 1; return {}; });
    expect(built).toBe(0);
  });

  test("disabled: nothing throws and the detail thunk never runs", () => {
    disableInvariants();
    let built = 0;
    expect(() => invariant(() => false, "violated but disabled", () => { built += 1; return {}; })).not.toThrow();
    expect(built).toBe(0);
    expect(invariantsEnabled()).toBe(false);
  });

  test("enable is idempotent and re-arms after disable", () => {
    disableInvariants();
    enableInvariants();
    enableInvariants();
    expect(() => invariant(() => false, "re-armed")).toThrow();
  });
});
