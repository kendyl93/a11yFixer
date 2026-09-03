import path from "node:path";

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

/** Output of a git command, or null when it exits non-zero. For config reads that may be unset. */
async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  const r = await exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * The repo's hooks directory as an absolute path, or null when no rewrite is needed.
 *
 * A repo-relative `core.hooksPath` is resolved by git against whichever working tree it runs in.
 * That breaks in a worktree: hook runners like husky keep their bootstrap (`.husky/_`) in ignored,
 * generated content that only exists in the checkout where `npm install` ran, so in a fresh
 * worktree the hook script dies on its first line. Resolving the path against the main working
 * tree instead lets the repository's real hooks run, against the worktree's content.
 */
export async function absoluteHooksPath(repo: string): Promise<string | null> {
  const configured = await gitOrNull(repo, ["config", "--get", "core.hooksPath"]);
  if (!configured || path.isAbsolute(configured)) return null;
  const mainWorkTree = await gitOrNull(repo, ["rev-parse", "--show-toplevel"]);
  return mainWorkTree ? path.resolve(mainWorkTree, configured) : null;
}

/** `-c core.hooksPath=…` for one command only, so no worktree ever writes shared git config. */
function withHooks(hooksPath: string | null | undefined): string[] {
  return hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : [];
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

/** Commits reachable from `name` but not from `sha`. Zero means the branch carries no work. */
export async function commitsAhead(repo: string, name: string, sha: string): Promise<number> {
  const out = await git(repo, ["rev-list", "--count", `${sha}..${name}`]);
  return Number.parseInt(out, 10) || 0;
}

/**
 * Delete a branch outright. Git refuses while a worktree still has it checked out, so callers
 * must detach that worktree first with `detachWorktree`.
 */
export async function deleteBranch(repo: string, name: string): Promise<void> {
  await git(repo, ["branch", "-D", name]);
}

/**
 * Path of the worktree that has `name` checked out, or null when no worktree holds it. Git refuses
 * to delete a branch some worktree is sitting on, so this turns that into a readable message.
 */
export async function worktreeForBranch(repo: string, name: string): Promise<string | null> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  let current: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${name}`) return current;
  }
  return null;
}

export type WorktreeEntry = { path: string; branch: string | null };

/** Every registered worktree and the branch it has checked out, main working tree included. */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

export type BranchInfo = { name: string; sha: string; ahead: number };

/**
 * Local branches whose name mentions `key`, with how far each is ahead of `sha`.
 *
 * Branch names come from an agent that reads the repository's conventions, so they are not
 * predictable between runs — the same subtask has produced three different names here. Matching
 * on the subtask key instead is the only reliable way to ask "has this one been built already?",
 * and it costs one git call rather than an agent session.
 */
export async function branchesForKey(repo: string, key: string, sha: string): Promise<BranchInfo[]> {
  const out = await git(repo, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]);
  const needle = key.toUpperCase();
  const found: BranchInfo[] = [];
  for (const line of out.split("\n")) {
    const [name, objectName] = line.trim().split(/\s+/);
    if (!name || !objectName || !name.toUpperCase().includes(needle)) continue;
    found.push({ name, sha: objectName, ahead: await commitsAhead(repo, name, sha) });
  }
  return found;
}

/** Remove a worktree registration and its directory. `--force` covers a dirty working tree. */
export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktreePath]);
}

/** Release whatever branch a worktree has checked out, pinning it back to `sha`. */
export async function detachWorktree(worktree: string, sha: string): Promise<void> {
  await git(worktree, ["switch", "--detach", sha]);
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

export async function commit(worktree: string, messageFile: string, hooksPath?: string | null): Promise<void> {
  await git(worktree, [...withHooks(hooksPath), "commit", "-F", messageFile]);
}

export async function defaultRemote(repo: string): Promise<string> {
  const out = await git(repo, ["remote"]);
  const remotes = out.split("\n").map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) throw new Error("target repository has no git remote");
  return remotes.includes("origin") ? "origin" : (remotes[0] as string);
}

/** Push only this subtask branch. No force, ever. */
export async function pushBranch(
  worktree: string,
  remote: string,
  branch: string,
  hooksPath?: string | null,
): Promise<void> {
  await git(worktree, [...withHooks(hooksPath), "push", "--set-upstream", remote, `${branch}:${branch}`]);
}

/** How many commits the implementation agent made on top of the base revision. */
export async function commitsSince(worktree: string, baseSha: string): Promise<number> {
  const out = await git(worktree, ["rev-list", "--count", `${baseSha}..HEAD`]);
  return Number.parseInt(out, 10) || 0;
}

/** Commit a branch currently points at. Used to stack one subtask's worktree on another's work. */
export async function branchHeadSha(repo: string, branch: string): Promise<string> {
  return git(repo, ["rev-parse", branch]);
}
