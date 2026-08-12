import { describe, test, expect } from "bun:test";
import { createConsoleReporter, type ObserverEvent, type ObserverEventData } from "../../src/index";

const ev = (data: ObserverEventData, extra: Partial<ObserverEvent> = {}): ObserverEvent =>
  ({ seq: 0, at: "2026-01-01T00:00:00.000Z", adapter: "docker", ...data, ...extra }) as ObserverEvent;

const render = (events: ObserverEvent[], progress = false): string => {
  const lines: string[] = [];
  const reporter = createConsoleReporter({ write: (t) => lines.push(t), progress });
  for (const e of events) reporter(e);
  return lines.join("");
};

describe("reporter/createConsoleReporter", () => {
  test("prefixes every line with 'cyanotype'", () => {
    const out = render([ev({ type: "substrate.connected", latencyMs: 5 })]);
    expect(out).toContain("cyanotype  ");
  });

  test("renders the environment rollup", () => {
    const out = render([
      ev({ type: "environment.starting", componentCount: 3 }),
      ev({ type: "environment.ready", durationMs: 6200 }),
    ]);
    expect(out).toContain("environment starting · 3 component(s)");
    expect(out).toContain("environment ready · 6.2s");
  });

  test("formats sub-second and multi-second durations", () => {
    expect(render([ev({ type: "substrate.connected", latencyMs: 12 })])).toContain("connected · 12ms");
    expect(render([ev({ type: "image.pulled", image: "x", durationMs: 4800 }, { component: "petstore" })]))
      .toContain("image pulled · 4.8s");
  });

  test("attributes the component-ready line to its component", () => {
    const out = render([
      ev({ type: "environment.component_ready", done: 1, total: 2, durationMs: 1200 },
        { component: "bankingSim" }),
    ]);
    expect(out).toContain("bankingSim");
    expect(out).toContain("ready · 1/2 · 1.2s");
  });

  test("renders the probe phase so a slow custom probe is not silent", () => {
    const out = render([
      ev({ type: "probe.started", probeKind: "custom", timeoutMs: 30000, intervalMs: 1000 },
        { component: "payswitch" }),
    ]);
    expect(out).toContain("payswitch");
    expect(out).toContain("probe running · custom · ≤30s");
  });

  test("summarises a tagged error to its kind", () => {
    const out = render([
      ev({ type: "environment.failed", phase: "start", error: { kind: "image_pull_failed" } }),
    ]);
    expect(out).toContain("failed at start · image_pull_failed");
  });

  test("shows a probe attempt with its error", () => {
    const out = render([
      ev({ type: "probe.attempt", attempt: 3, elapsedMs: 2100, error: new Error("ECONNREFUSED") },
        { component: "petstore" }),
    ]);
    expect(out).toContain("probe attempt 3");
    expect(out).toContain("ECONNREFUSED");
    expect(out).toContain("2.1s");
  });

  test("shortens a registry image ref", () => {
    const out = render([
      ev({ type: "image.pull_started", image: "a.io/team/payswitch-endpoint:v7.9.2" },
        { component: "payswitch" }),
    ]);
    expect(out).toContain("…/payswitch-endpoint:v7.9.2");
    expect(out).not.toContain("a.io/team");
  });

  test("suppresses image pull progress when progress is off", () => {
    const out = render([
      ev({ type: "image.pull_progress", image: "alpine", layerId: "a", status: "Downloading", percent: 50 }),
    ], false);
    expect(out).toBe("");
  });

  test("does not render container provisioning sub-steps", () => {
    const out = render([
      ev({ type: "container.creating", image: "x" }, { component: "petstore" }),
      ev({ type: "container.created", containerId: "c1" }, { component: "petstore" }),
      ev({ type: "container.starting", containerId: "c1" }, { component: "petstore" }),
    ]);
    expect(out).toBe("");
  });
});
