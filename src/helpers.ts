/**
 * HelperContext — what's passed to a Blueprint's custom `api` factory.
 *
 * Pre-built clients keyed by protocol. The user's hand-written api factory
 * uses these to wrap raw HTTP/TCP/etc. into a domain-specific surface
 * (custom serialization, request signing, multi-call helpers, façades).
 *
 * For schema-derived clients (the default path) the user never sees Helpers
 * — the orchestrator auto-generates clients from interfaces. Helpers exists
 * for the override case where the user supplies a custom `api` factory.
 *
 * Each helper takes a baseUrl explicitly per-call so one helper object can
 * serve multiple interfaces in a multi-interface component.
 */

export type HelperContext = {
  readonly http: HttpHelpers;
  // future: tcp: TcpHelpers, soap: SoapHelpers, ...
};

export type HttpRequestInit = {
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: () => Promise<string>;
  readonly json: <T = unknown>() => Promise<T>;
  readonly bytes: () => Promise<Uint8Array>;
};

export type HttpHelpers = {
  get(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
  post(url: string, body?: unknown, init?: HttpRequestInit): Promise<HttpResponse>;
  put(url: string, body?: unknown, init?: HttpRequestInit): Promise<HttpResponse>;
  patch(url: string, body?: unknown, init?: HttpRequestInit): Promise<HttpResponse>;
  del(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
};

// ============================================================
// Runtime — pure wrapper over fetch.
// ============================================================

const resolveUrl = (url: string, baseUrl?: string): string | URL =>
  baseUrl ? new URL(url, baseUrl) : url;

const doFetch = async (
  method: string,
  url: string,
  body: unknown,
  init: HttpRequestInit | undefined,
  hasBody: boolean,
): Promise<HttpResponse> => {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  const reqInit: RequestInit = { method };
  if (hasBody && body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    reqInit.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  reqInit.headers = headers;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
  if (init?.signal) {
    // WHY: forward external abort to the internal controller so a single signal cancels fetch.
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  reqInit.signal = controller.signal;

  let res: Response;
  try {
    res = await fetch(resolveUrl(url, init?.baseUrl), reqInit);
  } catch (err) {
    clearTimeout(timer);
    throw {
      kind: "fetch_error",
      cause: err,
      hint:
        `The request never completed. The component was reachable at readiness, so it has ` +
        `since crashed, been stopped, or exceeded the timeout. cause carries the underlying ` +
        `network error.`,
    };
  }
  clearTimeout(timer);

  return {
    status: res.status,
    headers: res.headers,
    text: () => res.text(),
    json: <T = unknown>() => res.json() as Promise<T>,
    bytes: async () => new Uint8Array(await res.arrayBuffer()),
  };
};

export const createHelpers = (): HelperContext => ({
  http: {
    get: (url, init) => doFetch("GET", url, undefined, init, false),
    post: (url, body, init) => doFetch("POST", url, body, init, true),
    put: (url, body, init) => doFetch("PUT", url, body, init, true),
    patch: (url, body, init) => doFetch("PATCH", url, body, init, true),
    del: (url, init) => doFetch("DELETE", url, undefined, init, false),
  },
});
