/**
 * In-process petstore fake — see petstore-container.md.
 */

import type { FakeFactory } from "../../src/adapters/memory";

export type PetstoreOptions = {
  readonly instanceId: string;
  readonly store: SharedPetStore;
};

export type SharedPetStore = {
  readonly primaryUp: () => boolean;
  readonly replicaUp: () => boolean;
  readonly setPrimary: (up: boolean) => void;
  readonly setReplica: (up: boolean) => void;
  readonly pets: Map<string, { id: string; name: string }>;
  readonly nextId: () => string;
};

export const createSharedPetStore = (): SharedPetStore => {
  let primary = true;
  let replica = true;
  let counter = 0;
  const pets = new Map<string, { id: string; name: string }>();
  return {
    pets,
    primaryUp: () => primary,
    replicaUp: () => replica,
    setPrimary: (up) => { primary = up; },
    setReplica: (up) => { replica = up; },
    nextId: () => { counter += 1; return String(counter); },
  };
};

export const petstoreFake = (opts: PetstoreOptions): FakeFactory => {
  return async (_spec, emit) => {
    const handler = async (req: Request): Promise<Response> => {
      const started = performance.now();
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      let status = 404;
      let body: unknown = { error: "NOT_FOUND" };

      const isWrite = method === "POST" || method === "DELETE";
      const isRead = method === "GET";
      const primaryDown = !opts.store.primaryUp();
      const replicaDown = !opts.store.replicaUp();

      try {
        if (isWrite && primaryDown) {
          status = 503; body = { error: "DEPENDENCY_UNAVAILABLE", detail: "primary_down" };
        } else if (isRead && path !== "/health" && primaryDown && replicaDown) {
          status = 503; body = { error: "DEPENDENCY_UNAVAILABLE", detail: "no_redis" };
        } else if (method === "GET" && path === "/health") {
          if (primaryDown) {
            status = 503;
            body = { status: "degraded", primary: "down", replica: replicaDown ? "down" : "up" };
          } else {
            status = 200;
            body = { status: "ok", primary: "up", replica: replicaDown ? "down" : "up" };
          }
        } else if (method === "GET" && path === "/v1/pets") {
          status = 200; body = { items: [...opts.store.pets.values()] };
        } else if (method === "GET" && path.startsWith("/v1/pets/")) {
          const id = path.slice("/v1/pets/".length);
          const pet = opts.store.pets.get(id);
          if (pet) { status = 200; body = pet; }
          else { status = 404; body = { error: "NOT_FOUND" }; }
        } else if (method === "POST" && path === "/v1/pets") {
          const input = await req.json() as { name: string };
          const id = opts.store.nextId();
          const pet = { id, name: input.name };
          opts.store.pets.set(id, pet);
          status = 201; body = pet;
        } else if (method === "DELETE" && path.startsWith("/v1/pets/")) {
          const id = path.slice("/v1/pets/".length);
          if (opts.store.pets.delete(id)) {
            status = 204; body = null;
          } else {
            status = 404; body = { error: "NOT_FOUND" };
          }
        }
      } catch {
        status = 400; body = { error: "BAD_REQUEST" };
      }

      const duration_ms = performance.now() - started;
      emit(JSON.stringify({
        ts: new Date().toISOString(),
        method, path, status,
        duration_ms: Math.round(duration_ms),
        instance: opts.instanceId,
      }));

      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };

    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    return {
      ports: { http: server.port ?? 0 },
      close: async () => { server.stop(true); },
    };
  };
};
