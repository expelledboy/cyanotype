/**
 * In-process nginx fake — HTTP reverse proxy with round-robin + fail_timeout.
 *
 * Mirrors the env.ts nginx config:
 *   max_fails=1 fail_timeout=1s
 *   proxy_next_upstream error timeout http_502 http_503 http_504
 *   proxy_connect_timeout 2s, proxy_read_timeout 5s
 *
 * Upstream URLs are discovered through a shared map populated by petstore
 * fakes when they start; the orchestrator starts components in env-declared
 * order (redis → petstore → nginx), so by the time nginx is created the
 * petstore entries are already present. As a safety net, the proxy snapshots
 * the map at request time so late additions are still picked up.
 */

import type { FakeFactory } from "../../src/adapters/memory";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
]);

const FAIL_TIMEOUT_MS = 1000;
const CONNECT_TIMEOUT_MS = 2000;
const READ_TIMEOUT_MS = 5000;

type UpstreamState = { deadUntil: number };

export type NginxFakeOptions = {
  readonly upstreams: ReadonlyMap<string, string>;
};

const filterHeaders = (src: Headers): Headers => {
  const out = new Headers();
  src.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v); });
  return out;
};

export const nginxFake = (opts: NginxFakeOptions): FakeFactory => {
  return async (_spec, _emit) => {
    const state = new Map<string, UpstreamState>();
    let rrIdx = 0;

    const tryOne = async (url: string, req: Request, body: ArrayBuffer | null): Promise<Response> => {
      const ac = new AbortController();
      const connectTimer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS);
      try {
        const init: RequestInit = {
          method: req.method,
          headers: filterHeaders(req.headers),
          signal: ac.signal,
          ...(body && body.byteLength > 0 ? { body } : {}),
        };
        return await fetch(url, init);
      } finally {
        clearTimeout(connectTimer);
      }
    };

    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const pathQuery = url.pathname + url.search;
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();

      const all = [...opts.upstreams.entries()];
      if (all.length === 0) {
        return new Response(JSON.stringify({ error: "NO_UPSTREAMS" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }

      const now = Date.now();
      const liveCount = all.filter(([n]) => (state.get(n)?.deadUntil ?? 0) <= now).length;
      if (liveCount === 0) {
        for (const [n] of all) state.set(n, { deadUntil: 0 });
      }

      const order: Array<[string, string]> = [];
      for (let i = 0; i < all.length; i++) {
        const idx = (rrIdx + i) % all.length;
        const entry = all[idx];
        if (entry) order.push(entry);
      }
      rrIdx = (rrIdx + 1) % all.length;

      let lastFailure: Response | null = null;
      for (const [name, base] of order) {
        const s = state.get(name) ?? { deadUntil: 0 };
        if (s.deadUntil > now) continue;

        try {
          const target = base.replace(/\/$/, "") + pathQuery;
          const res = await tryOne(target, req, body);
          if (res.status === 502 || res.status === 503 || res.status === 504) {
            state.set(name, { deadUntil: Date.now() + FAIL_TIMEOUT_MS });
            lastFailure = res;
            continue;
          }
          state.set(name, { deadUntil: 0 });
          const outHeaders = filterHeaders(res.headers);
          return new Response(res.body, { status: res.status, headers: outHeaders });
        } catch {
          state.set(name, { deadUntil: Date.now() + FAIL_TIMEOUT_MS });
          continue;
        }
      }

      if (lastFailure) {
        const outHeaders = filterHeaders(lastFailure.headers);
        return new Response(lastFailure.body, { status: lastFailure.status, headers: outHeaders });
      }
      return new Response(JSON.stringify({ error: "ALL_UPSTREAMS_DEAD" }), { status: 503, headers: { "Content-Type": "application/json" } });
    };

    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    return {
      ports: { "8080": server.port ?? 0 },
      close: async () => { server.stop(true); },
    };
  };
};
