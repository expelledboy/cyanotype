/**
 * A REFUSED chaos stop must leave the component intact.
 *
 * `chaosStop` aborted the component's log-stream signal before calling
 * `adapter.stop()`. When the stop throws — and D-034 made
 * `chaos_unsupported_in_attach_mode` a loud throw on purpose — the container
 * keeps running, the status correctly stays `running`, and the error correctly
 * reaches the caller. But the stream was already closed, and only a successful
 * `chaos.start` re-arms it. Nobody calls start after a stop that was refused,
 * so the component ran on with a permanently dead event bus and every later
 * `waitFor` timed out pointing at the component instead of at the refusal.
 *
 * The assertion is that events still arrive AFTER the refusal. Checking only
 * that the error propagates cannot distinguish a live stream from a dead one.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  defineBlueprint, bind, iface, opaque,
  type Adapter, type Environment, type StartSpec, type Started,
  type EventCatalog, type LogParser,
} from "../../src/index";
import { startEnvironment } from "../../src/orchestrator";

const events = { LINE: z.object({ n: z.number() }) } as const satisfies EventCatalog;

const logParser: LogParser = (line) => {
  const t = line.trim();
  if (!t.startsWith("n=")) return null;
  return { name: "LINE", attributes: { n: Number(t.slice(2)) } };
};

const blueprint = defineBlueprint({
  portNames: ["tcp"] as const,
  interface: (_c: Record<string, never>, _e: Record<string, string>, ports) => ({
    tcp: iface({ uri: `tcp://127.0.0.1:${ports.tcp}`, protocol: opaque() }),
  }),
  events,
});

const binding = bind(blueprint, {
  image: "stub/svc:v1", version: "v1", config: {}, env: {}, ports: { tcp: "auto" }, logParser,
});
const env: Environment = { svc: binding };

/** A stub whose `stop` refuses, exactly as an attach-mode adapter does. */
const refusingAdapter = (queue: string[]): Adapter => ({
  name: "stub",
  connect: async () => { /* noop */ },
  disconnect: async () => { /* noop */ },
  teardown: async () => { /* noop */ },
  start: async (spec: StartSpec): Promise<Started> => ({
    containerId: "c1",
    ports: Object.fromEntries(Object.keys(spec.ports).map((n) => [n, 45000])),
    owned: true,
  }),
  stop: async () => { throw { kind: "chaos_unsupported_in_attach_mode", containerId: "c1" }; },
  logs: async function* (_id: string, signal?: AbortSignal) {
    while (signal?.aborted !== true) {
      const next = queue.shift();
      if (next !== undefined) { yield next; continue; }
      await new Promise((r) => setTimeout(r, 5));
    }
  },
  exists: async () => true,
});

describe("chaos/a refused stop leaves the component usable", () => {
  test("events still arrive after adapter.stop throws", async () => {
    const queue: string[] = [];
    const rt = await startEnvironment(env, {
      adapter: refusingAdapter(queue), sessionId: "s0", envKey: "e0",
    });
    const svc = rt.svc as unknown as { events: { waitFor: (n: "LINE", f?: unknown, t?: number) => Promise<unknown> } };

    // Prove the stream is live before the refusal, so a failure afterwards
    // cannot be blamed on the stream never having worked.
    const before = svc.events.waitFor("LINE", undefined, 2000);
    queue.push("n=1");
    await before;

    let refused: unknown;
    // `Environment` erases the literal type, so ChaosArgs cannot narrow here.
    const chaos = rt.chaos as unknown as { stop: (n: string) => Promise<void> };
    try { await chaos.stop("svc"); } catch (e) { refused = e; }
    expect((refused as { kind: string }).kind).toBe("chaos_unsupported_in_attach_mode");

    // The container was never stopped, so its stream must still be running.
    const after = svc.events.waitFor("LINE", undefined, 2000);
    queue.push("n=2");
    await after;

    await rt.stop();
  }, 15_000);
});
