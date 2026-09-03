import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  renderPrompt, runClaude, findSkill, readSkillBody,
  IMPLEMENT_SKILL, IMPLEMENT_TIMEOUT_MS, READ_ONLY_TOOLS,
} from "./claude.js";
import * as git from "./git.js";
import { claimSubtask, describeClaim } from "./jira.js";
import { createDraftPr } from "./github.js";
import { spin, stopSpinner, formatDuration } from "./spinner.js";
import { addUsage, emptyUsage, formatUsage, formatUsageTotal, type Usage } from "./usage.js";
import type { Base, Outcome, RunContext, Subtask } from "./types.js";

const BRANCH_SCHEMA = {
  type: "object",
  properties: {
    branchName: { type: "string" },
    notes: { type: "string" },
  },
  required: ["branchName"],
} as const;

const PR_SCHEMA = {
  type: "object",
  properties: {
    commitMessage: { type: "string" },
    prTitle: { type: "string" },
    prBody: { type: "string" },
  },
  required: ["commitMessage", "prTitle", "prBody"],
} as const;

const say = (line = ""): void => console.log(line);
const step = (icon: string, text: string): void => console.log(`   ${icon}  ${text}`);
const detail = (text: string): void => console.log(`      ${text}`);

/**
 * One ready subtask = one isolated workflow.
 *
 * Every phase below is a SEPARATE `claude` process with its own fresh context, and none of them
 * outlives this function:
 *
 *   branch name (repo, read-only) -> claim (Jira only) -> implement (worktree, full tools)
 *   -> PR text (read-only)
 *
 * No phase ever inherits another's context. The only things that cross a phase boundary are
 * files on disk: the handoff document and the diff.
 *
 * `base` is what this subtask is built on — the run's base branch, or the branch of the subtask
 * it was planned to stack on.
 */
