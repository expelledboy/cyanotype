import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createHttpClient } from "../../src/protocol";

let server: { stop: () => void; port: number };
let baseUrl: string;

const requests: { method: string; path: string; body: string }[] = [];

beforeAll(() => {
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      requests.push({ method: req.method, path: url.pathname, body });

      if (url.pathname === "/api/pets" && req.method === "GET") {
        return new Response(JSON.stringify([{ id: 1, name: "rex" }]), {
          headers: { "content-type": "application/json", "x-test": "yes" },
        });
      }
      if (url.pathname === "/api/pets" && req.method === "POST") {
        return new Response(JSON.stringify({ id: 42, name: "neo" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/pets/") && req.method === "GET") {
        const id = Number(url.pathname.split("/").pop());
        return new Response(JSON.stringify({ id, name: "byId" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/status") {
        return new Response("teapot", { status: 418 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  server = s as unknown as { stop: () => void; port: number };
  baseUrl = `http://localhost:${s.port}`;
});

afterAll(() => server.stop());

describe("http/createHttpClient", () => {
  test("GET no body returns parsed json", async () => {
    const client = createHttpClient(
      {
        list: { method: "GET", path: "/pets", response: z.array(z.object({ id: z.number(), name: z.string() })) },
      },
      { baseUrl, basePath: "/api" },
    );
    const r = await client.list();
    expect(r).toEqual([{ id: 1, name: "rex" }]);
  });

  test("POST with Zod request validation sends body", async () => {
    const client = createHttpClient(
      {
        create: {
          method: "POST",
          path: "/pets",
          request: z.object({ name: z.string() }),
          response: z.object({ id: z.number(), name: z.string() }),
        },
      },
      { baseUrl, basePath: "/api" },
    );
    const r = await client.create({ name: "neo" });
    expect(r).toEqual({ id: 42, name: "neo" });
    const last = requests[requests.length - 1]!;
    expect(last.body).toBe(JSON.stringify({ name: "neo" }));
    expect(last.method).toBe("POST");
  });

  test("POST Zod validation throws on invalid request", async () => {
    const client = createHttpClient(
      {
        create: {
          method: "POST",
          path: "/pets",
          request: z.object({ name: z.string() }),
        },
      },
      { baseUrl, basePath: "/api" },
    );
    expect(client.create({ name: 5 as unknown as string })).rejects.toBeDefined();
  });

  test("path function with params resolves", async () => {
    const client = createHttpClient(
      {
        getOne: { method: "GET", path: (id: number) => `/pets/${id}` },
      },
      { baseUrl, basePath: "/api" },
    );
    const r = (await client.getOne(7)) as { id: number };
    expect(r.id).toBe(7);
  });

  test("404 throws http_error", async () => {
    const client = createHttpClient(
      { missing: { method: "GET", path: "/nope" } },
      { baseUrl },
    );
    try {
      await client.missing();
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { kind: string; status: number; route: string };
      expect(err.kind).toBe("http_error");
      expect(err.status).toBe(404);
      expect(err.route).toBe("missing");
    }
  });

  test("responseMode=status returns number, no throw on non-2xx", async () => {
    const client = createHttpClient(
      { st: { method: "GET", path: "/api/status", responseMode: "status" } },
      { baseUrl },
    );
    const r = await client.st();
    expect(r).toBe(418);
  });

  test("responseMode=raw returns Response object", async () => {
    const client = createHttpClient(
      { raw: { method: "GET", path: "/pets", responseMode: "raw" } },
      { baseUrl, basePath: "/api" },
    );
    const r = await client.raw();
    expect(r).toBeInstanceOf(Response);
    expect(r.headers.get("x-test")).toBe("yes");
    const body = await r.json();
    expect(body).toEqual([{ id: 1, name: "rex" }]);
  });

  test("response Zod schema parses and validates", async () => {
    const client = createHttpClient(
      {
        list: {
          method: "GET",
          path: "/pets",
          response: z.array(z.object({ id: z.number(), name: z.string() })),
        },
      },
      { baseUrl, basePath: "/api" },
    );
    const r = await client.list();
    expect(Array.isArray(r)).toBe(true);
  });

  test("basePath is prepended", async () => {
    const client = createHttpClient(
      { list: { method: "GET", path: "/pets" } },
      { baseUrl, basePath: "/api" },
    );
    await client.list();
    const last = requests[requests.length - 1]!;
    expect(last.path).toBe("/api/pets");
  });
});
