import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as git from "../src/git.js";
import { execShell } from "../src/proc.js";
import { applySweep, describeSweep, findLeftovers, planSweep } from "../src/fresh.js";

/**
 * Smoke test for the git side of the workflow.
 * Uses a throwaway repository in a temp dir. It never touches a real repository,
 * never calls Jira or Claude, never pushes, and never creates a pull request.
 */
test("isolated worktrees all branch from the same BASE_SHA", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-tickets-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execShell(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'echo base > file.txt && git add -A && git commit -qm base',
    repo,
    60_000,
  );

  assert.equal(await git.isGitRepo(repo), true);
  assert.equal(await git.isGitRepo(root), false);
  const baseSha = await git.headSha(repo);
  assert.equal(await git.currentBranch(repo), "main");

  assert.equal(await git.isValidBranchName(repo, "a11y/RAD-1001-button-name"), true);
  assert.equal(await git.isValidBranchName(repo, "bad branch name"), false);
  assert.equal(await git.branchExists(repo, "main"), true);
  assert.equal(await git.branchExists(repo, "a11y/RAD-1001"), false);

  // Two subtasks, two worktrees, both pinned to BASE_SHA.
  for (const key of ["RAD-1001", "RAD-1002"]) {
    const wt = path.join(root, key, "worktree");
    await git.addDetachedWorktree(repo, wt, baseSha);
    await git.createBranch(wt, `a11y/${key}`);
    await writeFile(path.join(wt, `${key}.txt`), `${key}\n`);
    await git.stageAll(wt);

    // The diff sees new files, and only this subtask's file.
    const files = await git.changedFiles(wt, baseSha);
    assert.deepEqual(files, [`${key}.txt`]);
    assert.match(await git.diffFromBase(wt, baseSha), new RegExp(key));

    assert.equal(await git.hasStagedChanges(wt), true);
    const msg = path.join(root, key, "msg.txt");
    await writeFile(msg, `fix(a11y): ${key}\n`);
    assert.equal(await git.commitsSince(wt, baseSha), 0);
    await git.commit(wt, msg);
    assert.equal(await git.hasStagedChanges(wt), false);
    // What the harness reports as "N commit(s) by the implementer".
    assert.equal(await git.commitsSince(wt, baseSha), 1);
  }

  // RAD-1002 must not contain RAD-1001's change.
  const wt2 = path.join(root, "RAD-1002", "worktree");
  assert.deepEqual(await git.changedFiles(wt2, baseSha), ["RAD-1002.txt"]);

  // The user's original working tree is untouched and still on BASE_SHA.
  assert.equal(await git.currentBranch(repo), "main");
  assert.equal(await git.headSha(repo), baseSha);
});

/**
 * Stacking: a subtask that depends on another starts from that branch's head, so its worktree
 * contains the earlier work — but its own diff and PR still show only its own change.
 */
test("a stacked worktree contains the earlier subtask's work but not its diff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-tickets-stack-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execShell(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'echo base > file.txt && git add -A && git commit -qm base',
    repo,
    60_000,
  );
  const baseSha = await git.headSha(repo);

  // RAD-1001 builds the shared primitive.
  const first = path.join(root, "RAD-1001", "worktree");
  await git.addDetachedWorktree(repo, first, baseSha);
  await git.createBranch(first, "a11y/RAD-1001");
  await writeFile(path.join(first, "primitive.ts"), "export const IconButton = 1;\n");
  await git.stageAll(first);
  const msg1 = path.join(root, "msg1.txt");
  await writeFile(msg1, "feat: primitive\n");
  await git.commit(first, msg1);

  // RAD-1002 consumes it, so it starts from RAD-1001's head, not from BASE_SHA.
  const stackedBase = await git.branchHeadSha(repo, "a11y/RAD-1001");
  assert.notEqual(stackedBase, baseSha);
  const second = path.join(root, "RAD-1002", "worktree");
  await git.addDetachedWorktree(repo, second, stackedBase);
  await git.createBranch(second, "a11y/RAD-1002");

  // The earlier subtask's work is present to build on.
  assert.equal(await readFile(path.join(second, "primitive.ts"), "utf8"), "export const IconButton = 1;\n");

  await writeFile(path.join(second, "player.ts"), "import './primitive';\n");
  await git.stageAll(second);

  // …but the diff the reviewer sees is only this subtask's change.
  assert.deepEqual(await git.changedFiles(second, stackedBase), ["player.ts"]);
  assert.equal(await git.commitsSince(second, stackedBase), 0);
  // Measured from the run base instead, it would wrongly include RAD-1001's file.
  assert.deepEqual((await git.changedFiles(second, baseSha)).sort(), ["player.ts", "primitive.ts"]);
});

