import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderPrompt, runClaude, READ_ONLY_TOOLS, EDIT_NO_SHELL_TOOLS } from "./claude.js";
import { execShell } from "./proc.js";
import * as git from "./git.js";
import { claimSubtask, describeClaim } from "./discovery.js";
import { createDraftPr } from "./github.js";
import { spin, stopSpinner, formatDuration } from "./spinner.js";
import { addUsage, emptyUsage, formatUsage, formatUsageTotal, type Usage } from "./usage.js";
import type { CommandResult, Outcome, RunContext, Subtask, Verdict } from "./types.js";

const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_PER_COMMAND = 20_000;

const BOOTSTRAP_SCHEMA = {
  type: "object",
  properties: {
    branchName: { type: "string" },
    verificationCommands: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["branchName", "verificationCommands"],
} as const;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL", "MANUAL_REVIEW_REQUIRED"] },
    explanation: { type: "string" },
  },
  required: ["verdict", "explanation"],
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

export function parseVerdict(structured: unknown): { verdict: Verdict; explanation: string } {
  const d = (structured ?? {}) as Record<string, unknown>;
  const raw = String(d["verdict"] ?? "").trim().toUpperCase();
  const verdict: Verdict =
    raw === "PASS" || raw === "FAIL" || raw === "MANUAL_REVIEW_REQUIRED" ? raw : "MANUAL_REVIEW_REQUIRED";
  const explanation = typeof d["explanation"] === "string" ? d["explanation"].trim() : "";
  return { verdict, explanation: explanation || "(reviewer gave no explanation)" };
}

export function verdictIcon(verdict: Verdict): string {
  if (verdict === "PASS") return "✅";
  if (verdict === "FAIL") return "❌";
  return "👀";
}

function clip(text: string, max = MAX_OUTPUT_PER_COMMAND): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** Full failure detail for the repair agent. */
export function formatFailures(results: CommandResult[]): string {
  return results
    .filter((r) => r.exitCode !== 0)
    .map(
      (r) =>
        `### command: ${r.command}\nexit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n` +
        `--- stdout ---\n${clip(r.stdout).trim() || "(empty)"}\n` +
        `--- stderr ---\n${clip(r.stderr).trim() || "(empty)"}`,
    )
    .join("\n\n");
}

function formatResults(results: CommandResult[]): string {
  if (results.length === 0) return "Deterministic verification: UNAVAILABLE (repository documented no discoverable commands).";
  return results.map((r) => `${r.exitCode === 0 ? "PASS" : "FAIL"} (exit ${r.exitCode}): ${r.command}`).join("\n");
}

const say = (line = ""): void => console.log(line);
const step = (icon: string, text: string): void => console.log(`   ${icon}  ${text}`);
const detail = (text: string): void => console.log(`      ${text}`);

async function runVerification(commands: string[], cwd: string): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const sp = spin("   ⋯", command);
    const r = await execShell(command, cwd, VERIFY_TIMEOUT_MS);
    results.push({ command, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut });
    sp.stop(r.exitCode === 0 ? "   ✓" : "   ✗");
    if (r.exitCode !== 0) {
      const tail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-12).join("\n");
      if (tail) console.log(tail.replace(/^/gm, "         │ "));
    }
  }
  return results;
}

/**
 * One Jira subtask = one isolated workflow.
 * Implementation context (A), review context (B) and PR-prep context (C) are separate
 * Claude sessions, and none of them outlive this function.
 */
