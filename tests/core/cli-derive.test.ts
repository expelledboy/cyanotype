import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveCompose, deriveK8s, loadDerivedCompose } from "../../src/cli/derive.js";
import { ComposeAdapterConfigSchema, K8sAdapterConfigSchema } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpFile = (name: string, content: string): string => {
  const dir = join(tmpdir(), "cyanotype-cli-derive-test");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
};

// ---------------------------------------------------------------------------
// deriveCompose
// ---------------------------------------------------------------------------

describe("deriveCompose", () => {
  const COMPOSE_YAML = `
name: my-project
services:
  cache:
    image: redis:7
    labels:
      cyanotype.component: redis
    ports:
      - "6379:6379"
  api:
    image: myapp:latest
    labels:
      cyanotype.component: petstore
      cyanotype.instance: primary
    ports:
      - "8080:8080"
  unlabelled:
    image: postgres:15
    ports:
      - "5432:5432"
`;

  test("extracts labelled services into binding keys", () => {
    const path = tmpFile("compose.yaml", COMPOSE_YAML);
    const result = deriveCompose(path);
    expect(Object.keys(result).sort()).toEqual(["petstore.primary", "redis"]);
  });

  test("each entry validates against ComposeAdapterConfigSchema", () => {
    const path = tmpFile("compose.yaml", COMPOSE_YAML);
    const result = deriveCompose(path);
    for (const value of Object.values(result)) {
      expect(() => ComposeAdapterConfigSchema.parse(value)).not.toThrow();
    }
  });

  test("omits unlabelled services", () => {
    const path = tmpFile("compose.yaml", COMPOSE_YAML);
    const result = deriveCompose(path);
    expect("unlabelled" in result).toBe(false);
  });

  test("passes optional project name into compose.attach.project", () => {
    const path = tmpFile("compose.yaml", COMPOSE_YAML);
    const result = deriveCompose(path, "my-project");
    const entry = result["redis"] as { compose: { attach: Record<string, unknown> } };
    expect(entry.compose.attach["project"]).toBe("my-project");
  });

  test("returns empty object for compose file with no services", () => {
    const path = tmpFile("empty-compose.yaml", "name: empty\n");
    expect(deriveCompose(path)).toEqual({});
  });

  test("does not emit allowChaos — policy belongs at the bind site", () => {
    const path = tmpFile("compose.yaml", COMPOSE_YAML);
    const result = deriveCompose(path);
    const entry = result["redis"] as { compose: { attach: Record<string, unknown> } };
    expect(entry.compose.attach["allowChaos"]).toBeUndefined();
    const entry2 = result["petstore.primary"] as { compose: { attach: Record<string, unknown> } };
    expect(entry2.compose.attach["allowChaos"]).toBeUndefined();
  });

  test("handles array-style labels", () => {
    const yaml = `
services:
  svc:
    image: redis:7
    labels:
      - "cyanotype.component=cache"
      - "cyanotype.instance=a"
    ports:
      - "6379:6379"
`;
    const path = tmpFile("array-labels.yaml", yaml);
    const result = deriveCompose(path);
    expect("cache.a" in result).toBe(true);
  });

  test("emits attach.port for single-port services; omits it for multi-port", () => {
    const yaml = `
services:
  single:
    image: redis:7
    labels:
      cyanotype.component: cache
    ports:
      - "6379:6379"
  multi:
    image: simulator:latest
    labels:
      cyanotype.component: simulator
    ports:
      - "59220:59220"
      - "59221:8080"
`;
    const path = tmpFile("multi-port.yaml", yaml);
    const result = deriveCompose(path);
    const single = result["cache"] as { compose: { attach: Record<string, unknown> } };
    const multi  = result["simulator"] as { compose: { attach: Record<string, unknown> } };
    expect(single.compose.attach["port"]).toBe(6379);
    expect(multi.compose.attach["port"]).toBeUndefined();
    // Topology is still preserved for the multi-port service.
    expect(multi.compose.attach["service"]).toBe("multi");
  });
});

// ---------------------------------------------------------------------------
// deriveK8s
// ---------------------------------------------------------------------------