/**
 * What a failed run leaves behind. Step C creates the subtask branch as a side effect, so a run
 * that dies afterwards must not leave a branch that blocks its own retry — unless the branch
 * carries commits, which are somebody's work and never disposable.
 */
test("an abandoned branch with no commits is disposable; one with commits is not", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-tickets-leftover-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execShell(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'echo base > file.txt && git add -A && git commit -qm base',
    repo,
    60_000,
  );
  const baseSha = await git.headSha(repo);

  // A run that died right after step C: branch created, nothing committed.
  const empty = path.join(root, "RAD-2001", "worktree");
  await git.addDetachedWorktree(repo, empty, baseSha);
  await git.createBranch(empty, "a11y/RAD-2001");
  assert.equal(await git.commitsAhead(repo, "a11y/RAD-2001", baseSha), 0);

  // Git will not delete a branch a worktree is sitting on, so the harness must be told who holds it.
  assert.notEqual(await git.worktreeForBranch(repo, "a11y/RAD-2001"), null);
  await assert.rejects(git.deleteBranch(repo, "a11y/RAD-2001"));

  // Detaching the worktree releases the branch; the worktree itself survives for inspection.
  await git.detachWorktree(empty, baseSha);
  assert.equal(await git.worktreeForBranch(repo, "a11y/RAD-2001"), null);
  await git.deleteBranch(repo, "a11y/RAD-2001");
  assert.equal(await git.branchExists(repo, "a11y/RAD-2001"), false);
  assert.equal(await git.isGitRepo(empty), true);

  // The same name is now free, which is what makes the retry work.
  await git.createBranch(empty, "a11y/RAD-2001");
  assert.equal(await git.branchExists(repo, "a11y/RAD-2001"), true);

  // A branch the implementer did commit to stays put: commitsAhead is what tells them apart.
  const done = path.join(root, "RAD-2002", "worktree");
  await git.addDetachedWorktree(repo, done, baseSha);
  await git.createBranch(done, "a11y/RAD-2002");
  await writeFile(path.join(done, "RAD-2002.txt"), "work\n");
  await git.stageAll(done);
  const msg = path.join(root, "RAD-2002", "msg.txt");
  await writeFile(msg, "fix(a11y): RAD-2002\n");
  await git.commit(done, msg);
  assert.equal(await git.commitsAhead(repo, "a11y/RAD-2002", baseSha), 1);
});

/**
 * `--fresh` between test runs. The line that matters is the one between debris and work: an empty
 * branch can always go, a branch with commits needs `--fresh-force` and says so.
 */
