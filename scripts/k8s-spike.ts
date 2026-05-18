// Spike: Bun.spawn driving kubectl as the K8s adapter substrate.
// Tests JSON RPC, port-forward subprocess lifecycle, and log streaming.

import net from 'node:net';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const CTX = 'orbstack';
const NS = 'kube-system';

// CAP-1: list pods via `kubectl get -o json`, pick a Running pod with a TCP container port
async function cap1(): Promise<{ pod: string; container: string; port: number } | null> {
  const proc = Bun.spawn(['kubectl', '--context', CTX, '-n', NS, 'get', 'pods', '-o', 'json'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    console.log(`[CAP-1] FAIL — kubectl exit ${exit}`);
    return null;
  }
  const json = JSON.parse(out);
  // Pick first Running pod that has at least one TCP container port
  for (const item of json.items as any[]) {
    if (item.status?.phase !== 'Running') continue;
    for (const c of item.spec?.containers ?? []) {
      const ports = (c.ports ?? []).filter((p: any) => (p.protocol ?? 'TCP') === 'TCP');
      if (ports.length > 0) {
        const r = { pod: item.metadata.name, container: c.name, port: ports[0].containerPort };
        console.log(`[CAP-1] PASS — ${json.items.length} pods, target=${r.pod}/${r.container}:${r.port}`);
        return r;
      }
    }
  }
  console.log('[CAP-1] FAIL — no Running pod with a TCP container port');
  return null;
}

// CAP-2: `kubectl get pod <name>` exit code 0 = exists. The exists() pattern.
async function cap2(pod: string): Promise<void> {
  const proc = Bun.spawn(['kubectl', '--context', CTX, '-n', NS, 'get', 'pod', pod, '-o', 'name'], {
    stdout: 'ignore', stderr: 'ignore',
  });
  const exit = await proc.exited;
  console.log(`[CAP-2] ${exit === 0 ? 'PASS' : 'FAIL'} — readPod exit=${exit}`);
}

// CAP-3: spawn `kubectl port-forward`, parse local port from stdout, do 10 TCP connects
async function cap3(pod: string, port: number): Promise<void> {
  const proc = Bun.spawn(
    ['kubectl', '--context', CTX, '-n', NS, 'port-forward', `pod/${pod}`, `:${port}`],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  // Parse "Forwarding from 127.0.0.1:NNNNN -> NNNN"
  const rl = readline.createInterface({ input: Readable.fromWeb(proc.stdout as any) });
  let hostPort: number | null = null;
  const portPromise = new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('port-forward did not become ready in 5s')), 5000);
    rl.on('line', (line) => {
      const m = line.match(/Forwarding from 127\.0\.0\.1:(\d+) ->/);
      if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
    });
  });

  try {
    hostPort = await portPromise;
  } catch (e) {
    console.log(`[CAP-3] FAIL — ${(e as Error).message}`);
    proc.kill();
    await proc.exited;
    return;
  }

  // 10 sequential TCP connect attempts
  let okCount = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const c = net.connect(hostPort!, '127.0.0.1');
        const t = setTimeout(() => { c.destroy(); reject(new Error('timeout 3s')); }, 3000);
        c.on('connect', () => { clearTimeout(t); c.end(); resolve(); });
        c.on('error', (err) => { clearTimeout(t); reject(err); });
      });
      okCount++;
    } catch (e) {
      console.error(`  conn ${i} failed:`, (e as Error).message);
    }
  }

  proc.kill();
  await proc.exited;
  console.log(`[CAP-3] ${okCount === 10 ? 'PASS' : okCount > 0 ? 'PARTIAL' : 'FAIL'} — ${okCount}/10 connections via local port ${hostPort}`);
}

// CAP-4: `kubectl logs -f --tail=5` for 3 seconds, count lines
async function cap4(pod: string, container: string): Promise<void> {
  const proc = Bun.spawn(
    ['kubectl', '--context', CTX, '-n', NS, 'logs', '-f', '--tail=5', '-c', container, pod],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const rl = readline.createInterface({ input: Readable.fromWeb(proc.stdout as any) });
  const lines: string[] = [];
  rl.on('line', (l) => lines.push(l));
  await new Promise((r) => setTimeout(r, 3000));
  proc.kill();
  await proc.exited;
  rl.close();
  console.log(`[CAP-4] ${lines.length > 0 ? 'PASS' : 'FAIL'} — ${lines.length} lines in 3s`);
}

// --- run sequentially ---
const target = await cap1();
if (target) {
  await cap2(target.pod);
  await cap3(target.pod, target.port);
  await cap4(target.pod, target.container);
}
process.exit(0);