describe("deriveK8s", () => {
  const K8S_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-dep
  namespace: test-ns
spec:
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
        cyanotype.component: redis
    spec:
      containers:
        - name: redis
          image: redis:7
          ports:
            - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis-svc
  namespace: test-ns
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-dep
  namespace: test-ns
spec:
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
        cyanotype.component: petstore
        cyanotype.instance: primary
    spec:
      containers:
        - name: api
          image: myapp:latest
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: api-svc
  namespace: test-ns
spec:
  selector:
    app: api
  ports:
    - port: 8080
      targetPort: 8080
`;

  test("extracts labelled deployments/services into binding keys", () => {
    const path = tmpFile("k8s.yaml", K8S_YAML);
    const result = deriveK8s(path);
    expect(Object.keys(result).sort()).toEqual(["petstore.primary", "redis"]);
  });

  test("each entry validates against K8sAdapterConfigSchema", () => {
    const path = tmpFile("k8s.yaml", K8S_YAML);
    const result = deriveK8s(path);
    for (const value of Object.values(result)) {
      expect(() => K8sAdapterConfigSchema.parse(value)).not.toThrow();
    }
  });

  test("populates namespace, service, port, deployment", () => {
    const path = tmpFile("k8s.yaml", K8S_YAML);
    const result = deriveK8s(path);
    const entry = result["redis"] as { k8s: { attach: Record<string, unknown> } };
    expect(entry.k8s.attach["namespace"]).toBe("test-ns");
    expect(entry.k8s.attach["service"]).toBe("redis-svc");
    expect(entry.k8s.attach["port"]).toBe(6379);
    expect(entry.k8s.attach["deployment"]).toBe("redis-dep");
  });

  test("does not emit allowChaos — policy belongs at the bind site", () => {
    const path = tmpFile("k8s.yaml", K8S_YAML);
    const result = deriveK8s(path);
    const entry = result["redis"] as { k8s: { attach: Record<string, unknown> } };
    expect(entry.k8s.attach["allowChaos"]).toBeUndefined();
    const entry2 = result["petstore.primary"] as { k8s: { attach: Record<string, unknown> } };
    expect(entry2.k8s.attach["allowChaos"]).toBeUndefined();
  });

  test("walks a directory of yaml files", () => {
    const dir = join(tmpdir(), "cyanotype-cli-derive-test", "k8s-dir");
    mkdirSync(dir, { recursive: true });
    // Split the yaml into two files
    const [part1, part2] = K8S_YAML.split("---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api-dep");
    writeFileSync(join(dir, "01-redis.yaml"), part1!, "utf8");
    writeFileSync(join(dir, "02-api.yaml"), "---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api-dep" + part2!, "utf8");
    const result = deriveK8s(dir);
    expect(Object.keys(result).sort()).toEqual(["petstore.primary", "redis"]);
  });

  test("returns empty object when no labelled resources", () => {
    const yaml = `
apiVersion: v1
kind: Service
metadata:
  name: bare
  namespace: ns
spec:
  selector:
    app: bare
`;
    const path = tmpFile("no-labels.yaml", yaml);
    expect(deriveK8s(path)).toEqual({});
  });

  test("emits attach.port for single-port workloads; omits it for multi-port", () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: single-dep, namespace: ns }
spec:
  selector: { matchLabels: { app: single } }
  template:
    metadata:
      labels:
        app: single
        cyanotype.component: cache
    spec:
      containers:
        - name: c
          image: redis:7
          ports:
            - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata: { name: single-svc, namespace: ns }
spec:
  selector: { app: single }
  ports:
    - port: 6379
      targetPort: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: multi-dep, namespace: ns }
spec:
  selector: { matchLabels: { app: multi } }
  template:
    metadata:
      labels:
        app: multi
        cyanotype.component: simulator
    spec:
      containers:
        - name: c
          image: simulator:latest
          ports:
            - containerPort: 59220
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata: { name: multi-svc, namespace: ns }
spec:
  selector: { app: multi }
  ports:
    - port: 59220
      targetPort: 59220
    - port: 8080
      targetPort: 8080
`;
    const path = tmpFile("multi-port-k8s.yaml", yaml);
    const result = deriveK8s(path);
    const single = result["cache"]     as { k8s: { attach: Record<string, unknown> } };
    const multi  = result["simulator"] as { k8s: { attach: Record<string, unknown> } };
    expect(single.k8s.attach["port"]).toBe(6379);
    expect(multi.k8s.attach["port"]).toBeUndefined();
    // Topology is still preserved for the multi-port workload.
    expect(multi.k8s.attach["service"]).toBe("multi-svc");
    expect(multi.k8s.attach["deployment"]).toBe("multi-dep");
  });
});

// ---------------------------------------------------------------------------
// loadDerivedCompose
// ---------------------------------------------------------------------------

