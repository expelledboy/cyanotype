/**
 * Protocol — multi-protocol heart.
 *
 * One half of the Blueprint contract (the events catalog in `events.ts` is
 * the other half). A discriminated union. Each case carries its own schema
 * and resolves to a typed client via `ApiOf<P>`. New protocols are new
 * cases here; `ApiOf` learns them. For Opaque (raw socket, opaque DB, etc.)
 * the typed API is `undefined` — tests get host/port from the Interface
 * and bring their own client.
 *
 * The Blueprint declares one or more interfaces, each carrying a Protocol;
 * the same Protocol schemas are honoured whatever Binding (real or simulator)
 * satisfies the Blueprint at runtime.
 *
 * HTTP routes + client derivation are implemented here directly — no
 * external dep. The pattern is small enough to own.
 */

import type { z } from "zod";

// ============================================================
// HTTP
// ============================================================

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One HTTP route in a schema map.
 *
 * `path` can be a string (static) or a function (parameterised by path args).
 * Function arity becomes the path-arg signature on the generated client method.
 *
 * `responseMode`:
 *   - "json" (default): parse + Zod-validate response body
 *   - "status": return only the status code (number)
 *   - "raw": return the Response object untouched
 */
export type HttpRoute = {
  readonly method: HttpMethod;
  readonly path: string | ((...args: never[]) => string);
  readonly request?: z.ZodTypeAny;
  readonly response?: z.ZodTypeAny;
  readonly responseMode?: "json" | "status" | "raw";
};

export type HttpRouteMap = Record<string, HttpRoute>;

/** Derive a typed client from a route map. One method per route. */
export type HttpClient<R extends HttpRouteMap> = {
  readonly [K in keyof R]: HttpClientMethod<R[K]>;
};

type HttpClientMethod<R extends HttpRoute> =
  R extends { path: (...args: infer Args) => string }
    ? HasBody<R> extends true
      ? (...args: [...Args, BodyOf<R>]) => Promise<HttpReturn<R>>
      : (...args: Args) => Promise<HttpReturn<R>>
    : HasBody<R> extends true
      ? (body: BodyOf<R>) => Promise<HttpReturn<R>>
      : () => Promise<HttpReturn<R>>;

type HasBody<R extends HttpRoute> =
  R["method"] extends "POST" | "PUT" | "PATCH"
    ? R["request"] extends z.ZodTypeAny
      ? true
      : false
    : false;

type BodyOf<R extends HttpRoute> =
  R["request"] extends z.ZodType<infer T> ? T : never;

type HttpReturn<R extends HttpRoute> =
  R["responseMode"] extends "status" ? number
  : R["responseMode"] extends "raw" ? Response
  : R["response"] extends z.ZodType<infer T> ? T
  : unknown;

// ============================================================
// Protocol union
// ============================================================

export type Protocol =
  | HttpProtocol<HttpRouteMap>
  | OpaqueProtocol;
  // future: { kind: "openapi"; doc: ... } | { kind: "tcp"; ... } | { kind: "soap"; ... }

export type HttpProtocol<R extends HttpRouteMap = HttpRouteMap> = {
  readonly kind: "http";
  readonly routes: R;
};

export type OpaqueProtocol = {
  readonly kind: "opaque";
};

/**
 * Given a Protocol, derive its typed API.
 * Opaque → `undefined` (no typed client; tests use host/port + their own client).
 */
export type ApiOf<P> =
  P extends HttpProtocol<infer R>
    ? R extends HttpRouteMap ? HttpClient<R> : never
  : P extends OpaqueProtocol ? undefined
  : never;

// ============================================================
// Constructors — identity helpers that exist to drive inference.
// `http(routes)` preserves the specific routes type.
// ============================================================

export const http = <R extends HttpRouteMap>(routes: R): HttpProtocol<R> =>
  ({ kind: "http", routes });

export const opaque = (): OpaqueProtocol =>
  ({ kind: "opaque" });

// ============================================================
// Runtime — builds a typed HTTP client from a route map.
// ============================================================

export type HttpClientOptions = {
  readonly baseUrl: string;
  /** Prepended to every route path. Default "". */
  readonly basePath?: string;
  readonly headers?: Record<string, string>;
  /** Per-request default timeout in ms. */
  readonly timeoutMs?: number;
};

const BODY_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH"]);

const joinBase = (basePath: string, routePath: string): string => {
  const b = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const p = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${b}${p}`;
};

const parseBodyOrText = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const createHttpClient = <R extends HttpRouteMap>(
  routes: R,
  opts: HttpClientOptions,
): HttpClient<R> => {
  const basePath = opts.basePath ?? "";
  const defaultTimeoutMs = opts.timeoutMs ?? 30_000;
  const defaultHeaders = opts.headers ?? {};

  const entries = Object.entries(routes).map(([name, route]) => {
    const method = route.method;
    const hasBody = BODY_METHODS.has(method) && route.request !== undefined;
    const mode = route.responseMode ?? "json";

    const fn = async (...args: unknown[]): Promise<unknown> => {
      let body: unknown;
      let pathArgs = args;
      if (hasBody) {
        body = args[args.length - 1];
        pathArgs = args.slice(0, -1);
        if (route.request) body = route.request.parse(body);
      }

      const routePath =
        typeof route.path === "function"
          ? (route.path as (...a: unknown[]) => string)(...pathArgs)
          : route.path;
      const url = new URL(joinBase(basePath, routePath), opts.baseUrl);

      const headers: Record<string, string> = { ...defaultHeaders };
      const init: RequestInit = { method };
      if (hasBody) {
        headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
        init.body = JSON.stringify(body);
      }
      init.headers = headers;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), defaultTimeoutMs);
      init.signal = controller.signal;

      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        clearTimeout(timer);
        throw { kind: "fetch_error", cause: err, route: name };
      }
      clearTimeout(timer);

      if (mode === "status") return res.status;
      if (mode === "raw") {
        if (!res.ok) {
          const errBody = await parseBodyOrText(res);
          throw { kind: "http_error", status: res.status, body: errBody, route: name };
        }
        return res;
      }
      if (!res.ok) {
        const errBody = await parseBodyOrText(res);
        throw { kind: "http_error", status: res.status, body: errBody, route: name };
      }
      const json = await res.json();
      return route.response ? route.response.parse(json) : json;
    };

    return [name, fn] as const;
  });

  return Object.fromEntries(entries) as HttpClient<R>;
};
