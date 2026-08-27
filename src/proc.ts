import { spawn } from "node:child_process";

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const MAX_CAPTURE = 2_000_000;

/** Spawn a process, capture output. Never throws on non-zero exit. */
export function exec(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      // The child inherits the environment, including CLAUDE_CODE_OAUTH_TOKEN.
      // The token is never read, logged or written by this harness.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString();
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err), timedOut });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Run a shell command line (used only for repository-supplied verification commands). */
export function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return exec("/bin/sh", ["-c", command], { cwd, timeoutMs });
}

export async function commandExists(name: string): Promise<boolean> {
  const r = await exec("/bin/sh", ["-c", `command -v ${name}`], { timeoutMs: 10_000 });
  return r.exitCode === 0;
}