describe("loadDerivedCompose", () => {
  const VALID = JSON.stringify({
    redis: { compose: { attach: { service: "cache", port: 6379, allowChaos: true } } },
    "petstore.primary": {
      compose: { attach: { service: "api", port: 8080, allowChaos: true } },
    },
  });

  test("returns the loaded map when every expected key is present", () => {
    const path = tmpFile("derived-compose.json", VALID);
    const result = loadDerivedCompose(path, ["redis", "petstore.primary"]);
    expect(Object.keys(result).sort()).toEqual(["petstore.primary", "redis"]);
    const entry = result["redis"] as { compose: { attach: Record<string, unknown> } };
    expect(entry.compose.attach["service"]).toBe("cache");
  });

  test("missing file throws derived_compose_missing", () => {
    let caught: unknown;
    try { loadDerivedCompose("/no/such/path/derived.json", []); } catch (e) { caught = e; }
    expect((caught as { kind?: string }).kind).toBe("derived_compose_missing");
    expect((caught as { path?: string }).path).toBe("/no/such/path/derived.json");
  });

  test("invalid JSON throws derived_compose_invalid", () => {
    const path = tmpFile("bad.json", "{not json");
    let caught: unknown;
    try { loadDerivedCompose(path, []); } catch (e) { caught = e; }
    expect((caught as { kind?: string }).kind).toBe("derived_compose_invalid");
    expect((caught as { path?: string }).path).toBe(path);
  });

  test("schema-invalid entry throws derived_compose_invalid", () => {
    // `onImageDrift` must be one of the enum values; "bogus" should fail.
    const bad = JSON.stringify({
      redis: { compose: { attach: { onImageDrift: "bogus" } } },
    });
    const path = tmpFile("schema-invalid.json", bad);
    let caught: unknown;
    try { loadDerivedCompose(path, ["redis"]); } catch (e) { caught = e; }
    expect((caught as { kind?: string }).kind).toBe("derived_compose_invalid");
  });

  test("missing expected key throws derived_compose_missing_keys listing the absent names", () => {
    const path = tmpFile("missing-keys.json", VALID);
    let caught: unknown;
    try {
      loadDerivedCompose(path, ["redis", "petstore.primary", "absent-a", "absent-b"]);
    } catch (e) { caught = e; }
    expect((caught as { kind?: string }).kind).toBe("derived_compose_missing_keys");
    expect((caught as { missing?: readonly string[] }).missing).toEqual([
      "absent-a",
      "absent-b",
    ]);
  });
});

// ---------------------------------------------------------------------------
// CLI dispatch — spawn the bin entry so argv parsing breakage cannot ship
// green. The library tests above exercise the pure functions; these spawn
// `bun src/cli/index.ts` and assert the subcommand router actually routes.
// ---------------------------------------------------------------------------

describe("cyanotype derive (CLI dispatch)", () => {
  const cli = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

  const COMPOSE_YAML = [
    "services:",
    "  redis:",
    "    image: redis:7",
    "    ports: ['6379:6379']",
    "    labels:",
    "      cyanotype.component: redis",
    "      cyanotype.instance: primary",
    "  petstore:",
    "    image: petstore:latest",
    "    ports: ['8080:8080']",
    "    labels:",
    "      cyanotype.component: petstore",
    "",
  ].join("\n");

  test("derive compose --out - dispatches to the compose handler and writes JSON to stdout", async () => {
    const composePath = tmpFile("dispatch-compose.yaml", COMPOSE_YAML);
    const proc = Bun.spawn(
      ["bun", cli, "derive", "compose", "--compose", composePath, "--out", "-", "--project", "demo"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed["redis.primary"]).toBeDefined();
    expect(parsed["petstore"]).toBeDefined();
  });

  test("derive k8s --out - dispatches to the k8s handler", async () => {
    const k8sYaml = [
      "apiVersion: v1",
      "kind: Service",
      "metadata: { name: svc, namespace: default }",
      "spec:",
      "  selector: { app: demo }",
      "  ports: [{ port: 8080, targetPort: 8080 }]",
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata: { name: dep, namespace: default }",
      "spec:",
      "  selector: { matchLabels: { app: demo } }",
      "  template:",
      "    metadata:",
      "      labels:",
      "        app: demo",
      "        cyanotype.component: demo",
      "    spec:",
      "      containers: [{ name: c, image: demo:1, ports: [{ containerPort: 8080 }] }]",
      "",
    ].join("\n");
    const k8sPath = tmpFile("dispatch-k8s.yaml", k8sYaml);
    const proc = Bun.spawn(
      ["bun", cli, "derive", "k8s", "--k8s", k8sPath, "--out", "-"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, _stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed["demo"]).toBeDefined();
  });

  test("unknown subcommand exits 2 with usage", async () => {
    const proc = Bun.spawn(["bun", cli, "derive", "nope", "--out", "-"], {
      stdout: "pipe", stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("Usage:");
  });

  test("compose subcommand without --compose exits 2", async () => {
    const proc = Bun.spawn(["bun", cli, "derive", "compose", "--out", "-"], {
      stdout: "pipe", stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--compose is required");
  });
});