export async function runSubtask(ctx: RunContext, subtask: Subtask): Promise<Outcome> {
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

  const fail = (reason: string, branch: string | null, verdict?: Verdict): Outcome => {
    stopSpinner();
    step("❌", `${subtask.key} failed after ${formatDuration(Date.now() - started)}`);
    detail(reason.split("\n")[0] ?? reason);
    detail(`worktree preserved: ${worktree}`);
    detail(`└ ${formatUsageTotal(usage, "subtask")}`);
    return { kind: "failed", subtask, reason, branch, worktree, verdict, usage };
  };

  // --- Step A: detached worktree pinned to BASE_SHA -------------------------
  step("🌱", `worktree from ${ctx.baseSha.slice(0, 10)}`);
  detail(worktree);
  await git.addDetachedWorktree(ctx.repoPath, worktree, ctx.baseSha);

  // --- Step B: bootstrap (implementation context A begins) ------------------
  const spBootstrap = spin("🧭", "bootstrap — reading repository instructions…");
  const bootstrapPrompt = await renderPrompt("bootstrap.md", {
    SUBTASK_URL: subtask.url,
    SUBTASK_KEY: subtask.key,
    BASE_SHA: ctx.baseSha,
    BASE_BRANCH: ctx.baseBranch,
  });
  const bootstrap = await runClaude({
    prompt: bootstrapPrompt,
    cwd: worktree,
    disallowedTools: EDIT_NO_SHELL_TOOLS,
    jsonSchema: BOOTSTRAP_SCHEMA,
    model: ctx.model,
  });
  spBootstrap.stop();
  account(bootstrap.usage);
  await writeFile(path.join(artifacts, "bootstrap.json"), bootstrap.raw);

  const implSession = bootstrap.sessionId;
  const b = (bootstrap.structured ?? {}) as Record<string, unknown>;
  const branchName = typeof b["branchName"] === "string" ? b["branchName"].trim() : "";
  const verificationCommands = Array.isArray(b["verificationCommands"])
    ? (b["verificationCommands"] as unknown[]).filter((c): c is string => typeof c === "string" && c.trim() !== "")
    : [];

  if (!branchName) return fail("bootstrap agent returned no branch name", null);
  if (!(await git.isValidBranchName(ctx.repoPath, branchName))) {
    return fail(`bootstrap agent returned an invalid git branch name: ${branchName}`, null);
  }
  if (await git.branchExists(ctx.repoPath, branchName)) {
    return fail(`branch already exists in the target repository: ${branchName}`, branchName);
  }

  detail(`branch:       ${branchName}`);
  detail(
    verificationCommands.length
      ? `verification: ${verificationCommands.length} command(s) from repository conventions`
      : "verification: none discoverable in repository documentation",
  );
  for (const c of verificationCommands) detail(`              · ${c}`);

  // --- Step C: create the branch (harness owns the side effect) -------------
  await git.createBranch(worktree, branchName);

  if (ctx.dryRun) {
    step("🛑", "--dry-run: stopping before implementation (Jira untouched)");
    return { kind: "skipped", subtask, reason: `dry run — branch ${branchName} created, no code written`, usage };
  }

  // --- Claim the Jira subtask, immediately before any code is written -------
  const spClaim = spin("📌", "Jira — assigning to you and moving to In Progress…");
  try {
    const { claim, usage: claimUsage } = await claimSubtask({ subtask, cwd: worktree, model: ctx.model });
    const ok = claim.assigned && claim.transitioned;
    spClaim.stop(ok ? "📌" : "⚠️ ", `Jira — ${describeClaim(claim)}`);
    if (claim.note) detail(claim.note);
    account(claimUsage);
  } catch (err) {
    // Never fatal: a Jira workflow hiccup must not block the engineering work.
    spClaim.stop("⚠️ ", `Jira — could not assign/transition: ${(err as Error).message.split("\n")[0]}`);
  }

  // --- Step D: implement (same context A) ----------------------------------
  const spImpl = spin("🛠️ ", "implementing…");
  const implStarted = Date.now();
  const implementPrompt = await renderPrompt("implement.md", {
    SUBTASK_KEY: subtask.key,
    BRANCH_NAME: branchName,
  });
  const impl = await runClaude({
    prompt: implementPrompt,
    cwd: worktree,
    resume: implSession,
    disallowedTools: EDIT_NO_SHELL_TOOLS,
    model: ctx.model,
  });
  spImpl.stop();
  account(impl.usage);
  await writeFile(path.join(artifacts, "implement.json"), impl.raw);

  await git.stageAll(worktree);
  let files = await git.changedFiles(worktree, ctx.baseSha);
  if (files.length === 0) return fail("implementation produced no changes", branchName);
  detail(`${files.length} file(s) changed   (${formatDuration(Date.now() - implStarted)})`);

  // --- Step E: deterministic verification (harness owns execution) ----------
  if (verificationCommands.length) step("🧪", "verification");
  else step("🧪", "verification unavailable — no commands documented");
  let results = await runVerification(verificationCommands, worktree);

  // --- Step F: exactly one repair attempt ----------------------------------
  if (results.some((r) => r.exitCode !== 0)) {
    const spRepair = spin("🔁", "repair attempt (1 of 1)…");
    const repairPrompt = await renderPrompt("repair.md", {
      SUBTASK_KEY: subtask.key,
      FAILURES: formatFailures(results),
    });
    const repair = await runClaude({
      prompt: repairPrompt,
      cwd: worktree,
      resume: implSession,
      disallowedTools: EDIT_NO_SHELL_TOOLS,
      model: ctx.model,
    });
    spRepair.stop("🔁", "repair attempt (1 of 1)");
    account(repair.usage);
    await writeFile(path.join(artifacts, "repair.json"), repair.raw);

    await git.stageAll(worktree);
    files = await git.changedFiles(worktree, ctx.baseSha);
    results = await runVerification(verificationCommands, worktree);
    if (results.some((r) => r.exitCode !== 0)) {
      return fail("deterministic verification failed after one repair attempt", branchName);
    }
  }
  // Implementation context A is now dead. Nothing below reuses implSession.

  // --- Step G: independent review (fresh context B) -------------------------
  const diff = await git.diffFromBase(worktree, ctx.baseSha);
  const diffPath = path.join(artifacts, "diff.patch");
  await writeFile(diffPath, diff);
  await writeFile(path.join(artifacts, "verification.txt"), formatResults(results));

  const spReview = spin("🔎", "independent review (fresh context)…");
  const reviewPrompt = await renderPrompt("review.md", {
    SUBTASK_URL: subtask.url,
    SUBTASK_KEY: subtask.key,
    BASE_SHA: ctx.baseSha,
    BRANCH_NAME: branchName,
    DIFF_PATH: diffPath,
    CHANGED_FILES: files.join("\n"),
    VERIFICATION_RESULTS: formatResults(results),
  });
  const reviewRes = await runClaude({
    prompt: reviewPrompt,
    cwd: worktree,
    disallowedTools: READ_ONLY_TOOLS,
    addDirs: [artifacts],
    jsonSchema: REVIEW_SCHEMA,
    model: ctx.model,
  });
  spReview.stop("🔎", "independent review (fresh context)");
  account(reviewRes.usage);
  await writeFile(path.join(artifacts, "review.json"), reviewRes.raw);
  const { verdict, explanation } = parseVerdict(reviewRes.structured);
  detail(`${verdictIcon(verdict)} ${verdict}`);
  detail(explanation.split("\n")[0] ?? "");

  // --- Step H ---------------------------------------------------------------
  if (verdict === "FAIL") return fail(`reviewer FAIL: ${explanation}`, branchName, verdict);

  // --- Step I: PR metadata from repository conventions (fresh context C) ----
  const spPr = spin("📝", "preparing commit & PR metadata from repository conventions…");
  const prPrompt = await renderPrompt("prepare-pr.md", {
    SUBTASK_URL: subtask.url,
    SUBTASK_KEY: subtask.key,
    BRANCH_NAME: branchName,
    DIFF_PATH: diffPath,
    CHANGED_FILES: files.join("\n"),
    MANUAL_REVIEW_NOTE:
      verdict === "MANUAL_REVIEW_REQUIRED"
        ? `The independent reviewer returned MANUAL_REVIEW_REQUIRED with this explanation:\n${explanation}\n` +
          `Surface this to human reviewers in whatever way the repository's PR conventions allow.`
        : "The independent reviewer returned PASS. No extra reviewer note is required.",
  });
  const prMeta = await runClaude({
    prompt: prPrompt,
    cwd: worktree,
    disallowedTools: READ_ONLY_TOOLS,
    addDirs: [artifacts],
    jsonSchema: PR_SCHEMA,
    model: ctx.model,
  });
  spPr.stop("📝", "commit & PR metadata prepared from repository conventions");
  account(prMeta.usage);
  await writeFile(path.join(artifacts, "prepare-pr.json"), prMeta.raw);
  const m = (prMeta.structured ?? {}) as Record<string, unknown>;
  const commitMessage = typeof m["commitMessage"] === "string" ? m["commitMessage"].trim() : "";
  const prTitle = typeof m["prTitle"] === "string" ? m["prTitle"].trim() : "";
  const prBody = typeof m["prBody"] === "string" ? m["prBody"] : "";
  if (!commitMessage || !prTitle) return fail("PR metadata agent returned incomplete output", branchName, verdict);

  // --- Step J: commit (harness owns the side effect) ------------------------
  await git.stageAll(worktree);
  if (await git.hasStagedChanges(worktree)) {
    const msgPath = path.join(artifacts, "commit-message.txt");
    await writeFile(msgPath, `${commitMessage}\n`);
    try {
      await git.commit(worktree, msgPath);
    } catch (err) {
      return fail(`commit failed: ${(err as Error).message}`, branchName, verdict);
    }
  }

  // --- Step K: push (only this branch, never forced) ------------------------
  let remote: string;
  try {
    remote = await git.defaultRemote(ctx.repoPath);
    const spPush = spin("⬆️ ", `pushing ${branchName} → ${remote}…`);
    await git.pushBranch(worktree, remote, branchName);
    spPush.stop("⬆️ ", `pushed ${branchName} → ${remote}`);
  } catch (err) {
    return fail(`push failed: ${(err as Error).message}`, branchName, verdict);
  }

  // --- Step L: Draft PR -----------------------------------------------------
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
    return { kind: "pr", subtask, verdict, prUrl, branch: branchName, worktree, usage };
  } catch (err) {
    return fail((err as Error).message, branchName, verdict);
  }
}
