import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as git from "../src/git.js";
import { execShell } from "../src/proc.js";

/**
 * Smoke test for the git side of the workflow.
 * Uses a throwaway repository in a temp dir. It never touches a real repository,
 * never calls Jira or Claude, never pushes, and never creates a pull request.
 */
test("isolated worktrees all branch from the same BASE_SHA", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "a11yfixer-smoke-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "a11yfixer-stack-"));
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