test("--fresh clears a subtask's debris but never its commits without --fresh-force", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-tickets-fresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execShell(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'echo base > file.txt && git add -A && git commit -qm base',
    repo,
    60_000,
  );
  const baseSha = await git.headSha(repo);

  // Debris from a run that died early: a branch with nothing on it, plus its worktree.
  const debris = path.join(root, "RAD-3001", "worktree");
  await git.addDetachedWorktree(repo, debris, baseSha);
  await git.createBranch(debris, "a11y/RAD-3001/first-try");

  // A second attempt that got further and committed 50 minutes of work.
  const real = path.join(root, "RAD-3001-second", "worktree");
  await git.addDetachedWorktree(repo, real, baseSha);
  await git.createBranch(real, "a11y/RAD-3001/second-try");
  await writeFile(path.join(real, "work.txt"), "expensive\n");
  await git.stageAll(real);
  const msg = path.join(root, "msg.txt");
  await writeFile(msg, "fix(a11y): RAD-3001\n");
  await git.commit(real, msg);

  // An unrelated subtask must be left completely alone.
  const other = path.join(root, "RAD-9999", "worktree");
  await git.addDetachedWorktree(repo, other, baseSha);
  await git.createBranch(other, "a11y/RAD-9999/untouched");

  const leftovers = await findLeftovers(repo, ["RAD-3001"], baseSha);
  const plan = planSweep(leftovers);
  assert.deepEqual(plan.empty.map((b) => b.name), ["a11y/RAD-3001/first-try"]);
  assert.deepEqual(plan.withWork.map((b) => b.name), ["a11y/RAD-3001/second-try"]);
  assert.equal(plan.withWork[0]!.ahead, 1);
  assert.equal(plan.worktrees.length, 2);

  // The warning has to name the cost before anyone reads past it.
  const kept = describeSweep(plan, { force: false, dryRun: false });
  assert.ok(kept.some((l) => /keeping branch.*second-try.*--fresh-force/.test(l)), kept.join("\n"));
  assert.ok(
    describeSweep(plan, { force: true, dryRun: false }).some((l) => /DESTROYING WORK/.test(l)),
  );
  // A dry run describes, it does not act.
  assert.ok(describeSweep(plan, { force: false, dryRun: true }).every((l) => !l.startsWith("removing")));

  // Plain --fresh: debris and worktrees go, the commit stays.
  const swept = await applySweep(repo, plan, { force: false });
  assert.deepEqual(swept.errors, []);
  assert.deepEqual(swept.removedBranches.map((b) => b.name), ["a11y/RAD-3001/first-try"]);
  assert.equal(swept.removedWorktrees.length, 2);
  assert.equal(await git.branchExists(repo, "a11y/RAD-3001/first-try"), false);
  assert.equal(await git.branchExists(repo, "a11y/RAD-3001/second-try"), true);

  // The unrelated subtask survived untouched, branch and worktree.
  assert.equal(await git.branchExists(repo, "a11y/RAD-9999/untouched"), true);
  assert.notEqual(await git.worktreeForBranch(repo, "a11y/RAD-9999/untouched"), null);

  // --fresh-force finishes the job, so the same name is free again.
  const forced = await applySweep(repo, planSweep(await findLeftovers(repo, ["RAD-3001"], baseSha)), {
    force: true,
  });
  assert.deepEqual(forced.errors, []);
  assert.equal(await git.branchExists(repo, "a11y/RAD-3001/second-try"), false);
});

test("branchesForKey finds every attempt at one subtask, whatever the agent named them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-tickets-keys-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execShell(
    'git init -q -b main && git config user.email t@t && git config user.name t && ' +
      'echo base > file.txt && git add -A && git commit -qm base && ' +
      'git branch pstanecki/fix/RAD-85352/a11y-accessible-name && ' +
      'git branch pstanecki/fix/RAD-85352/label-in-name && ' +
      'git branch pstanecki/feat/RAD-85361/aria-live-status',
    repo,
    60_000,
  );
  const baseSha = await git.headSha(repo);

  // Three runs, three different agent-chosen names, one subtask.
  const found = await git.branchesForKey(repo, "RAD-85352", baseSha);
  assert.deepEqual(found.map((b) => b.name).sort(), [
    "pstanecki/fix/RAD-85352/a11y-accessible-name",
    "pstanecki/fix/RAD-85352/label-in-name",
  ]);
  assert.ok(found.every((b) => b.ahead === 0));
  // Case-insensitive, and no accidental matches on a neighbouring key.
  assert.equal((await git.branchesForKey(repo, "rad-85361", baseSha)).length, 1);
  assert.deepEqual(await git.branchesForKey(repo, "RAD-00000", baseSha), []);
});
