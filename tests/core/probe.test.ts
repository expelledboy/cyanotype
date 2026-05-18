import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runProbe, type Probe } from "../../src/probe";
import { iface } from "../../src/interface";
import { opaque } from "../../src/protocol";

type Server = ReturnType<typeof Bun.serve>;

const mkIface = (uri: string) => ({ svc: iface({ uri, protocol: opaque() }) });

describe("probe/http", () => {
  let okServer: Server;
  let notFoundServer: Server;
  let errorServer: Server;

  beforeAll(() => {
    okServer = Bun.serve({ port: 0, fetch: () => new Response("ok", { status: 200 }) });
    notFoundServer = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    errorServer = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
  });

  afterAll(() => {
    okServer.stop(true);
    notFoundServer.stop(true);
    errorServer.stop(true);
  });

  test("succeeds immediately on 200", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "http",
      interfaceName: "svc",
      path: "/",
      timeoutMs: 2000,
      intervalMs: 50,
    };
    await runProbe(probe, mkIface(`http://127.0.0.1:${okServer.port}`));
  });

  test("accepts 4xx when statusMax=499", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "http",
      interfaceName: "svc",
      path: "/",
      timeoutMs: 2000,
      intervalMs: 50,
    };
    await runProbe(probe, mkIface(`http://127.0.0.1:${notFoundServer.port}`));
  });

  test("rejects 5xx and times out", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "http",
      interfaceName: "svc",
      path: "/",
      timeoutMs: 300,
      intervalMs: 50,
    };
    try {
      await runProbe(probe, mkIface(`http://127.0.0.1:${errorServer.port}`));
      throw new Error("expected throw");
    } catch (e) {
      const err = e as { kind: string; lastError: unknown; attempts: number };
      expect(err.kind).toBe("probe_timeout");
      expect(err.attempts).toBeGreaterThanOrEqual(1);
      expect(err.lastError).toBeDefined();
    }
  });

  test("times out on connection refused with lastError set", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "http",
      interfaceName: "svc",
      path: "/",
      timeoutMs: 300,
      intervalMs: 50,
    };
    try {
      await runProbe(probe, mkIface("http://127.0.0.1:1"));
      throw new Error("expected throw");
    } catch (e) {
      const err = e as { kind: string; lastError: unknown; attempts: number };
      expect(err.kind).toBe("probe_timeout");
      expect(err.attempts).toBeGreaterThanOrEqual(1);
      expect(err.lastError).toBeDefined();
    }
  });
});

describe("probe/custom", () => {
  test("succeeds when check returns true", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "custom",
      check: async () => true,
      timeoutMs: 1000,
      intervalMs: 50,
    };
    await runProbe(probe, mkIface("http://unused"));
  });

  test("times out when check always returns false", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "custom",
      check: async () => false,
      timeoutMs: 200,
      intervalMs: 50,
    };
    try {
      await runProbe(probe, mkIface("http://unused"));
      throw new Error("expected throw");
    } catch (e) {
      const err = e as { kind: string; attempts: number };
      expect(err.kind).toBe("probe_timeout");
      expect(err.attempts).toBeGreaterThanOrEqual(1);
    }
  });

  test("surfaces last error when check throws", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "custom",
      check: async () => { throw new Error("custom-fail"); },
      timeoutMs: 200,
      intervalMs: 50,
    };
    try {
      await runProbe(probe, mkIface("http://unused"));
      throw new Error("expected throw");
    } catch (e) {
      const err = e as { kind: string; lastError: unknown };
      expect(err.kind).toBe("probe_timeout");
      expect((err.lastError as Error).message).toBe("custom-fail");
    }
  });

  test("respects interval between attempts", async () => {
    const intervalMs = 100;
    const target = 3;
    let calls = 0;
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "custom",
      check: async () => { calls += 1; return calls >= target; },
      timeoutMs: 5000,
      intervalMs,
    };
    const t0 = Date.now();
    await runProbe(probe, mkIface("http://unused"));
    const elapsed = Date.now() - t0;
    const expected = intervalMs * (target - 1);
    expect(elapsed).toBeGreaterThanOrEqual(expected * 0.8);
    expect(elapsed).toBeLessThanOrEqual(expected * 1.8 + 100);
    expect(calls).toBe(target);
  });
});

describe("probe/abort", () => {
  test("aborting mid-poll throws probe_aborted", async () => {
    const probe: Probe<ReturnType<typeof mkIface>> = {
      kind: "custom",
      check: async () => false,
      timeoutMs: 10_000,
      intervalMs: 50,
    };
    const controller = new AbortController();
    const promise = runProbe(probe, mkIface("http://unused"), controller.signal);
    setTimeout(() => controller.abort(), 80);
    try {
      await promise;
      throw new Error("expected throw");
    } catch (e) {
      const err = e as { kind: string };
      expect(err.kind).toBe("probe_aborted");
    }
  });
});
