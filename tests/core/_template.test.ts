/**
 * Canonical test shape.
 *
 *   - bun:test imports
 *   - describe("<module>/<concern>")
 *   - test("<expected behavior>")
 *   - one assertion per concept; multiple assertions OK in the same test
 *     if they all describe one behavior
 *   - no shared setup helpers across files; copy if it's small
 */

import { describe, test, expect } from "bun:test";

describe("template/sanity", () => {
  test("bun test is wired", () => {
    expect(1 + 1).toBe(2);
  });
});
