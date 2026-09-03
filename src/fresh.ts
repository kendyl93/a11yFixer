/**
 * `--fresh`: clear a subtask's leftovers so a re-run starts from nothing.
 *
 * Why this exists: while iterating on ship-tickets itself, every failed run can leave a branch and
 * a worktree behind, and the next run trips over them. Cleaning that up by hand between attempts
 * is the kind of friction that makes a harness unpleasant to develop against.
 *
 * The safety line is drawn at commits, not at intent:
 *   - A branch with no commits beyond BASE_SHA holds nothing. Deleting it cannot lose work, so
 *     plain `--fresh` does it.
 *   - A branch with commits is somebody's engineering — possibly a 50-minute implementation. It is
 *     reported and kept, and only `--fresh-force` will delete it, printing the sha it destroyed so
 *     the run's own log tells you what to recover from the reflog.
 */

import * as git from "./git.js";

export type Leftover = {
  key: string;
  branches: git.BranchInfo[];
  worktrees: string[];
};

export type SweepPlan = {
  /** Branches with no commits: always safe to remove. */
  empty: git.BranchInfo[];
  /** Branches carrying commits: removed only under --fresh-force. */
  withWork: git.BranchInfo[];
  /** Worktree directories belonging to these subtasks. */
  worktrees: string[];
};

/**
 * What is lying around for these subtask keys.
 *
 * A worktree counts as belonging to a subtask when its path mentions the key — every worktree this
 * harness creates lives under `<runDir>/<KEY>/worktree` — or when it has one of the subtask's
 * branches checked out, which is what stops git from deleting that branch.
 */
export async function findLeftovers(repo: string, keys: string[], baseSha: string): Promise<Leftover[]> {
  const worktrees = await git.listWorktrees(repo);
  const main = worktrees[0]?.path;
  const out: Leftover[] = [];

  for (const key of keys) {
    const branches = await git.branchesForKey(repo, key, baseSha);
    const names = new Set(branches.map((b) => b.name));
    const mine = worktrees
      // Never the main working tree: that is the user's own checkout.
      .filter((w) => w.path !== main)
      .filter((w) => w.path.toUpperCase().includes(key.toUpperCase()) || (w.branch && names.has(w.branch)))
      .map((w) => w.path);
    if (branches.length || mine.length) out.push({ key, branches, worktrees: mine });
  }
  return out;
}

export function planSweep(leftovers: Leftover[]): SweepPlan {
  return {
    empty: leftovers.flatMap((l) => l.branches.filter((b) => b.ahead === 0)),
    withWork: leftovers.flatMap((l) => l.branches.filter((b) => b.ahead > 0)),
    worktrees: leftovers.flatMap((l) => l.worktrees),
  };
}

export type SweepResult = {
  removedBranches: git.BranchInfo[];
  removedWorktrees: string[];
  keptBranches: git.BranchInfo[];
  /** Anything git refused, so a partial sweep is never reported as a clean one. */
  errors: string[];
};

/**
 * Apply a sweep. Worktrees go first: git will not delete a branch that a worktree still has
 * checked out, so removing the directories is what makes the branch deletions possible.
 */
export async function applySweep(
  repo: string,
  plan: SweepPlan,
  opts: { force: boolean },
): Promise<SweepResult> {
  const result: SweepResult = { removedBranches: [], removedWorktrees: [], keptBranches: [], errors: [] };

  for (const path of plan.worktrees) {
    try {
      await git.removeWorktree(repo, path);
      result.removedWorktrees.push(path);
    } catch (err) {
      result.errors.push(`worktree ${path}: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  const targets = opts.force ? [...plan.empty, ...plan.withWork] : plan.empty;
  if (!opts.force) result.keptBranches = plan.withWork;

  for (const branch of targets) {
    try {
      await git.deleteBranch(repo, branch.name);
      result.removedBranches.push(branch);
    } catch (err) {
      result.errors.push(`branch ${branch.name}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return result;
}

/** The lines the CLI prints. Kept here so the wording is testable without running a sweep. */
export function describeSweep(plan: SweepPlan, opts: { force: boolean; dryRun: boolean }): string[] {
  const lines: string[] = [];
  const verb = opts.dryRun ? "would remove" : "removing";

  for (const w of plan.worktrees) lines.push(`${verb} worktree  ${w}`);
  for (const b of plan.empty) lines.push(`${verb} branch    ${b.name}  (no commits)`);

  for (const b of plan.withWork) {
    lines.push(
      opts.force
        ? `${verb} branch    ${b.name}  (${b.ahead} commit(s) — DESTROYING WORK, recover from reflog at ${b.sha.slice(0, 10)})`
        : `keeping branch      ${b.name}  (${b.ahead} commit(s) of work — pass --fresh-force to delete)`,
    );
  }
  return lines;
}
