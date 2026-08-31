import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createHttpClient, type HttpRoute } from "../../src/protocol";

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
      if (url.pathname === "/api/fail") {
        return new Response(JSON.stringify({ code: "bad_input", message: "nope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/fail-offspec") {
        return new Response(JSON.stringify({ unexpected: true }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
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

describe("http/declaration holes", () => {
  const ErrorBody = z.object({ code: z.string(), message: z.string() });

  test("declared errorResponse validates the error body", async () => {
    const client = createHttpClient(
      { boom: { method: "GET", path: "/fail", errorResponse: ErrorBody } },
      { baseUrl, basePath: "/api" },
    );
    let caught: unknown;
    try { await client.boom(); } catch (e) { caught = e; }
    const err = caught as { kind: string; status: number; body: { code: string } };
    expect(err.kind).toBe("http_error");
    expect(err.status).toBe(400);
    expect(err.body.code).toBe("bad_input");
  });

  test("an error body that violates its schema keeps the raw value and reports issues", async () => {
    const client = createHttpClient(
      { boom: { method: "GET", path: "/fail-offspec", errorResponse: ErrorBody } },
      { baseUrl, basePath: "/api" },
    );
    let caught: unknown;
    try { await client.boom(); } catch (e) { caught = e; }
    const err = caught as { body: unknown; errorSchemaIssues?: unknown[] };
    expect(err.body).toEqual({ unexpected: true });
    expect(Array.isArray(err.errorSchemaIssues)).toBe(true);
    expect(err.errorSchemaIssues!.length).toBeGreaterThan(0);
  });

  test("without errorResponse the raw body is carried unchanged", async () => {
    const client = createHttpClient(
      { boom: { method: "GET", path: "/fail" } },
      { baseUrl, basePath: "/api" },
    );
    let caught: unknown;
    try { await client.boom(); } catch (e) { caught = e; }
    const err = caught as { body: unknown; errorSchemaIssues?: unknown };
    expect(err.body).toEqual({ code: "bad_input", message: "nope" });
    expect(err.errorSchemaIssues).toBeUndefined();
  });

  test("a request schema on a bodyless method does not compile", () => {
    const _typeguard = () => {
      createHttpClient(
        {
          // @ts-expect-error — DELETE has no request body; the client could never send this
          drop: { method: "DELETE", path: "/pets/1", request: z.object({ id: z.number() }) },
        },
        { baseUrl },
      );
      // @ts-expect-error — same for GET
      void ({ method: "GET", path: "/pets", request: z.object({ q: z.string() }) } satisfies HttpRoute);
    };
    expect(typeof _typeguard).toBe("function");
  });

  test("a response schema unreachable under its responseMode does not compile", () => {
    const _typeguard = () => {
      // status mode returns the code and never reads a body, so neither schema
      // can be honoured.
      // @ts-expect-error — `response` is unreachable in status mode
      void ({ method: "GET", path: "/x", responseMode: "status", response: ErrorBody } satisfies HttpRoute);
      // @ts-expect-error — `errorResponse` is unreachable in status mode
      void ({ method: "GET", path: "/x", responseMode: "status", errorResponse: ErrorBody } satisfies HttpRoute);
      // raw mode hands back the Response unparsed on success...
      // @ts-expect-error — `response` is unreachable in raw mode
      void ({ method: "GET", path: "/x", responseMode: "raw", response: ErrorBody } satisfies HttpRoute);
      // ...but a non-2xx still throws, so errorResponse IS reachable here.
      void ({ method: "GET", path: "/x", responseMode: "raw", errorResponse: ErrorBody } satisfies HttpRoute);
    };
    expect(typeof _typeguard).toBe("function");
  });

  test("errorResponse is honoured in raw mode", async () => {
    const client = createHttpClient(
      { boom: { method: "GET", path: "/fail", responseMode: "raw", errorResponse: ErrorBody } },
      { baseUrl, basePath: "/api" },
    );
    let caught: unknown;
    try { await client.boom(); } catch (e) { caught = e; }
    const err = caught as { kind: string; body: { code: string } };
    expect(err.kind).toBe("http_error");
    expect(err.body.code).toBe("bad_input");
  });
});

describe("request-construction failures are tagged, not raw", () => {
  // `protocol.ts` built its URL OUTSIDE the try, so a malformed baseUrl threw a
  // raw TypeError with no `kind` — while the identical mistake through
  // `helpers.ts`, which built its URL inside, produced a tagged `fetch_error`.
  // Same library, same misuse, two different failure shapes, and only one of
  // them catchable.
  const routes = { ping: { method: "GET", path: "/", response: z.object({}) } } as const;

  test("a malformed baseUrl yields fetch_error, not a TypeError", async () => {
    const client = createHttpClient(routes as never, { baseUrl: "not-a-url" } as never) as {
      ping: () => Promise<unknown>;
    };
    let caught: unknown;
    try { await client.ping(); } catch (e) { caught = e; }

    expect(caught).toBeDefined();
    expect(caught instanceof Error).toBe(false);
    expect((caught as { kind?: string }).kind).toBe("fetch_error");
    // The hint must say the request was never sent, rather than implicating the
    // target — nothing was contacted.
    expect((caught as { hint?: string }).hint ?? "").toContain("no request was sent");
  });
});
