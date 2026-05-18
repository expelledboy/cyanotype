/**
 * Petstore-SLA — harness wiring.
 *
 * Real Docker adapter for the integration suites.
 */

import { randomUUID } from "node:crypto";
import { createSharedEnvs, createDockerAdapter } from "../../src/index";
import { env } from "./env";

const adapter = createDockerAdapter({ sessionId: randomUUID() });

export const shared = createSharedEnvs(
  { "petstore-sla": env },
  {
    adapter,
    stateDir: ".speculum-env",
    mode:     "startOrAttach",
    getTargetEnv: () => "petstore-sla",
  },
);
