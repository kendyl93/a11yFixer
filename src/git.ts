import { exec } from "./proc.js";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const r = await exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return r.exitCode === 0;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return gitOk(dir, ["rev-parse", "--git-dir"]);
}

export async function headSha(repo: string): Promise<string> {
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Branch currently checked out in the target repo, or null when detached. */
export async function currentBranch(repo: string): Promise<string | null> {
  const name = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return name === "HEAD" ? null : name;
}

export async function isValidBranchName(repo: string, name: string): Promise<boolean> {
  if (!name || name.includes(" ")) return false;
  return gitOk(repo, ["check-ref-format", "--branch", name]);
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  return gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
}

/** Create a detached worktree pinned to baseSha. Never touches the user's working tree. */
export async function addDetachedWorktree(repo: string, worktreePath: string, baseSha: string): Promise<void> {
  await git(repo, ["worktree", "add", "--detach", worktreePath, baseSha]);
}

export async function createBranch(worktree: string, name: string): Promise<void> {
  await git(worktree, ["switch", "-c", name]);
}

export async function stageAll(worktree: string): Promise<void> {
  await git(worktree, ["add", "-A"]);
}

/** Cumulative diff from baseSha to the current staged tree (includes new files). */
export async function diffFromBase(worktree: string, baseSha: string): Promise<string> {
  return git(worktree, ["diff", "--cached", baseSha]);
}

export async function changedFiles(worktree: string, baseSha: string): Promise<string[]> {
  const out = await git(worktree, ["diff", "--cached", "--name-only", baseSha]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** True when the index differs from HEAD, i.e. there is something to commit. */
export async function hasStagedChanges(worktree: string): Promise<boolean> {
  return !(await gitOk(worktree, ["diff", "--cached", "--quiet"]));
}

export async function commit(worktree: string, messageFile: string): Promise<void> {
  await git(worktree, ["commit", "-F", messageFile]);
}

export async function defaultRemote(repo: string): Promise<string> {
  const out = await git(repo, ["remote"]);
  const remotes = out.split("\n").map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) throw new Error("target repository has no git remote");
  return remotes.includes("origin") ? "origin" : (remotes[0] as string);
}

/** Push only this subtask branch. No force, ever. */
export async function pushBranch(worktree: string, remote: string, branch: string): Promise<void> {
  await git(worktree, ["push", "--set-upstream", remote, `${branch}:${branch}`]);
}

/** How many commits the implementation agent made on top of the base revision. */
export async function commitsSince(worktree: string, baseSha: string): Promise<number> {
  const out = await git(worktree, ["rev-list", "--count", `${baseSha}..HEAD`]);
  return Number.parseInt(out, 10) || 0;
}
