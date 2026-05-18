import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { createEventBus } from "../../src/events";

const catalog = {
  REQUEST: z.object({ path: z.string(), status: z.number() }),
  RESPONSE: z.object({ ms: z.number() }),
  ERROR: z.object({ code: z.string() }),
};

const meta = { component: "petstore" };

describe("events/ingest+collect", () => {
  test("ingests events and collect returns all or filters by name", () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/a", status: 200 } }, meta);
    ingest({ name: "RESPONSE", attributes: { ms: 5 } }, meta);
    ingest({ name: "REQUEST", attributes: { path: "/b", status: 404 } }, meta);
    expect(bus.collect().length).toBe(3);
    expect(bus.collect("REQUEST").length).toBe(2);
    expect(bus.collect("ERROR").length).toBe(0);
  });

  test("drops events with unknown name", () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "UNKNOWN", attributes: {} }, meta);
    expect(bus.collect().length).toBe(0);
  });

  test("drops events that fail schema validation", () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: 1 } }, meta);
    ingest({ name: "REQUEST", attributes: { path: "/ok", status: 200 } }, meta);
    expect(bus.collect().length).toBe(1);
  });

  test("uses provided occurredAt or fills it in", () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest(
      { name: "RESPONSE", attributes: { ms: 1 }, occurredAt: "2026-01-01T00:00:00Z" },
      meta,
    );
    ingest({ name: "RESPONSE", attributes: { ms: 2 } }, meta);
    const all = bus.collect("RESPONSE");
    expect(all[0]!.occurredAt).toBe("2026-01-01T00:00:00Z");
    expect(typeof all[1]!.occurredAt).toBe("string");
  });

  test("preserves component and optional instance", () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "RESPONSE", attributes: { ms: 1 } }, { component: "x", instance: "one" });
    ingest({ name: "RESPONSE", attributes: { ms: 2 } }, { component: "x" });
    const all = bus.collect("RESPONSE");
    expect(all[0]!.component).toBe("x");
    expect(all[0]!.instance).toBe("one");
    expect(all[1]!.instance).toBeUndefined();
  });
});

describe("events/waitFor", () => {
  test("returns an already-present matching event", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "RESPONSE", attributes: { ms: 7 } }, meta);
    const evt = await bus.waitFor("RESPONSE");
    expect(evt.attributes.ms).toBe(7);
  });

  test("waits for an event to arrive", async () => {
    const { bus, ingest } = createEventBus(catalog);
    setTimeout(() => ingest({ name: "RESPONSE", attributes: { ms: 9 } }, meta), 150);
    const evt = await bus.waitFor("RESPONSE", undefined, 2000);
    expect(evt.attributes.ms).toBe(9);
  });

  test("times out with wait_for_timeout kind", async () => {
    const { bus } = createEventBus(catalog);
    await expect(bus.waitFor("RESPONSE", undefined, 150)).rejects.toMatchObject({
      kind: "wait_for_timeout",
      eventName: "RESPONSE",
    });
  });

  test("timeout includes recent same-name candidates", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/a", status: 200 } }, meta);
    ingest({ name: "REQUEST", attributes: { path: "/b", status: 200 } }, meta);
    try {
      await bus.waitFor("REQUEST", { attributes: { status: 500 } }, 150);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { kind: string }).kind).toBe("wait_for_timeout");
      expect((e as { candidates: unknown[] }).candidates.length).toBe(2);
    }
  });

  test("attribute filter matches exact value", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/a", status: 200 } }, meta);
    ingest({ name: "REQUEST", attributes: { path: "/b", status: 404 } }, meta);
    const evt = await bus.waitFor("REQUEST", { attributes: { status: 404 } });
    expect(evt.attributes.path).toBe("/b");
  });

  test("instance filter matches", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "RESPONSE", attributes: { ms: 1 } }, { component: "x", instance: "one" });
    ingest({ name: "RESPONSE", attributes: { ms: 2 } }, { component: "x", instance: "two" });
    const evt = await bus.waitFor("RESPONSE", { instance: "two" });
    expect(evt.attributes.ms).toBe(2);
  });

  test("function-valued filter is invoked with the actual value", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/a", status: 200 } }, meta);
    ingest({ name: "REQUEST", attributes: { path: "/b", status: 503 } }, meta);
    const evt = await bus.waitFor("REQUEST", {
      attributes: { status: ((v: unknown) => typeof v === "number" && v >= 500) as unknown as number },
    });
    expect(evt.attributes.status).toBe(503);
  });

  test("RegExp filter tests against String(value)", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/users/42", status: 200 } }, meta);
    const evt = await bus.waitFor("REQUEST", {
      attributes: { path: /^\/users\/\d+$/ as unknown as string },
    });
    expect(evt.attributes.path).toBe("/users/42");
  });
});

describe("events/expectSequence", () => {
  test("returns events in correct order when all present", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/", status: 200 } }, meta);
    ingest({ name: "RESPONSE", attributes: { ms: 3 } }, meta);
    const seq = await bus.expectSequence(["REQUEST", "RESPONSE"]);
    expect(seq.length).toBe(2);
    expect(seq[0]!.name).toBe("REQUEST");
    expect(seq[1]!.name).toBe("RESPONSE");
  });

  test("waits for arriving events to complete sequence", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "REQUEST", attributes: { path: "/", status: 200 } }, meta);
    setTimeout(() => ingest({ name: "RESPONSE", attributes: { ms: 1 } }, meta), 150);
    const seq = await bus.expectSequence(["REQUEST", "RESPONSE"], 2000);
    expect(seq.map((e) => e.name)).toEqual(["REQUEST", "RESPONSE"]);
  });

  test("times out if order wrong", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "RESPONSE", attributes: { ms: 1 } }, meta);
    ingest({ name: "REQUEST", attributes: { path: "/", status: 200 } }, meta);
    await expect(
      bus.expectSequence(["REQUEST", "RESPONSE"], 150),
    ).rejects.toMatchObject({ kind: "sequence_timeout" });
  });

  test("timeout reports the names seen in order", async () => {
    const { bus, ingest } = createEventBus(catalog);
    ingest({ name: "RESPONSE", attributes: { ms: 1 } }, meta);
    try {
      await bus.expectSequence(["REQUEST", "RESPONSE"], 150);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { seen: string[] }).seen).toEqual(["RESPONSE"]);
    }
  });
});

describe("events/clear", () => {
  test("drains the buffer", () => {
    const { bus, ingest, clear } = createEventBus(catalog);
    ingest({ name: "RESPONSE", attributes: { ms: 1 } }, meta);
    ingest({ name: "RESPONSE", attributes: { ms: 2 } }, meta);
    expect(bus.collect().length).toBe(2);
    clear();
    expect(bus.collect().length).toBe(0);
  });
});
