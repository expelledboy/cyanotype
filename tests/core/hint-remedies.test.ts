/**
 * Remedy proofs: doing what the hint says must actually resolve the error.
 *
 * The claim lint (`hint-claims.test.ts`) proves a hint references real things.
 * That is not the same as the advice working. `stopAll()` exists, and telling
 * someone to use it to clean another process's containers is still a lie.
 *
 * Each test below triggers an error, then performs the remedy its hint names,
 * and asserts the second attempt succeeds. Only errors whose remedy is
 * executable in-process are here — the misuse class, which is where a false
 * hint does most damage because the consumer follows it verbatim. Substrate
 * failures ("check whether the pod is Pending or crash-looping") cannot be
 * proven this way and are reviewed instead, via `just hints`.
 *
 * If a hint changes, the matching test here must change with it. That coupling
 * is the point.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  defineBlueprint, bind, iface, opaque, createEnvironment, createSharedEnvs,
} from "../../src/index";
import { createInMemoryAdapter } from "../../src/adapters/memory";

const IMAGE = "sim";

/** Minimal simulator: the Blueprint here only needs a port to exist. */
const fake = async (): Promise<{ ports: Record<string, number>; close: () => Promise<void> }> => ({
  ports: { http: 0 },
  close: async () => {},
});
const factories = { [IMAGE]: fake };

const bpWith = (portNames: readonly string[]) =>
  defineBlueprint({
    portNames: portNames as readonly ["http"],
    interface: (_c: Record<string, never>, _e: Record<string, string>, ports) => ({
      http: iface({ uri: `http://127.0.0.1:${ports.http}`, protocol: opaque() }),
    }),
    events: { STARTED: z.object({}) },
  });

const bindWith = (portNames: readonly string[], ports: Record<string, "auto" | number>, image = IMAGE) =>
  bind(bpWith(portNames), { image, version: "1", config: {}, env: {}, ports });

// Null-safe: a remedy that throws NOTHING is the best possible outcome, so
// these must describe "no error" rather than crash on it.
const hintOf = (e: unknown): string =>
  (e !== null && typeof e === "object" ? (e as { hint?: string }).hint : undefined) ?? "";
const kindOf = (e: unknown): string =>
  (e !== null && typeof e === "object" ? (e as { kind?: string }).kind : undefined) ?? "<no error>";

const mkShared = (env: ReturnType<typeof createEnvironment>, over: Record<string, unknown> = {}) =>
  createSharedEnvs({ e: env } as never, {
    adapter: createInMemoryAdapter({ factories }),
    stateDir: `/tmp/cy-remedy-${Math.random().toString(36).slice(2, 10)}`,
    mode: "start",
    ...over,
  } as never);

