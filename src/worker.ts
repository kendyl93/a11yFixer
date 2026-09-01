import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderPrompt, runClaude, isUnknownCommand, IMPLEMENT_SKILL, IMPLEMENT_TIMEOUT_MS, READ_ONLY_TOOLS } from "./claude.js";
import * as git from "./git.js";
import { claimSubtask, describeClaim, fetchHandoff, HANDOFF_MARKER } from "./jira.js";
import { createDraftPr } from "./github.js";
import { spin, stopSpinner, formatDuration } from "./spinner.js";
import { addUsage, emptyUsage, formatUsage, formatUsageTotal, type Usage } from "./usage.js";
import type { Outcome, RunContext, Subtask } from "./types.js";

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
 *   handoff (Jira only) -> branch name (repo, read-only) -> claim (Jira only)
 *   -> /implement (worktree, full tools) -> PR text (read-only)
 *
 * No phase ever inherits another's context. The only things that cross a phase boundary are
 * files on disk: the handoff document and the diff.
 */
export async function runSubtask(ctx: RunContext, subtask: Subtask, readyLabel: string): Promise<Outcome> {
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

  const fail = (reason: string, branch: string | null): Outcome => {
    stopSpinner();
    step("❌", `${subtask.key} failed after ${formatDuration(Date.now() - started)}`);
    detail(reason.split("\n")[0] ?? reason);
    detail(`worktree preserved: ${worktree}`);
    detail(`└ ${formatUsageTotal(usage, "subtask")}`);
    return { kind: "failed", subtask, reason, branch, worktree, usage };
  };

  // --- Step A: detached worktree pinned to BASE_SHA -------------------------
  step("🌱", `worktree from ${ctx.baseSha.slice(0, 10)}`);
  detail(worktree);
  await git.addDetachedWorktree(ctx.repoPath, worktree, ctx.baseSha);

  // --- Step B: the human's handoff, fetched and validated before anything else ---
  const handoffPath = path.join(artifacts, `${subtask.key}.handoff.md`);
  const spHandoff = spin("📖", `reading the ${HANDOFF_MARKER} comment on ${subtask.key}…`);
  const { result: handoff, usage: handoffUsage } = await fetchHandoff({
    subtask,
    readyLabel,
    cwd: worktree,
    model: ctx.model,
    jiraTool: ctx.jiraTool,
  });
  usage = addUsage(usage, handoffUsage);
  if (!handoff.ok) {
    spHandoff.stop("❌", `no usable handoff on ${subtask.key}`);
    return fail(
      `handoff unusable: ${handoff.error}. ${subtask.key} is labelled \`${readyLabel}\` but carries no ` +
        `\`${HANDOFF_MARKER}\` comment — refusing to implement from the ticket summary alone.`,
      null,
    );
  }
  await writeFile(handoffPath, handoff.markdown);
  spHandoff.stop("📖", `handoff read — ${handoff.markdown.length} chars`);
  detail(handoffPath);
  detail(`└ ${formatUsage(handoffUsage)}`);

  // --- Step C: branch name from repository conventions (its own context) ----
  const spBranch = spin("🧭", "reading repository branch conventions…");
  const branchPrompt = await renderPrompt("branch-name.md", {
    SUBTASK_KEY: subtask.key,
    SUBTASK_SUMMARY: subtask.summary,
    BASE_BRANCH: ctx.baseBranch,
    HANDOFF_PATH: handoffPath,
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
  if (await git.branchExists(ctx.repoPath, branchName)) {
    return fail(`branch already exists in the target repository: ${branchName}`, branchName);
  }
  detail(`branch: ${branchName}`);

  // --- Step D: create the branch (harness owns the side effect) -------------
  await git.createBranch(worktree, branchName);

  if (ctx.dryRun) {
    step("🛑", "--dry-run: stopping before implementation (Jira untouched)");
    return { kind: "skipped", subtask, reason: `dry run — handoff OK, branch ${branchName} not implemented`, usage };
  }

  // --- Step E: claim the Jira subtask (its own context, never fatal) --------
  const spClaim = spin("📌", "Jira — assigning to you and moving to In Progress…");
  try {
    const { claim, usage: claimUsage } = await claimSubtask({
      subtask,
      cwd: worktree,
      model: ctx.model,
      jiraTool: ctx.jiraTool,
    });
    const ok = claim.assigned && claim.transitioned;
    spClaim.stop(ok ? "📌" : "⚠️ ", `Jira — ${describeClaim(claim)}`);
    if (claim.note) detail(claim.note);
    account(claimUsage);
  } catch (err) {
    // Never fatal: a Jira workflow hiccup must not block the engineering work.
    spClaim.stop("⚠️ ", `Jira — could not assign/transition: ${(err as Error).message.split("\n")[0]}`);
  }

  // --- Step F: /implement, in a context that has seen nothing but the handoff ---
  const spImpl = spin("🛠️ ", `/implement ${subtask.key} — tests, typecheck, self-review, commit…`);
  const implStarted = Date.now();
  const implementPrompt = await renderPrompt("implement.md", {
    SUBTASK_KEY: subtask.key,
    SUBTASK_URL: subtask.url,
    BRANCH_NAME: branchName,
    BASE_SHA: ctx.baseSha,
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
  spImpl.stop("🛠️ ", `/implement finished in ${formatDuration(Date.now() - implStarted)}`);
  account(impl.usage);
  await writeFile(path.join(artifacts, "implement.json"), impl.raw);

  // The skill was there at startup; if it vanished mid-run the session is a successful no-op.
  if (isUnknownCommand(impl.text)) {
    return fail(`the \`${IMPLEMENT_SKILL}\` skill did not resolve: ${impl.text.trim()}`, branchName);
  }

  await git.stageAll(worktree);
  const files = await git.changedFiles(worktree, ctx.baseSha);
  if (files.length === 0) return fail("/implement produced no changes", branchName);
  const commits = await git.commitsSince(worktree, ctx.baseSha);
  detail(`${files.length} file(s) changed · ${commits} commit(s) by the implementer`);

  const diff = await git.diffFromBase(worktree, ctx.baseSha);
  const diffPath = path.join(artifacts, "diff.patch");
  await writeFile(diffPath, diff);

  // --- Step G: PR text from repository conventions (fresh context) ----------
  const spPr = spin("📝", "preparing PR text from repository conventions…");
  const prPrompt = await renderPrompt("prepare-pr.md", {
    SUBTASK_URL: subtask.url,
    SUBTASK_KEY: subtask.key,
    BRANCH_NAME: branchName,
    DIFF_PATH: diffPath,
    HANDOFF_PATH: handoffPath,
    CHANGED_FILES: files.join("\n"),
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

  // --- Step H: sweep up anything /implement left uncommitted ----------------
  if (await git.hasStagedChanges(worktree)) {
    const msgPath = path.join(artifacts, "commit-message.txt");
    await writeFile(msgPath, `${commitMessage}\n`);
    try {
      await git.commit(worktree, msgPath);
      detail("committed leftover uncommitted changes");
    } catch (err) {
      return fail(`commit failed: ${(err as Error).message}`, branchName);
    }
  }

  // --- Step I: push (only this branch, never forced) ------------------------
  try {
    const remote = await git.defaultRemote(ctx.repoPath);
    const spPush = spin("⬆️ ", `pushing ${branchName} → ${remote}…`);
    await git.pushBranch(worktree, remote, branchName);
    spPush.stop("⬆️ ", `pushed ${branchName} → ${remote}`);
  } catch (err) {
    return fail(`push failed: ${(err as Error).message}`, branchName);
  }

  // --- Step J: Draft PR -----------------------------------------------------
  try {
    const bodyPath = path.join(artifacts, "pr-body.md");
    await writeFile(bodyPath, prBody);
    const spDraft = spin("🎉", "creating Draft Pull Request…");
    const prUrl = await createDraftPr({
      cwd: worktree,
      title: prTitle,
      bodyFile: bodyPath,
      head: branchName,
      base: ctx.baseBranch,
    });
    spDraft.stop("🎉", `Draft PR created — ${subtask.key} done in ${formatDuration(Date.now() - started)}`);
    detail(prUrl);
    detail(`└ ${formatUsageTotal(usage, "subtask")}`);
    return { kind: "pr", subtask, prUrl, branch: branchName, worktree, usage };
  } catch (err) {
    return fail((err as Error).message, branchName);
  }
}
