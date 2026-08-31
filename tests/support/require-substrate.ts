/**
 * Substrate availability, for suites that cannot run without one.
 *
 * TWO FAILURE MODES, AND THEY ARE NOT THE SAME. A developer with no cluster
 * running `bun test` wants the Kubernetes suites out of the way. Continuous
 * integration, which provisions a cluster before running anything, wants their
 * absence to stop the build — it means the provisioning step silently did
 * nothing. `CYANOTYPE_REQUIRE_DOCKER=1` and `CYANOTYPE_REQUIRE_K8S=1` select
 * the second reading.
 *
 * WHY THIS EXISTS AT ALL. The suites used to record availability in a
 * `beforeAll` and open every test body with `if (!HAS_K8S) return;`. Bun
 * registers tests before any `beforeAll` runs, so that was the only shape
 * available — and it made a suite that asserted nothing report as passing.
 * Measured: `tests/substrate/kubernetes.test.ts` reported "9 pass" in 190ms
 * with no cluster reachable, against "9 pass, 17 expect() calls" in 10.7s with
 * one. The two differ only in an assertion count nobody reads and a sixtyfold
 * speedup nothing checks.
 *
 * Probing at module scope — Bun supports top-level `await` in test files —
 * makes the result available to `describe.skipIf`, which reports `skip` rather
 * than `pass`. That is the whole point: absence becomes visible.
 *
 * PROBE ONCE PER FILE, at the top, and pass the result to `describe.skipIf`.
 * Do not call these inside a test.
 */

import { createDockerAdapter } from "../../src/adapters/docker";

/** Whether a Docker daemon is reachable: connect and disconnect for real. */
export const dockerAvailable = async (): Promise<boolean> => {
  try {
    const a = createDockerAdapter({ sessionId: "probe" });
    await a.connect();
    await a.disconnect();
    return true;
  } catch {
    return false;
  }
};

/** Whether `context` names a cluster this machine can currently reach. */
export const k8sAvailable = async (context: string): Promise<boolean> => {
  try {
    const proc = Bun.spawn(["kubectl", "--context", context, "get", "nodes"], {
      stdout: "ignore", stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
};

const FLAG = { docker: "CYANOTYPE_REQUIRE_DOCKER", k8s: "CYANOTYPE_REQUIRE_K8S" } as const;

/**
 * Pass `available` through, unless this run demanded the substrate and did not
 * get it — then throw, so the file fails instead of quietly skipping.
 *
 * `probe` is the command or call that came back negative. It goes in the
 * thrown object because the reader's next question is always "reach it how?",
 * and the answer is not guessable from the substrate name alone.
 */
export const requireSubstrate = (
  available: boolean,
  substrate: keyof typeof FLAG,
  probe: string,
): boolean => {
  if (available === true) return true;
  const flag = FLAG[substrate];
  if (process.env[flag] !== "1") return false;
  throw {
    kind: "required_substrate_unavailable",
    substrate,
    flag,
    probe,
    hint:
      `${flag}=1 says this run has a ${substrate} substrate, and \`${probe}\` ` +
      `disagrees. Continuous integration sets that variable after provisioning ` +
      `one, so the usual cause is a provisioning step that failed without ` +
      `failing the job. Unset ${flag} to let these suites skip instead.`,
  };
};