describe("hint remedies actually work", () => {
  test("binding_missing_declared_ports: adding the named port constructs", () => {
    let caught: unknown;
    try { createEnvironment({ svc: bindWith(["http", "admin"], { http: "auto" }) }); }
    catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("binding_missing_declared_ports");
    expect(hintOf(caught)).toContain('admin: "auto"');

    // The remedy, verbatim.
    expect(() =>
      createEnvironment({ svc: bindWith(["http", "admin"], { http: "auto", admin: "auto" }) }),
    ).not.toThrow();
  });

  test("reserved_component_name: renaming the component constructs", () => {
    let caught: unknown;
    try { createEnvironment({ chaos: bindWith(["http"], { http: "auto" }) }); }
    catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("reserved_component_name");
    expect(hintOf(caught)).toContain("Rename the component");

    expect(() => createEnvironment({ chaosMonkey: bindWith(["http"], { http: "auto" }) })).not.toThrow();
  });

  test("image_not_registered: registering that exact image string starts", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }, "not-registered") });
    const shared = createSharedEnvs({ e: env } as never, {
      adapter: createInMemoryAdapter({ factories }),
      stateDir: `/tmp/cy-remedy-${Math.random().toString(36).slice(2, 10)}`,
      mode: "start",
    } as never);
    let caught: unknown;
    try { await shared.ensure("e" as never); } catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("image_not_registered");
    expect(hintOf(caught)).toContain("not-registered");

    // The remedy: a factory under that exact image string.
    const fixed = createSharedEnvs({ e: env } as never, {
      adapter: createInMemoryAdapter({ factories: { ...factories, "not-registered": fake } }),
      stateDir: `/tmp/cy-remedy-${Math.random().toString(36).slice(2, 10)}`,
      mode: "start",
    } as never);
    const rt = await fixed.ensure("e" as never);
    expect(rt).toBeDefined();
    await fixed.stopAll();
  });

  test("unknown_env: the key the hint lists as known does resolve", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }) });
    const shared = mkShared(env);
    let caught: unknown;
    try { await shared.ensure("typo" as never); } catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("unknown_env");
    expect(hintOf(caught)).toContain("e");     // the known key it advertises

    const rt = await shared.ensure("e" as never);
    expect(rt).toBeDefined();
    await shared.stopAll();
  });

  test("use_not_ensured: ensure() first, then use() through the same handle", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }) });
    const shared = mkShared(env);
    let caught: unknown;
    try { shared.use("e" as never); } catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("use_not_ensured");
    expect(hintOf(caught)).toContain("ensure");

    // The remedy, and the scope claim with it: use() works through the handle,
    // which is what the hint says — not "the same file", which it used to say.
    await shared.ensure("e" as never);
    expect(shared.use("e" as never)).toBeDefined();
    await shared.stopAll();
  });

  test("start_metadata_exists: startOrAttach reuses what start refused", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }) });
    const stateDir = `/tmp/cy-remedy-${Math.random().toString(36).slice(2, 10)}`;
    const opts = { adapter: createInMemoryAdapter({ factories }), stateDir };

    const first = createSharedEnvs({ e: env } as never, { ...opts, mode: "start" } as never);
    await first.ensure("e" as never);

    // A second handle in mode "start" refuses, because state already exists.
    const second = createSharedEnvs({ e: env } as never, { ...opts, mode: "start" } as never);
    let caught: unknown;
    try { await second.ensure("e" as never); } catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("start_metadata_exists");
    expect(hintOf(caught)).toContain("startOrAttach");

    // The remedy the hint names. (In-memory containers do not survive the
    // handle, so this asserts the MODE is accepted where "start" was refused —
    // which is the claim the hint makes.)
    const third = createSharedEnvs({ e: env } as never, { ...opts, mode: "startOrAttach" } as never);
    let reattachError: unknown;
    try { await third.ensure("e" as never); } catch (e) { reattachError = e; }
    expect(kindOf(reattachError)).not.toBe("start_metadata_exists");

    await first.stopAll();
  });

  test("attach_no_metadata: starting first makes attach viable", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }) });
    const stateDir = `/tmp/cy-remedy-${Math.random().toString(36).slice(2, 10)}`;
    const opts = { adapter: createInMemoryAdapter({ factories }), stateDir };

    const attacher = createSharedEnvs({ e: env } as never, { ...opts, mode: "attach" } as never);
    let caught: unknown;
    try { await attacher.ensure("e" as never); } catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("attach_no_metadata");
    expect(hintOf(caught)).toContain("startOrAttach");

    // The remedy: start it first. Attach then gets past "no metadata".
    const starter = createSharedEnvs({ e: env } as never, { ...opts, mode: "start" } as never);
    await starter.ensure("e" as never);
    let second: unknown;
    try { await attacher.ensure("e" as never); } catch (e) { second = e; }
    expect(kindOf(second)).not.toBe("attach_no_metadata");

    await starter.stopAll();
  });

  test("component_not_found: the name the hint lists as known does resolve", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }) });
    const shared = mkShared(env);
    const rt = (await shared.ensure("e" as never)) as never as {
      chaos: { stop: (n: string, i?: string) => Promise<void>; start: (n: string) => Promise<void> };
    };
    let caught: unknown;
    try { await rt.chaos.stop("typo"); } catch (e) { caught = e; }
    expect(kindOf(caught)).toBe("component_not_found");
    expect(hintOf(caught)).toContain("svc");   // the known component it advertises
    // The advertised names must be the ADDRESSABLE form. `components.keys()` are
    // internal, colon-joined (`redis:primary`), while composite route keys and
    // derive binding keys are dot-joined — printing the internal form invited
    // copying a key that silently matches nothing.
    const known = (caught as { known?: string[] }).known ?? [];
    expect(known).toEqual(["svc"]);
    expect(known.some((k) => k.includes(":"))).toBe(false);

    await rt.chaos.stop("svc");                 // the advertised name works
    await shared.stopAll();
  });

  test("invalid_chaos: chaos.start after a stop is what the hint implies", async () => {
    const env = createEnvironment({ svc: bindWith(["http"], { http: "auto" }) });
    const shared = mkShared(env);
    const rt = (await shared.ensure("e" as never)) as never as {
      chaos: { stop: (n: string) => Promise<void>; start: (n: string) => Promise<void> };
    };
    let caught: unknown;
    try { await rt.chaos.start("svc"); } catch (e) { caught = e; }   // not stopped yet
    expect(kindOf(caught)).toBe("invalid_chaos");
    expect(hintOf(caught)).toContain("chaos.stop()");

    // The precondition the hint names.
    await rt.chaos.stop("svc");
    await rt.chaos.start("svc");
    await shared.stopAll();
  });
});
