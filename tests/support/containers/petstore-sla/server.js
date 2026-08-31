const http = require("node:http");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT || 8080);
const BASE_PATH = process.env.BASE_PATH || "/v1";
const INSTANCE_ID = process.env.INSTANCE_ID || "unknown";

// Kubernetes injects `<SERVICE_NAME>_PORT=tcp://<ip>:<port>` into every pod in
// a namespace, for every Service in it. A Service named `redis-primary`
// therefore sets REDIS_PRIMARY_PORT to a URL, clobbering the numeric value this
// expects — `Number()` yields NaN, the client URL becomes `redis://host:NaN`,
// and the process dies at module load before the server ever listens. Take the
// variable only when it actually parses as a port.
const portEnv = (name, fallback) => {
    const raw = process.env[name];
    const n = Number(raw);
    return raw !== undefined && Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

const PRIMARY_HOST = process.env.REDIS_PRIMARY_HOST || "host.docker.internal";
const PRIMARY_PORT = portEnv("REDIS_PRIMARY_PORT", 6379);
const REPLICA_HOST = process.env.REDIS_REPLICA_HOST || PRIMARY_HOST;
const REPLICA_PORT = portEnv("REDIS_REPLICA_PORT", PRIMARY_PORT);

// Reconnect fast. node-redis defaults to `retries * 50` capped at 500ms, which
// is polite for a production client and pure dead time for a fixture whose
// whole job is to demonstrate failover against a Redis on the same cluster.
// This tunes how quickly the CLIENT notices recovery; it does not change which
// failover path the tests exercise.
//
// Each client gets its OWN socket object: node-redis merges the parsed URL's
// host and port into the options it is handed, so sharing one literal between
// two clients makes the second overwrite the first's target — both then talk to
// the same server, and every write lands on the read-only replica.
const fastReconnect = () => ({ reconnectStrategy: () => 100 });

const primary = createClient({ url: `redis://${PRIMARY_HOST}:${PRIMARY_PORT}`, socket: fastReconnect() });
const replica = createClient({ url: `redis://${REPLICA_HOST}:${REPLICA_PORT}`, socket: fastReconnect() });

let primaryReady = false;
let replicaReady = false;

const log = (req, _res, start, status) => {
    const durationMs = Date.now() - start;
    const entry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.url,
        status,
        duration_ms: durationMs,
        instance: INSTANCE_ID,
    };
    console.log(JSON.stringify(entry));
};

const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
};

const notFound = (res) => json(res, 404, { error: "NOT_FOUND" });
const unavailable = (res, detail) => json(res, 503, { error: "DEPENDENCY_UNAVAILABLE", detail });

