/**
 * Petstore-SLA — environment definition.
 *
 * Three-tier topology:
 *   client -> nginx -> 3 x petstore -> redis primary
 *                                  \-> redis replica (reads)
 *
 * Demonstrates the Blueprint/Binding split: each component declares a
 * substrate-agnostic Blueprint (the typed contract — port names, interface
 * factory, api, events, readiness) and a Binding factory
 * `(cfg) => bind(bp, {...})` that wraps it with substrate-specific fields
 * (image, env, host ports, mounts, per-binding logParser).
 *
 * WHY pinned host ports: the Docker adapter uses the port "name" as the
 * container port — names must be numeric strings. Nginx upstreams need to
 * know the petstore host ports up front; we pin them statically rather
 * than dynamically wiring.
 *
 * WHY host.docker.internal: containers reach each other through their
 * published host ports (no shared docker network in v1). On Mac/Windows
 * Docker Desktop this DNS name resolves to the host bridge; on Linux this
 * needs additional setup not covered here.
 */

import net from "node:net";
import { z } from "zod";
import {
  http, opaque, iface, defineBlueprint, bind, createEnvironment, createHttpClient,
  type EventCatalog,
  type HttpRouteMap,
  type LogParser,
  type HelperContext,
} from "../../src/index";

// Pinned host ports — see header.
const PETSTORE_PORTS = { one: 38081, two: 38082, three: 38083 } as const;
const REDIS_PRIMARY_PORT = 36379;
const REDIS_REPLICA_PORT = 36380;
const NGINX_PORT = 38080;

const DOCKER_HOST_DNS = "host.docker.internal";

// ---------------------------------------------------------------------------
// Petstore — schema-driven HTTP API + typed event catalog
// ---------------------------------------------------------------------------

const PetSchema = z.object({
  id: z.coerce.string(),
  name: z.string(),
  status: z.string().optional(),
});
const CreatePetInput = z.object({ name: z.string().min(1) });
const ListPetsResponse = z.object({ items: z.array(PetSchema) }).transform((v) => v.items);

const petstoreRoutes = {
  createPet: { method: "POST",   path: "/v1/pets",                              request: CreatePetInput, response: PetSchema },
  getPet:    { method: "GET",    path: (id: string) => `/v1/pets/${id}`,                                 response: PetSchema },
  listPets:  { method: "GET",    path: "/v1/pets",                                                       response: ListPetsResponse },
  deletePet: { method: "DELETE", path: (id: string) => `/v1/pets/${id}`,                                 responseMode: "status" },
} as const satisfies HttpRouteMap;

const petstoreEvents = {
  PETSTORE_REQUEST: z.object({
    method:   z.string(),
    path:     z.string(),
    status:   z.number(),
    instance: z.string(),
  }),
} as const satisfies EventCatalog;

const petstoreLogParser: LogParser = (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.method !== "string" || typeof obj.status !== "number") return null;
    return {
      name: "PETSTORE_REQUEST",
      attributes: {
        method:   obj.method,
        path:     String(obj.path ?? ""),
        status:   obj.status,
        instance: String(obj.instance ?? "unknown"),
      },
    };
  } catch {
    return null;
  }
};

const httpProbe = async (url: string, timeoutMs = 2000): Promise<boolean> => {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return res.status >= 200 && res.status < 500;
  } catch { return false; }
};

const tcpProbe = (host: string, port: number, timeoutMs = 2000): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => { try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });

type PetstoreIface = {
  http: {
    uri: string;
    host?: string | undefined;
    port?: number | undefined;
    protocol: { kind: "http"; routes: typeof petstoreRoutes };
  };
};

type PetstoreConfig = { instanceId: string; httpPort: number };

const petstoreBlueprint = defineBlueprint({
  portNames: ["8080"] as const,
  interface: (_config: PetstoreConfig, _env: Record<string, string>, ports): PetstoreIface => ({
    http: iface({
      uri:      `http://127.0.0.1:${ports["8080"]}/v1`,
      host:     "127.0.0.1",
      port:     ports["8080"],
      protocol: http(petstoreRoutes),
    }),
  }),
  // WHY custom api: the route paths embed `/v1` so the http client baseUrl
  // must be the root URL, not the iface.uri (which is `…/v1` for display).
  api: (i: PetstoreIface, _helpers: HelperContext) => ({
    http: createHttpClient(petstoreRoutes, { baseUrl: `http://127.0.0.1:${i.http.port ?? 0}` }),
  }),
  // WHY custom readiness: `/health` is at server root, not under `/v1`.
  readiness: {
    kind: "custom" as const,
    timeoutMs: 30_000,
    check: async (i: PetstoreIface) => httpProbe(`http://127.0.0.1:${i.http.port ?? 0}/health`),
  },
  events: petstoreEvents,
});

const petstore = (config: PetstoreConfig) =>
  bind(petstoreBlueprint, {
    image:   "speculum/petstore-sla:latest",
    version: "latest",
    config,
    env: {
      INSTANCE_ID:        config.instanceId,
      BASE_PATH:          "/v1",
      PORT:               "8080",
      REDIS_PRIMARY_HOST: DOCKER_HOST_DNS,
      REDIS_PRIMARY_PORT: String(REDIS_PRIMARY_PORT),
      REDIS_REPLICA_HOST: DOCKER_HOST_DNS,
      REDIS_REPLICA_PORT: String(REDIS_REPLICA_PORT),
    },
    ports:     { "8080": config.httpPort },
    logParser: petstoreLogParser,
  });

