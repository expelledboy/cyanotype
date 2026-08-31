/**
 * InMemoryAdapter — the substrate for simulator Bindings.
 *
 * Resolves a Binding's `image: string` against a factory registry instead
 * of pulling and running a container. The factory spawns an in-process
 * server (HTTP / TCP / whatever the user supplies) bound to a real
 * `127.0.0.1:<freePort>`; the typed client makes real fetches across a
 * real socket. The only thing fake is the container — the contract is
 * still exercised end-to-end.
 *
 * The factory registry lives on the Adapter (not on the Binding) so the
 * Adapter remains the single point where real-vs-fake is decided. Flipping
 * the entire suite from real to simulator is one line at harness wiring:
 * `createDockerAdapter()` vs `createInMemoryAdapter({ factories: {...} })`.
 * Test code and Bindings are unchanged.
 */

import type { Adapter, StartSpec, Started } from "../adapter.js";
import type { Emit } from "../observer.js";

// WHY: the adapter owns the line buffer + pub/sub for logs(). The factory only
// supplies ports + close. `emit` is provided BY the adapter to the factory so
// the factory can push lines into the adapter's buffer.
export type FakeHandle = {
  readonly ports: Record<string, number>;
  readonly close: () => Promise<void>;
};

export type FakeFactory = (
  spec: StartSpec,
  emit: (line: string) => void,
) => Promise<FakeHandle>;

export type InMemoryAdapterOptions = {
  readonly factories: Record<string, FakeFactory>;
};

type Entry = {
  handle: FakeHandle;
  lines: string[];
  waiters: Array<(line: string | null) => void>;
  closed: boolean;
};

const randomId = () => `mem-${Math.random().toString(36).slice(2, 10)}`;

export const createInMemoryAdapter = (opts: InMemoryAdapterOptions): Adapter => {
  const containers = new Map<string, Entry>();

  const start = async (spec: StartSpec, observe?: Emit): Promise<Started> => {
    const factory = opts.factories[spec.image];
    if (!factory) {
      throw {
        kind: "image_not_registered",
        image: spec.image,
        registered: Object.keys(opts.factories),
        hint:
          `The in-memory adapter resolves a Binding's image string against its factory ` +
          `registry, and "${spec.image}" is not in it. Registered: ` +
          `[${Object.keys(opts.factories).join(", ") || "none"}]. Add a factory under that ` +
          `exact image string, or point the Binding at one already registered — this is the ` +
          `seam where a Binding becomes a simulator instead of a container.`,
      };
    }
    const containerId = randomId();
    observe?.({ type: "container.creating", image: spec.image });
    const entry: Entry = { handle: null as unknown as FakeHandle, lines: [], waiters: [], closed: false };
    const emitLine = (line: string) => {
      if (entry.closed) return;
      entry.lines.push(line);
      const w = entry.waiters.shift();
      if (w) w(line);
    };
    const handle = await factory(spec, emitLine);
    entry.handle = handle;
    containers.set(containerId, entry);
    observe?.({ type: "container.created", containerId });
    observe?.({ type: "container.started", containerId, ports: handle.ports });
    return { containerId, ports: handle.ports, owned: true };
  };

  const stop = async (containerId: string): Promise<void> => {
    const entry = containers.get(containerId);
    if (!entry) return;
    entry.closed = true;
    for (const w of entry.waiters.splice(0)) w(null);
    try { await entry.handle.close(); } catch { /* noop */ }
    containers.delete(containerId);
  };

  async function* logs(containerId: string, signal?: AbortSignal): AsyncGenerator<string> {
    const entry = containers.get(containerId);
    if (!entry) return;
    let idx = 0;
    const onAbort = () => {
      const w = entry.waiters.shift();
      if (w) w(null);
    };
    if (signal) {
      if (signal.aborted) return;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      while (true) {
        while (idx < entry.lines.length) {
          if (signal?.aborted || entry.closed) return;
          const line = entry.lines[idx++];
          if (line !== undefined) yield line;
        }
        if (signal?.aborted || entry.closed) return;
        const next = await new Promise<string | null>((resolve) => {
          entry.waiters.push(resolve);
        });
        if (next === null) return;
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    name: "memory",
    connect: async () => { /* noop */ },
    disconnect: async () => { /* noop */ },
    teardown: async () => { /* noop */ },
    start,
    stop,
    logs,
    exists: async (id) => containers.has(id),
  };
};

export type { StartSpec, Started };