export async function runSubtask(
  ctx: RunContext,
  subtask: Subtask,
  handoffPath: string,
  base: Base,
): Promise<Outcome> {
  const dir = path.join(ctx.runDir, subtask.key);
  const worktree = path.join(dir, "worktree");
  const artifacts = path.join(dir, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const started = Date.now();
  let usage = emptyUsage();
  const account = (u: Usage): void => {
    usage = addUsage(usage, u);
    detail(`└ ${formatUsage(u)}`);
  };

  say();
  say("━".repeat(72));
  say(`🧩  ${subtask.key}  ${subtask.summary}`);
  say(`    ${subtask.url}`);
  say("━".repeat(72));

  // Set once step C has created the branch. Only a branch this run made is ours to remove.
  let ownsBranch = false;

  /**
   * A failure must not poison the retry. Step C creates the subtask branch as a side effect, and
   * the branch-name agent asks for the same name next time, so a branch left behind here makes
   * every re-run of this subtask die at the pre-flight check in step B. Delete it — but only when
   * it is ours and carries no commits, so real work is never thrown away.
   */
  const fail = async (reason: string, branch: string | null): Promise<Outcome> => {
    stopSpinner();
    let leftover = branch;
    if (branch && ownsBranch) {
      try {
        if ((await git.commitsAhead(ctx.repoPath, branch, base.sha)) === 0) {
          // The worktree still has the branch checked out; git will not delete it until it lets go.
          await git.detachWorktree(worktree, base.sha);
          await git.deleteBranch(ctx.repoPath, branch);
          leftover = null;
        }
      } catch {
        // Best effort: a housekeeping hiccup must not mask the failure that got us here.
      }
    }
    step("❌", `${subtask.key} failed after ${formatDuration(Date.now() - started)}`);
    detail(reason.split("\n")[0] ?? reason);
    if (branch && !leftover) detail(`branch ${branch} deleted — it had no commits, so re-running is safe`);
    detail(`worktree preserved: ${worktree}`);
    detail(`└ ${formatUsageTotal(usage, "subtask")}`);
    return { kind: "failed", subtask, reason, branch: leftover, worktree, usage };
  };

  // --- Step A: worktree, pinned to whatever this subtask builds on ---------
  step("🌱", base.dependsOn ? `worktree from ${base.branch} (stacked on ${base.dependsOn})` : `worktree from ${base.sha.slice(0, 10)}`);
  detail(worktree);
  await git.addDetachedWorktree(ctx.repoPath, worktree, base.sha);
  detail(`handoff: ${handoffPath}`);
  // The repo's own hooks must still run, and a repo-relative core.hooksPath does not survive the
  // move into a worktree. Resolved once here, passed to every command that fires a hook.
  const hooksPath = await git.absoluteHooksPath(ctx.repoPath);
  if (hooksPath) detail(`hooks: ${hooksPath}`);

  // --- Step B: branch name from repository conventions (its own context) ----
  const spBranch = spin("🧭", "reading repository branch conventions…");
  const branchPrompt = await renderPrompt("branch-name.md", {
    SUBTASK_KEY: subtask.key,
    SUBTASK_SUMMARY: subtask.summary,
  });
  const branchRes = await runClaude({
    prompt: branchPrompt,
    cwd: worktree,
    disallowedTools: READ_ONLY_TOOLS,
    addDirs: [artifacts],
    jsonSchema: BRANCH_SCHEMA,
    model: ctx.model,
  });
  spBranch.stop();
  account(branchRes.usage);
  await writeFile(path.join(artifacts, "branch-name.json"), branchRes.raw);

  const b = (branchRes.structured ?? {}) as Record<string, unknown>;
  const branchName = typeof b["branchName"] === "string" ? b["branchName"].trim() : "";
  if (!branchName) return fail("branch-name agent returned no branch name", null);
  if (!(await git.isValidBranchName(ctx.repoPath, branchName))) {
    return fail(`branch-name agent returned an invalid git branch name: ${branchName}`, null);
  }
  // A name collision is usually this subtask's own debris: an earlier run created the branch and
  // died before committing to it. Since the name is what the branch-name agent just paid to
  // produce, an empty leftover is taken over rather than treated as fatal. A branch with commits
  // on it is somebody's work and always stops the run.
  if (await git.branchExists(ctx.repoPath, branchName)) {
    const ahead = await git.commitsAhead(ctx.repoPath, branchName, base.sha);
    if (ahead > 0) {
      return fail(
        `branch already exists in the target repository and carries ${ahead} commit(s) of work: ${branchName}`,
        branchName,
      );
    }
    const holder = await git.worktreeForBranch(ctx.repoPath, branchName);
    if (holder) {
      return fail(`branch ${branchName} already exists and is checked out in ${holder}`, branchName);
    }
    try {
      await git.deleteBranch(ctx.repoPath, branchName);
      detail(`reclaimed ${branchName} — an earlier run left it behind with no commits`);
    } catch (err) {
      return fail(`branch ${branchName} already exists and could not be reclaimed: ${(err as Error).message}`, branchName);
    }
  }
  detail(`branch: ${branchName}`);

  // --- Step C: create the branch (harness owns the side effect) -------------
  await git.createBranch(worktree, branchName);
  ownsBranch = true;

  if (ctx.dryRun) {
    step("🛑", "--dry-run: stopping before implementation (Jira untouched)");
    return { kind: "skipped", subtask, reason: `dry run — handoff OK, branch ${branchName} not implemented`, usage };
  }

  // --- Step D: claim the Jira subtask (three REST calls, never fatal) -------
  const spClaim = spin("📌", "Jira — assigning to you and moving to In Progress…");
  try {
    const claim = await claimSubtask({ cfg: ctx.jira, subtask, user: ctx.jiraUser });
    const ok = claim.assigned && claim.transitioned;
    spClaim.stop(ok ? "📌" : "⚠️ ", `Jira — ${describeClaim(claim)}`);
    if (claim.note) detail(claim.note);
  } catch (err) {
    // Never fatal: a Jira workflow hiccup must not block the engineering work.
    spClaim.stop("⚠️ ", `Jira — could not assign/transition: ${(err as Error).message.split("\n")[0]}`);
  }

  // --- Step E: implement, in a context that has seen nothing but the handoff ---
  // The skill is read here, not at startup, so the text that runs is the text on disk right now.
  const skillPath = await findSkill(IMPLEMENT_SKILL, ctx.repoPath);
  if (!skillPath) return fail(`the \`${IMPLEMENT_SKILL}\` skill is no longer installed`, branchName);
  const spImpl = spin("🛠️ ", `${IMPLEMENT_SKILL} — tests, typecheck, self-review, commit…`);
  const implStarted = Date.now();
  const implementPrompt = await renderPrompt("implement.md", {
    IMPLEMENT_SKILL: await readSkillBody(skillPath),
    IMPLEMENT_SKILL_NAME: IMPLEMENT_SKILL,
    SKILL_PATH: skillPath,
    SUBTASK_KEY: subtask.key,
    SUBTASK_URL: subtask.url,
    BRANCH_NAME: branchName,
    BASE_SHA: base.sha,
    HANDOFF_PATH: handoffPath,
  });
  const impl = await runClaude({
    prompt: implementPrompt,
    cwd: worktree,
    // The implementer owns its own tests, typecheck, review and commit, so it needs a shell.
    // It is confined to a throwaway worktree and cannot push or open a PR.
    addDirs: [artifacts],
    model: ctx.model,
    timeoutMs: IMPLEMENT_TIMEOUT_MS,
  });
  spImpl.stop("🛠️ ", `${IMPLEMENT_SKILL} finished in ${formatDuration(Date.now() - implStarted)}`);
  detail(`skill: ${skillPath}`);
  account(impl.usage);
  await writeFile(path.join(artifacts, "implement.json"), impl.raw);
  // Exactly what the implementer was told, skill text included.
  await writeFile(path.join(artifacts, "implement-prompt.md"), implementPrompt);

  await git.stageAll(worktree);
  const files = await git.changedFiles(worktree, base.sha);
  if (files.length === 0) return fail(`${IMPLEMENT_SKILL} produced no changes`, branchName);
  const commits = await git.commitsSince(worktree, base.sha);
  detail(`${files.length} file(s) changed · ${commits} commit(s) by the implementer`);

  const diff = await git.diffFromBase(worktree, base.sha);
  const diffPath = path.join(artifacts, "diff.patch");
  await writeFile(diffPath, diff);

  // --- Step F: PR text from repository conventions (fresh context) ----------
  const spPr = spin("📝", "preparing PR text from repository conventions…");
  const prPrompt = await renderPrompt("prepare-pr.md", {
    SUBTASK_URL: subtask.url,
    SUBTASK_KEY: subtask.key,
    BRANCH_NAME: branchName,
    DIFF_PATH: diffPath,
    HANDOFF_PATH: handoffPath,
  });
  const prMeta = await runClaude({
    prompt: prPrompt,
    cwd: worktree,
    disallowedTools: READ_ONLY_TOOLS,
    addDirs: [artifacts],
    jsonSchema: PR_SCHEMA,
    model: ctx.model,
  });
  spPr.stop("📝", "PR text prepared from repository conventions");
  account(prMeta.usage);
  await writeFile(path.join(artifacts, "prepare-pr.json"), prMeta.raw);
  const m = (prMeta.structured ?? {}) as Record<string, unknown>;
  const commitMessage = typeof m["commitMessage"] === "string" ? m["commitMessage"].trim() : "";
  const prTitle = typeof m["prTitle"] === "string" ? m["prTitle"].trim() : "";
  const prBody = typeof m["prBody"] === "string" ? m["prBody"] : "";
  if (!commitMessage || !prTitle) return fail("PR text agent returned incomplete output", branchName);

  // --- Step G: sweep up anything /implement left uncommitted ----------------
  if (await git.hasStagedChanges(worktree)) {
    const msgPath = path.join(artifacts, "commit-message.txt");
    await writeFile(msgPath, `${commitMessage}\n`);
    try {
      await git.commit(worktree, msgPath, hooksPath);
      detail("committed leftover uncommitted changes");
    } catch (err) {
      return fail(`commit failed: ${(err as Error).message}`, branchName);
    }
  }

  // --- Step H: push (only this branch, never forced) ------------------------
  try {
    const remote = await git.defaultRemote(ctx.repoPath);
    const spPush = spin("⬆️ ", `pushing ${branchName} → ${remote}…`);
    await git.pushBranch(worktree, remote, branchName, hooksPath);
    spPush.stop("⬆️ ", `pushed ${branchName} → ${remote}`);
  } catch (err) {
    return fail(`push failed: ${(err as Error).message}`, branchName);
  }

  // --- Step I: Draft PR -----------------------------------------------------
  try {
    const bodyPath = path.join(artifacts, "pr-body.md");
    await writeFile(bodyPath, prBody);
    const spDraft = spin("🎉", "creating Draft Pull Request…");
    const prUrl = await createDraftPr({
      cwd: worktree,
      title: prTitle,
      bodyFile: bodyPath,
      head: branchName,
      base: base.branch,
    });
    spDraft.stop("🎉", `Draft PR created — ${subtask.key} done in ${formatDuration(Date.now() - started)}`);
    detail(`${prUrl}  →  ${base.branch}`);
    detail(`└ ${formatUsageTotal(usage, "subtask")}`);
    return { kind: "pr", subtask, base, prUrl, branch: branchName, worktree, usage };
  } catch (err) {
    return fail((err as Error).message, branchName);
  }
}
