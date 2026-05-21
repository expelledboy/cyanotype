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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  http, opaque, iface, defineBlueprint, bind, createEnvironment, createHttpClient,
  type EventCatalog,
  type HttpRouteMap,
  type LogParser,
  type HelperContext,
  type AdapterConfig,
} from "../../src/index";
import { K8sAdapterConfigSchema } from "../../src/adapters/kubernetes";
import { ComposeAdapterConfigSchema } from "../../src/adapters/docker";

// Pinned host ports — see header.
const PETSTORE_PORTS = { one: 38081, two: 38082, three: 38083 } as const;
const REDIS_PRIMARY_PORT = 36379;
const REDIS_REPLICA_PORT = 36380;
const NGINX_PORT = 38080;

const DOCKER_HOST_DNS = "host.docker.internal";

// K8s mode: cross-component traffic uses Service DNS (D-020) on the
// container port. Docker/memory mode: host.docker.internal + pinned host ports.
// k8s-attach: pre-deployed workloads, env vars baked into Deployment manifests.
// docker-attach: pre-deployed compose stack; components reached via published
//   host ports (same as docker deploy mode).
const ADAPTER = process.env.SPECULUM_ADAPTER ?? "docker";
const IS_K8S = ADAPTER === "k8s";
const IS_K8S_ATTACH = ADAPTER === "k8s-attach";
const IS_DOCKER_ATTACH = ADAPTER === "docker-attach";

const EXPECTED_KEYS = ["petstore.one","petstore.two","petstore.three","redis.primary","redis.replica","nginx"] as const;
const loadDerived = (): Record<string, AdapterConfig> => {
  const p = join(import.meta.dir, "derived.json");
  if (!existsSync(p)) throw { kind: "derived_json_missing", path: p };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const out: Record<string, AdapterConfig> = {};
  const missing: string[] = [];
  for (const k of EXPECTED_KEYS) {
    const entry = parsed[k];
    if (!entry) { missing.push(k); continue; }
    out[k] = K8sAdapterConfigSchema.parse(entry) as AdapterConfig;
  }
  if (missing.length > 0) throw { kind: "derived_json_missing_keys", missing };
  return out;
};
const loadDerivedCompose = (): Record<string, AdapterConfig> => {
  const p = join(import.meta.dir, "derived-compose.json");
  if (!existsSync(p)) throw { kind: "derived_json_missing", path: p };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const out: Record<string, AdapterConfig> = {};
  const missing: string[] = [];
  for (const k of EXPECTED_KEYS) {
    const entry = parsed[k];
    if (!entry) { missing.push(k); continue; }
    out[k] = ComposeAdapterConfigSchema.parse(entry) as AdapterConfig;
  }
  if (missing.length > 0) throw { kind: "derived_json_missing_keys", missing };
  return out;
};
const derived: Record<string, AdapterConfig> = IS_K8S_ATTACH
  ? loadDerived()
  : IS_DOCKER_ATTACH
  ? loadDerivedCompose()
  : {};
const adapterFor = (key: string): AdapterConfig | undefined =>
  (IS_K8S_ATTACH || IS_DOCKER_ATTACH) ? derived[key] : undefined;
const REDIS_PRIMARY_DNS  = IS_K8S ? "redis-primary" : DOCKER_HOST_DNS;
const REDIS_REPLICA_DNS  = IS_K8S ? "redis-replica" : DOCKER_HOST_DNS;
const REDIS_PRIMARY_WIRE_PORT = IS_K8S ? 6379 : 36379;
const REDIS_REPLICA_WIRE_PORT = IS_K8S ? 6379 : 36380;
const petstoreServiceHost = (instance: "one" | "two" | "three"): string =>
  IS_K8S ? `petstore-${instance}` : DOCKER_HOST_DNS;
const petstoreWirePort = (hostPort: number): number => IS_K8S ? 8080 : hostPort;

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
      REDIS_PRIMARY_HOST: REDIS_PRIMARY_DNS,
      REDIS_PRIMARY_PORT: String(REDIS_PRIMARY_WIRE_PORT),
      REDIS_REPLICA_HOST: REDIS_REPLICA_DNS,
      REDIS_REPLICA_PORT: String(REDIS_REPLICA_WIRE_PORT),
    },
    ports:     { "8080": config.httpPort },
    logParser: petstoreLogParser,
    ...((): { adapter?: AdapterConfig } => {
      const a = adapterFor(`petstore.${config.instanceId}`);
      return a ? { adapter: a } : {};
    })(),
  });

// ---------------------------------------------------------------------------
// Redis — opaque TCP; custom mounted config selects primary vs replica
// ---------------------------------------------------------------------------

const redisPrimaryConfig = (): string =>
  `bind 0.0.0.0\nport 6379\nprotected-mode no\nappendonly yes\n`;

const redisReplicaConfig = (primaryHostPort: number): string =>
  `bind 0.0.0.0\nport 6379\nprotected-mode no\nappendonly yes\nreplicaof ${REDIS_PRIMARY_DNS} ${REDIS_PRIMARY_WIRE_PORT}\n`;

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

const redis = (config: RedisConfig & { adapterKey?: string }) =>
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
    ...((): { adapter?: AdapterConfig } => {
      const a = config.adapterKey ? adapterFor(config.adapterKey) : undefined;
      return a ? { adapter: a } : {};
    })(),
  });

// ---------------------------------------------------------------------------
// Nginx — load balancer in front of the three petstore instances
// ---------------------------------------------------------------------------

type NginxUpstream = { host: string; port: number };
const nginxConfigText = (upstreams: readonly NginxUpstream[]): string => {
  const servers = upstreams
    .map((u) => `    server ${u.host}:${u.port} max_fails=1 fail_timeout=1s;`)
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

type NginxConfig = { httpPort: number; upstreams: readonly NginxUpstream[] };

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
    mounts:  { "/etc/nginx/nginx.conf": nginxConfigText(config.upstreams) },
    ...((): { adapter?: AdapterConfig } => {
      const a = adapterFor("nginx");
      return a ? { adapter: a } : {};
    })(),
  });

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export const env = createEnvironment({
  redis: {
    primary: redis({ hostPort: REDIS_PRIMARY_PORT, adapterKey: "redis.primary" }),
    replica: redis({ hostPort: REDIS_REPLICA_PORT, replicaOfPort: REDIS_PRIMARY_PORT, adapterKey: "redis.replica" }),
  },
  petstore: {
    one:   petstore({ instanceId: "one",   httpPort: PETSTORE_PORTS.one   }),
    two:   petstore({ instanceId: "two",   httpPort: PETSTORE_PORTS.two   }),
    three: petstore({ instanceId: "three", httpPort: PETSTORE_PORTS.three }),
  },
  nginx: nginx({
    httpPort: NGINX_PORT,
    upstreams: [
      { host: petstoreServiceHost("one"),   port: petstoreWirePort(PETSTORE_PORTS.one)   },
      { host: petstoreServiceHost("two"),   port: petstoreWirePort(PETSTORE_PORTS.two)   },
      { host: petstoreServiceHost("three"), port: petstoreWirePort(PETSTORE_PORTS.three) },
    ],
  }),
});

export type PetstoreSlaEnv = typeof env;