// ---------------------------------------------------------------------------
// Redis — opaque TCP; custom mounted config selects primary vs replica
// ---------------------------------------------------------------------------

const redisPrimaryConfig = (): string =>
  `bind 0.0.0.0\nport 6379\nprotected-mode no\nappendonly yes\n`;

const redisReplicaConfig = (primaryHostPort: number): string =>
  `bind 0.0.0.0\nport 6379\nprotected-mode no\nappendonly yes\nreplicaof ${DOCKER_HOST_DNS} ${primaryHostPort}\n`;

type RedisApi = {
  readonly host: string;
  readonly port: number;
  ping: () => Promise<void>;
};

type RedisIface = {
  redis: {
    uri: string;
    host?: string | undefined;
    port?: number | undefined;
    protocol: { kind: "opaque" };
  };
};

type RedisConfig = { hostPort: number; replicaOfPort?: number };

const redisBlueprint = defineBlueprint({
  portNames: ["6379"] as const,
  interface: (_cfg: RedisConfig, _env: Record<string, string>, ports): RedisIface => ({
    redis: iface({
      uri:      `redis://127.0.0.1:${ports["6379"]}`,
      host:     "127.0.0.1",
      port:     ports["6379"],
      protocol: opaque(),
    }),
  }),
  api: (i: RedisIface, _helpers: HelperContext): RedisApi => ({
    host: i.redis.host ?? "127.0.0.1",
    port: i.redis.port ?? 0,
    ping: async () => { await tcpProbe(i.redis.host ?? "127.0.0.1", i.redis.port ?? 0); },
  }),
  readiness: {
    kind: "custom" as const,
    timeoutMs: 30_000,
    check: async (i: RedisIface) => tcpProbe(i.redis.host ?? "127.0.0.1", i.redis.port ?? 0),
  },
});

const redis = (config: RedisConfig) =>
  bind(redisBlueprint, {
    image:   "speculum/redis-configurable:latest",
    version: "latest",
    config,
    env:     {},
    ports:   { "6379": config.hostPort },
    mounts: {
      "/etc/redis/redis.conf": config.replicaOfPort !== undefined
        ? redisReplicaConfig(config.replicaOfPort)
        : redisPrimaryConfig(),
    },
  });

// ---------------------------------------------------------------------------
// Nginx — load balancer in front of the three petstore instances
// ---------------------------------------------------------------------------

const nginxConfigText = (upstreamPorts: readonly number[]): string => {
  const servers = upstreamPorts
    .map((p) => `    server ${DOCKER_HOST_DNS}:${p} max_fails=1 fail_timeout=1s;`)
    .join("\n");
  return `worker_processes 1;
events {}
http {
  upstream petstore_backend {
${servers}
  }
  server {
    listen 8080;
    location / {
      proxy_pass http://petstore_backend;
      proxy_next_upstream error timeout http_502 http_503 http_504;
      proxy_connect_timeout 2s;
      proxy_read_timeout 5s;
    }
  }
}
`;
};

type NginxIface = {
  http: {
    uri: string;
    host?: string | undefined;
    port?: number | undefined;
    protocol: { kind: "http"; routes: typeof petstoreRoutes };
  };
};

type NginxConfig = { httpPort: number; upstreamPorts: readonly number[] };

const nginxBlueprint = defineBlueprint({
  portNames: ["8080"] as const,
  interface: (_cfg: NginxConfig, _env: Record<string, string>, ports): NginxIface => ({
    http: iface({
      uri:      `http://127.0.0.1:${ports["8080"]}`,
      host:     "127.0.0.1",
      port:     ports["8080"],
      protocol: http(petstoreRoutes),
    }),
  }),
  api: (i: NginxIface, _helpers: HelperContext) => ({
    http: createHttpClient(petstoreRoutes, { baseUrl: `http://127.0.0.1:${i.http.port ?? 0}` }),
  }),
  readiness: {
    kind: "custom" as const,
    timeoutMs: 30_000,
    check: async (i: NginxIface) => httpProbe(`http://127.0.0.1:${i.http.port ?? 0}/v1/pets`),
  },
});

const nginx = (config: NginxConfig) =>
  bind(nginxBlueprint, {
    image:   "nginx:alpine",
    version: "alpine",
    config,
    env:     {},
    ports:   { "8080": config.httpPort },
    mounts:  { "/etc/nginx/nginx.conf": nginxConfigText(config.upstreamPorts) },
  });

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export const env = createEnvironment({
  redis: {
    primary: redis({ hostPort: REDIS_PRIMARY_PORT }),
    replica: redis({ hostPort: REDIS_REPLICA_PORT, replicaOfPort: REDIS_PRIMARY_PORT }),
  },
  petstore: {
    one:   petstore({ instanceId: "one",   httpPort: PETSTORE_PORTS.one   }),
    two:   petstore({ instanceId: "two",   httpPort: PETSTORE_PORTS.two   }),
    three: petstore({ instanceId: "three", httpPort: PETSTORE_PORTS.three }),
  },
  nginx: nginx({
    httpPort:      NGINX_PORT,
    upstreamPorts: [PETSTORE_PORTS.one, PETSTORE_PORTS.two, PETSTORE_PORTS.three],
  }),
});

export type PetstoreSlaEnv = typeof env;
