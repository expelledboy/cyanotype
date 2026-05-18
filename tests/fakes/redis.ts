/**
 * In-process redis presence stub.
 *
 * Opens a TCP listener so the binding's TCP readiness probe passes; toggles
 * the shared store's primaryUp/replicaUp flags on start/close so the petstore
 * fake's chaos-driven 503 behaviour stays wired to chaos.stop("redis", ...).
 */

import net from "node:net";
import type { FakeFactory } from "../../src/adapters/memory";
import type { SharedPetStore } from "./petstore";

export type RedisFakeOptions = {
  readonly store: SharedPetStore;
  readonly role: "primary" | "replica";
};

export const redisFake = (opts: RedisFakeOptions): FakeFactory => {
  return async (_spec, _emit) => {
    const server = net.createServer((sock) => {
      sock.on("error", () => { /* swallow */ });
      sock.on("data", () => { /* drop bytes — we don't speak RESP */ });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    if (opts.role === "primary") opts.store.setPrimary(true);
    else opts.store.setReplica(true);

    return {
      ports: { "6379": port },
      close: async () => {
        if (opts.role === "primary") opts.store.setPrimary(false);
        else opts.store.setReplica(false);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };
};
