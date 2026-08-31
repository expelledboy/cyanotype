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
/**
 * A route is the intersection of three independent axes. Each axis is a union,
 * so a schema can only be declared where the client actually reads or sends the
 * thing it describes. The rule being enforced: a declared schema that no code
 * path can reach is a contract with no executor, and should not compile.
 */
export type HttpRoute = RoutePath & RouteRequest & RouteResponse;

type RoutePath = {
  /** Static string, or a function whose arity becomes the client method's path args. */
  readonly path: string | ((...args: never[]) => string);
};

/** Only body-bearing methods can declare a request schema. */
type RouteRequest =
  | { readonly method: "POST" | "PUT" | "PATCH"; readonly request?: z.ZodTypeAny }
  | { readonly method: "GET" | "DELETE"; readonly request?: never };

/**
 * `responseMode` decides which response schemas are reachable:
 *   - "json" (default): the body is parsed, so both schemas apply.
 *   - "raw": the Response is handed back unparsed on success, so `response`
 *     is unreachable — but a non-2xx still throws, so `errorResponse` applies.
 *   - "status": only the status code is returned and nothing is ever parsed,
 *     so neither applies.
 *
 * `errorResponse` validates the body of a non-2xx response. A body that does
 * not conform keeps its raw value and reports `errorSchemaIssues` rather than
 * being silently reshaped.
 */
type RouteResponse =
  | {
      readonly responseMode?: "json";
      readonly response?: z.ZodTypeAny;
      readonly errorResponse?: z.ZodTypeAny;
    }
  | {
      readonly responseMode: "raw";
      readonly response?: never;
      readonly errorResponse?: z.ZodTypeAny;
    }
  | {
      readonly responseMode: "status";
      readonly response?: never;
      readonly errorResponse?: never;
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

/**
 * Build the thrown `http_error`. Success bodies are Zod-checked; without this
 * the error body was the one part of the contract that crossed the boundary
 * unvalidated. A body that fails its declared schema keeps the raw value and
 * reports the issues — the error is never reshaped into a lie.
 */
export type HttpErrorShape = {
  readonly kind: "http_error";
  readonly status: number;
  readonly body: unknown;
  readonly route: string;
  /** Present only when `errorResponse` was declared and the body failed it. */
  readonly errorSchemaIssues?: z.ZodIssue[];
};

const httpError = (
  route: HttpRoute,
  name: string,
  status: number,
  raw: unknown,
): HttpErrorShape => {
  if (!route.errorResponse) return { kind: "http_error", status, body: raw, route: name };
  const parsed = route.errorResponse.safeParse(raw);
  return parsed.success
    ? { kind: "http_error", status, body: parsed.data, route: name }
    : { kind: "http_error", status, body: raw, route: name, errorSchemaIssues: parsed.error.issues };
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
        throw {
          kind: "fetch_error",
          cause: err,
          route: name,
          hint:
            `The HTTP request for route "${String(name)}" never completed — the component was ` +
            `reachable at readiness but is not now. It may have crashed or been stopped ` +
            `(deliberately, if a chaos test is running), or the request exceeded its timeout. ` +
            `cause carries the underlying network error.`,
        };
      }
      clearTimeout(timer);

      if (mode === "status") return res.status;
      if (mode === "raw") {
        if (!res.ok) {
          throw httpError(route, name, res.status, await parseBodyOrText(res));
        }
        return res;
      }
      if (!res.ok) {
        throw httpError(route, name, res.status, await parseBodyOrText(res));
      }
      const json = await res.json();
      return route.response ? route.response.parse(json) : json;
    };

    return [name, fn] as const;
  });

  return Object.fromEntries(entries) as HttpClient<R>;
};
