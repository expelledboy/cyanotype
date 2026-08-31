/**
 * Global setup + teardown for the `bun test` session.
 *
 * `bun test` runs every test file in a single process. Top-level hooks in
 * a preload script (this file, registered in `bunfig.toml`) fire exactly
 * once around the entire run — once before all files, once after.
 *
 * Setup is lazy:
 *   Each test file's `beforeAll(shared.ensure(...))` triggers the
 *   container start on first call. The cross-process registry cache means
 *   subsequent calls return the same runtime. We don't eagerly `ensure`
 *   here so that `bun test tests/core/` (in-memory only) doesn't pay the
 *   cost of starting Docker containers it never uses.
 *
 * Teardown is eager:
 *   Stop any containers this session started, force-clean session-labelled
 *   stragglers via the adapter, and disconnect cleanly. This is the
 *   Bun-native equivalent of a runner-level `globalTeardown` hook.
 */

import { beforeAll, afterAll } from "bun:test";
import { enableInvariants } from "../src/invariants";
import { shared } from "./petstore-example/harness";

// Cyanotype's own suite always runs its runtime invariants — the cross-module
// agreements types cannot express. Off for consumers; see src/invariants.ts.
enableInvariants();

beforeAll(() => {
  // Intentional no-op. Per-file `beforeAll(shared.ensure(...))` handles
  // setup with cache reuse. Keep this hook so the setup/teardown pair is
  // visible in one place when future preload-level setup is needed.
});

afterAll(async () => {
  try {
    await shared.stopAll();
  } catch (e) {
    console.error("[preload] stopAll failed:", e);
  }
});
