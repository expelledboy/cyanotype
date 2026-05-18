import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHelpers } from "../../src/helpers";

const requests: { method: string; path: string; body: string }[] = [];
let server: { stop: () => void; port: number };
let baseUrl: string;

beforeAll(() => {
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body =
        req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      requests.push({ method: req.method, path: url.pathname, body });

      if (url.pathname === "/slow") {
        await new Promise((r) => setTimeout(r, 1000));
        return new Response("late");
      }
      if (url.pathname === "/boom") return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ ok: true, echo: body }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  server = s as unknown as { stop: () => void; port: number };
  baseUrl = `http://localhost:${s.port}`;
});

afterAll(() => server.stop());

describe("helpers/http", () => {
  test("get / post / put / patch / del all work", async () => {
    const { http } = createHelpers();
    const g = await http.get(`${baseUrl}/g`);
    expect(g.status).toBe(200);
    const p = await http.post(`${baseUrl}/p`, { a: 1 });
    expect(p.status).toBe(200);
    const pu = await http.put(`${baseUrl}/pu`, { b: 2 });
    expect(pu.status).toBe(200);
    const pa = await http.patch(`${baseUrl}/pa`, { c: 3 });
    expect(pa.status).toBe(200);
    const d = await http.del(`${baseUrl}/d`);
    expect(d.status).toBe(200);
  });

  test("body is JSON-stringified on write methods", async () => {
    const { http } = createHelpers();
    requests.length = 0;
    await http.post(`${baseUrl}/x`, { hello: "world" });
    const last = requests[requests.length - 1]!;
    expect(last.body).toBe(JSON.stringify({ hello: "world" }));
  });

  test("baseUrl joins relative URLs", async () => {
    const { http } = createHelpers();
    requests.length = 0;
    const r = await http.get("/some/path", { baseUrl });
    expect(r.status).toBe(200);
    expect(requests[requests.length - 1]!.path).toBe("/some/path");
  });

  test("non-2xx does NOT throw", async () => {
    const { http } = createHelpers();
    const r = await http.get(`${baseUrl}/boom`);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("nope");
  });

  test("timeout aborts via AbortController", async () => {
    const { http } = createHelpers();
    try {
      await http.get(`${baseUrl}/slow`, { timeoutMs: 50 });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { kind: string };
      expect(err.kind).toBe("fetch_error");
    }
  });

  test("lazy body: json() returns parsed", async () => {
    const { http } = createHelpers();
    const r = await http.get(`${baseUrl}/foo`);
    const j = await r.json<{ ok: boolean }>();
    expect(j.ok).toBe(true);
  });
});