const parseBody = (req) =>
    new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > 1024 * 1024) {
                reject(new Error("Body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!data) return resolve(undefined);
            try {
                resolve(JSON.parse(data));
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });

// Flat, short retry. This runs against a Redis on the same host or cluster, so
// there is nothing to protect with exponential backoff — and the old 2s cap
// meant a single attempt landing just before Redis was reachable cost two
// seconds of startup on every run, on every substrate.
const RETRY_MS = 250;

const connectWithRetry = async (client, label) => {
    while (true) {
        try {
            await client.connect();
            console.log(JSON.stringify({ ts: new Date().toISOString(), event: "redis_connected", label }));
            return;
        } catch (err) {
            console.log(JSON.stringify({ ts: new Date().toISOString(), event: "redis_connect_failed", label, error: String(err) }));
            await new Promise((r) => setTimeout(r, RETRY_MS));
        }
    }
};

primary.on("ready", () => {
    primaryReady = true;
});
primary.on("end", () => {
    primaryReady = false;
});
primary.on("error", () => {
    primaryReady = false;
});

replica.on("ready", () => {
    replicaReady = true;
});
replica.on("end", () => {
    replicaReady = false;
});
replica.on("error", () => {
    replicaReady = false;
});

const pickReadClient = () => {
    if (replicaReady) return replica;
    if (primaryReady) return primary;
    return null;
};

const getPetKey = (id) => `pet:${id}`;

const readPet = async (id) => {
    const readClient = pickReadClient();
    if (!readClient) return { ok: false, reason: "no_redis" };

    const key = getPetKey(id);
    let payload = await readClient.get(key);
    if (!payload && readClient === replica && primaryReady) {
        payload = await primary.get(key);
    }
    if (!payload) return { ok: true, pet: null };
    return { ok: true, pet: JSON.parse(payload) };
};

const listPets = async () => {
    const readClient = pickReadClient();
    if (!readClient) return { ok: false, reason: "no_redis" };

    const ids = await readClient.sMembers("pets");
    if (ids.length === 0 && readClient === replica && primaryReady) {
        const primaryIds = await primary.sMembers("pets");
        const primaryPets = await fetchPets(primary, primaryIds);
        return { ok: true, items: primaryPets };
    }
    const pets = await fetchPets(readClient, ids);
    return { ok: true, items: pets };
};

const fetchPets = async (client, ids) => {
    if (ids.length === 0) return [];
    const keys = ids.map(getPetKey);
    const values = await client.mGet(keys);
    return values
        .filter((v) => v)
        .map((v) => {
            try {
                return JSON.parse(v);
            } catch {
                return null;
            }
        })
        .filter((v) => v);
};

const createPet = async (body) => {
    if (!primaryReady) return { ok: false, reason: "primary_down" };
    const id = body.id ?? Date.now();
    const pet = {
        id,
        name: body.name ?? "Pet",
        status: body.status ?? "available",
    };

    const key = getPetKey(id);
    await primary.multi().set(key, JSON.stringify(pet)).sAdd("pets", String(id)).exec();
    return { ok: true, pet };
};

const deletePet = async (id) => {
    if (!primaryReady) return { ok: false, reason: "primary_down" };
    const key = getPetKey(id);
    const deleted = await primary.del(key);
    await primary.sRem("pets", String(id));
    return { ok: true, deleted: deleted > 0 };
};

const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        if (url.pathname === "/health") {
            if (!primaryReady) {
                json(res, 503, { status: "degraded", primary: "down" });
                log(req, res, start, 503);
                return;
            }
            json(res, 200, { status: "ok", primary: "up", replica: replicaReady ? "up" : "down" });
            log(req, res, start, 200);
            return;
        }

        if (url.pathname === `${BASE_PATH}/pets` && req.method === "POST") {
            const body = await parseBody(req);
            if (!body || typeof body !== "object") {
                json(res, 400, { error: "INVALID_BODY" });
                log(req, res, start, 400);
                return;
            }
            const result = await createPet(body);
            if (!result.ok) {
                unavailable(res, result.reason);
                log(req, res, start, 503);
                return;
            }
            json(res, 201, result.pet);
            log(req, res, start, 201);
            return;
        }

        if (url.pathname === `${BASE_PATH}/pets` && req.method === "GET") {
            const result = await listPets();
            if (!result.ok) {
                unavailable(res, result.reason);
                log(req, res, start, 503);
                return;
            }
            json(res, 200, { items: result.items });
            log(req, res, start, 200);
            return;
        }

        const petMatch = new RegExp(`^${BASE_PATH}/pets/([^/]+)$`).exec(url.pathname);
        if (petMatch && req.method === "GET") {
            const result = await readPet(petMatch[1]);
            if (!result.ok) {
                unavailable(res, result.reason);
                log(req, res, start, 503);
                return;
            }
            if (!result.pet) {
                json(res, 404, { error: "NOT_FOUND" });
                log(req, res, start, 404);
                return;
            }
            json(res, 200, result.pet);
            log(req, res, start, 200);
            return;
        }

        if (petMatch && req.method === "DELETE") {
            const result = await deletePet(petMatch[1]);
            if (!result.ok) {
                unavailable(res, result.reason);
                log(req, res, start, 503);
                return;
            }
            json(res, result.deleted ? 204 : 404, result.deleted ? { deleted: true } : { error: "NOT_FOUND" });
            log(req, res, start, result.deleted ? 204 : 404);
            return;
        }

        notFound(res);
        log(req, res, start, 404);
    } catch {
        json(res, 500, { error: "SERVER_ERROR" });
        log(req, res, start, 500);
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(
        JSON.stringify({
            ts: new Date().toISOString(),
            event: "server_ready",
            port: PORT,
            basePath: BASE_PATH,
            instance: INSTANCE_ID,
        })
    );
});

process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
});

connectWithRetry(primary, "primary");
if (REPLICA_HOST && REPLICA_PORT) {
    connectWithRetry(replica, "replica");
}
