import { exec, commandExists } from "./proc.js";

const GH_TIMEOUT_MS = 3 * 60 * 1000;

export async function checkGh(): Promise<string | null> {
  if (!(await commandExists("gh"))) return "`gh` CLI not found on PATH";
  const r = await exec("gh", ["auth", "status"], { timeoutMs: 60_000 });
  if (r.exitCode !== 0) return "`gh` is not authenticated — run `gh auth login`";
  return null;
}

export async function defaultBranch(cwd: string): Promise<string | null> {
  const r = await exec("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], {
    cwd,
    timeoutMs: 60_000,
  });
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function createDraftPr(opts: {
  cwd: string;
  title: string;
  bodyFile: string;
  head: string;
  base: string;
}): Promise<string> {
  const r = await exec(
    "gh",
    ["pr", "create", "--draft", "--title", opts.title, "--body-file", opts.bodyFile, "--head", opts.head, "--base", opts.base],
    { cwd: opts.cwd, timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) {
    throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  }
  const url = r.stdout.trim().split("\n").filter((l) => l.startsWith("http")).pop();
  if (!url) throw new Error(`gh pr create returned no URL: ${r.stdout.trim().slice(0, 300)}`);
  return url;
}
