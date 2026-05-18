/**
 * kubectl — internal subprocess helper for the Kubernetes adapter.
 *
 * Owns every `Bun.spawn(["kubectl", ...])` invocation in the codebase. The
 * adapter never touches `proc.stdout` directly. Centralising lets us apply
 * the attach-mode write denylist (D-018) at a single chokepoint.
 */

import readline from "node:readline";
import { Readable } from "node:stream";
import type { Subprocess } from "bun";

export type KubectlMode = "deploy" | "attach";

export type KubectlRunResult = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type KubectlStream = {
  readonly lines: AsyncIterable<string>;
  kill(): void;
  readonly exited: Promise<number>;
  readonly proc: Subprocess;
};

export type KubectlClient = {
  readonly mode: KubectlMode;
  readonly namespace: string;
  readonly context: string | undefined;
  run(args: string[], opts?: { stdin?: string }): Promise<KubectlRunResult>;
  stream(args: string[]): KubectlStream;
};

const WRITE_VERBS = new Set([
  "apply", "create", "delete", "patch", "replace", "edit", "scale", "rollout",
]);

const guardAttach = (mode: KubectlMode, args: string[]): void => {
  if (mode !== "attach") return;
  const op = args[0];
  if (op && WRITE_VERBS.has(op)) {
    throw { kind: "attach_mode_violation", op, target: args };
  }
};

const prefix = (context: string | undefined, namespace: string): string[] => {
  const out: string[] = [];
  if (context) out.push("--context", context);
  out.push("-n", namespace);
  return out;
};

export type CreateKubectlOptions = {
  readonly mode: KubectlMode;
  readonly namespace: string;
  readonly context?: string | undefined;
};

export const createKubectl = (opts: CreateKubectlOptions): KubectlClient => {
  const { mode, namespace, context } = opts;

  const run: KubectlClient["run"] = async (args, runOpts) => {
    guardAttach(mode, args);
    const argv = ["kubectl", ...prefix(context, namespace), ...args];
    const stdin = runOpts?.stdin;
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : "ignore",
    });
    if (stdin !== undefined && proc.stdin) {
      const writer = proc.stdin as unknown as { write(d: string): unknown; end(): unknown };
      writer.write(stdin);
      writer.end();
    }
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exit, stdout, stderr };
  };

  const stream: KubectlClient["stream"] = (args) => {
    guardAttach(mode, args);
    const argv = ["kubectl", ...prefix(context, namespace), ...args];
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    // biome-ignore lint/suspicious/noExplicitAny: Bun's web ReadableStream → Node Readable.fromWeb variance.
    const rl = readline.createInterface({ input: Readable.fromWeb(proc.stdout as any) });
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try { rl.close(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    };
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return rl[Symbol.asyncIterator]() as AsyncIterator<string>;
      },
    };
    return { lines, kill, exited: proc.exited, proc };
  };

  return { mode, namespace, context, run, stream };
};
