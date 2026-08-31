/**
 * `createEnvironment` boundary checks — consumer misconfiguration, caught at
 * construction with an explanation rather than as a symptom later.
 *
 * These are deliberately NOT runtime invariants. An invariant is an agreement
 * between Cyanotype's own modules and is off in a consumer's run; these are
 * mistakes a consumer makes in their own code and must fail for everyone.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { defineBlueprint, bind, iface, opaque, createEnvironment } from "../../src/index";

const bpWith = (portNames: readonly string[]) =>
  defineBlueprint({
    portNames: portNames as readonly ["http"],
    interface: (_c: Record<string, never>, _e: Record<string, string>, ports) => ({
      http: iface({ uri: `http://127.0.0.1:${ports.http}`, protocol: opaque() }),
    }),
    events: { STARTED: z.object({}) },
  });

const bindWith = (portNames: readonly string[], ports: Record<string, "auto" | number>) =>
  bind(bpWith(portNames), { image: "img", version: "1", config: {}, env: {}, ports });

describe("createEnvironment / declared ports", () => {
  test("accepts a Binding that assigns every declared port", () => {
    expect(() =>
      createEnvironment({ svc: bindWith(["http"], { http: "auto" }) }),
    ).not.toThrow();
  });

  test("rejects a Binding that omits a declared port, naming it", () => {
    let caught: { kind?: string; missing?: string[]; hint?: string } = {};
    try {
      createEnvironment({ svc: bindWith(["http", "admin"], { http: "auto" }) });
    } catch (e) { caught = e as typeof caught; }

    expect(caught.kind).toBe("binding_missing_declared_ports");
    expect(caught.missing).toEqual(["admin"]);
    // The hint must name the fix, not just the fact.
    expect(caught.hint).toContain("admin");
    expect(caught.hint).toContain('admin: "auto"');
  });

  test("names the instance for a multi-instance slot", () => {
    let caught: { kind?: string; instance?: string; hint?: string } = {};
    try {
      createEnvironment({
        cache: {
          primary: bindWith(["http"], { http: "auto" }),
          replica: bindWith(["http", "gossip"], { http: "auto" }),
        },
      });
    } catch (e) { caught = e as typeof caught; }

    expect(caught.kind).toBe("binding_missing_declared_ports");
    expect(caught.instance).toBe("replica");
    expect(caught.hint).toContain("cache.replica");
  });

  test("the reserved-name error explains why the name is reserved", () => {
    let caught: { kind?: string; hint?: string } = {};
    try {
      createEnvironment({ chaos: bindWith(["http"], { http: "auto" }) });
    } catch (e) { caught = e as typeof caught; }

    expect(caught.kind).toBe("reserved_component_name");
    expect(caught.hint).toContain("runtime.chaos");
  });
});
