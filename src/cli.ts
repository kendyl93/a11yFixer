import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandExists } from "./proc.js";
import { findSkill, IMPLEMENT_SKILL } from "./claude.js";
import * as git from "./git.js";
import { checkGh, defaultBranch } from "./github.js";
import {
  surveySubtasks,
  fetchHandoff,
  planOrder,
  HANDOFF_MARKER,
  isUnavailable,
  hasLabel,
  parseJiraKey,
  DEFAULT_READY_LABEL,
} from "./jira.js";
import { resolveJiraConfig, whoAmI, type JiraConfig, type JiraUser } from "./jira-api.js";
import { applySweep, describeSweep, findLeftovers, planSweep } from "./fresh.js";
import { runSubtask } from "./worker.js";
import { printSummary } from "./report.js";
import { spin, stopSpinner } from "./spinner.js";
import { addUsage, emptyUsage, formatUsage } from "./usage.js";
import type { Base, Outcome, RunContext } from "./types.js";

export type Args = {
  parentUrl: string;
  repo: string;
  label: string;
  model: string | null;
  dryRun: boolean;
  allowMissingToken: boolean;
  /** Clear this parent's leftover branches and worktrees before running. */
  fresh: boolean;
  /** …including branches that carry commits. Implies `fresh`. */
  freshForce: boolean;
};

export function parseArgs(argv: string[]): Args {
  let parentUrl = "";
  let repo = "";
  let label = DEFAULT_READY_LABEL;
  let model: string | null = null;
  let dryRun = false;
  let allowMissingToken = false;
  let fresh = false;
  let freshForce = false;

  for (let i = 0; i < argv.length; i++) {
    const a = (argv[i] as string).trim();
    // A stray backslash or pasted shell decoration produces empty args; ignore rather than choke.
    if (a === "" || a === "\\") continue;
    if (a === "--repo") repo = (argv[++i] ?? "").trim();
    else if (a === "--label") label = (argv[++i] ?? "").trim();
    else if (a === "--model") model = (argv[++i] ?? "").trim() || null;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-missing-token") allowMissingToken = true;
    else if (a === "--fresh") fresh = true;
    // --fresh-force is the only way to destroy committed work, so it is spelled out in full.
    else if (a === "--fresh-force") { fresh = true; freshForce = true; }
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else if (!parentUrl) parentUrl = a;
    else {
      throw new Error(
        `unexpected argument: "${a}"\n` +
          `  Received: ${argv.map((x) => JSON.stringify(x)).join(" ")}\n` +
          "  If you pasted a multi-line command, your shell prompt decoration may have been\n" +
          "  pasted with it. Try the single-line form:\n" +
          "    npm run ship-tickets -- <jira-url> --repo <path> --dry-run",
      );
    }
  }

  if (!parentUrl) throw new Error("missing parent Jira URL");
  if (!parseJiraKey(parentUrl)) throw new Error(`could not parse a Jira issue key from: ${parentUrl}`);
  if (!repo) throw new Error("missing --repo <path to target repository>");
  if (!label) throw new Error("--label must not be empty");

  return { parentUrl, repo, label, model, dryRun, allowMissingToken, fresh, freshForce };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Everything that can be checked cheaply, checked before a single agent session is spawned.
 *
 * Jira belongs here now that it is plain HTTP: `whoAmI` proves the site, the email and the token
 * all agree in one request, so a credential problem costs a second instead of surfacing after
 * minutes of paid work.
 */
async function validate(args: Args): Promise<{ repo: string; cfg: JiraConfig; user: JiraUser }> {
  const repo = path.resolve(expandHome(args.repo));

  const dir = await stat(repo).catch(() => null);
  if (!dir?.isDirectory()) throw new Error(`target repository path does not exist: ${repo}`);
  if (!(await git.isGitRepo(repo))) throw new Error(`not a git repository: ${repo}`);
  if (!(await commandExists("git"))) throw new Error("`git` not found on PATH");
  if (!(await commandExists("claude"))) throw new Error("`claude` CLI not found on PATH");

  if (!process.env["CLAUDE_CODE_OAUTH_TOKEN"] && !args.allowMissingToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is not set.\n" +
        "  Run `claude setup-token`, then `export CLAUDE_CODE_OAUTH_TOKEN=\"...\"`.\n" +
        "  If this machine is already authenticated interactively, pass --allow-missing-token.",
    );
  }

  if (!(await findSkill(IMPLEMENT_SKILL, repo))) {
    throw new Error(
      `the \`${IMPLEMENT_SKILL}\` skill is not installed.\n` +
        "  ship-tickets does not implement anything itself — it runs that skill.\n" +
        "  Install it from https://github.com/mattpocock/skills, or drop a SKILL.md at\n" +
        `  ~/.claude/skills/${IMPLEMENT_SKILL}/SKILL.md`,
    );
  }

  const ghError = await checkGh();
  if (ghError) throw new Error(ghError);

  const cfg = await resolveJiraConfig({ parentUrl: args.parentUrl, repo });
  let user: JiraUser;
  try {
    user = await whoAmI(cfg);
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\n` +
        `  Jira site:  ${cfg.baseUrl}\n` +
        `  Jira email: ${cfg.email}`,
    );
  }
  return { repo, cfg, user };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { repo, cfg, user } = await validate(args);
  const parentKey = parseJiraKey(args.parentUrl) as string;

  // Freeze the base revision. Every subtask branch starts from exactly this commit.
  const baseSha = await git.headSha(repo);
  const baseBranch = (await git.currentBranch(repo)) ?? (await defaultBranch(repo));
  if (!baseBranch) throw new Error("could not determine a base branch for pull requests");

  const runDir = path.join(
    os.tmpdir(),
    "ship-tickets",
    `${path.basename(repo)}-${parentKey}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(runDir, { recursive: true });

  console.log("");
  console.log("═".repeat(72));
  console.log(`🔧  ship-tickets${args.dryRun ? "   (dry run — no code, no Jira changes, no PRs)" : ""}`);
  console.log("═".repeat(72));
  console.log(`    repo        ${repo}`);
  console.log(`    base        ${baseBranch} @ ${baseSha.slice(0, 10)}`);
  console.log(`    label       ${args.label}`);
  console.log(`    jira        ${cfg.baseUrl}  as ${user.displayName || user.email}`);
  console.log(`    run dir     ${runDir}`);
  console.log("");
  const runStarted = Date.now();

  // Phase 1: two REST calls. Retried internally, so a transient Jira fault costs a second.
  const spSurvey = spin("🔍", `looking for subtasks of ${parentKey} labelled \`${args.label}\`…`);
  const survey = await surveySubtasks({ cfg, parentKey }).catch((err: Error) => {
    spSurvey.stop("❌", `could not read ${parentKey} from Jira`);
    throw err;
  });
  spSurvey.stop("🔍", `read ${parentKey} and its ${survey.subtasks.length} subtask(s) from Jira`);

  const labelled = survey.subtasks.filter((s) => hasLabel(s, args.label));
  const ready = labelled.filter((s) => !isUnavailable(s.status));

  console.log("");
  console.log(`📋  Parent: ${survey.parent.key}  ${survey.parent.summary}`);
  console.log("");
  console.log(`    ${survey.subtasks.length} subtask(s), ${labelled.length} labelled \`${args.label}\`, ${ready.length} available`);
  console.log("");
  for (const s of survey.subtasks) {
    const mark = hasLabel(s, args.label) ? "✅" : "  ";
    console.log(`    ${mark}  ${s.key}  ${s.summary}${s.status ? `  [${s.status}]` : ""}`);
    if (!hasLabel(s, args.label) && s.labels.length) console.log(`           labels: ${s.labels.join(", ")}`);
  }
  console.log("");

  if (ready.length === 0) {
    console.log(`ℹ️   Nothing to do. Label a subtask \`${args.label}\` and paste your grilling output`);
    console.log(`    into it as a comment under a \`${HANDOFF_MARKER}\` heading, then run this again.`);
    return;
  }

  console.log(`ℹ️   Only labelled subtasks are implemented, and only from their \`${HANDOFF_MARKER}\` comment.`);
  if (!args.dryRun) {
    console.log("ℹ️   Each subtask is assigned to you and moved to In Progress right before its code is written.");
  }

  // --fresh: clear this parent's leftovers before anything is spent. Runs after the survey,
  // because the subtask keys are what identify the debris, and before any agent, because a
  // collision the sweep would have fixed must never cost a session.
  if (args.fresh) {
    const leftovers = await findLeftovers(repo, ready.map((s) => s.key), baseSha);
    const plan = planSweep(leftovers);
    const lines = describeSweep(plan, { force: args.freshForce, dryRun: args.dryRun });
    console.log("");
    if (lines.length === 0) {
      console.log("🧹  --fresh: nothing left over for these subtasks");
    } else {
      console.log(`🧹  --fresh${args.freshForce ? "-force" : ""}`);
      console.log("");
      for (const line of lines) console.log(`    ${line}`);
      if (!args.dryRun) {
        const swept = await applySweep(repo, plan, { force: args.freshForce });
        console.log("");
        console.log(
          `    removed ${swept.removedBranches.length} branch(es), ` +
            `${swept.removedWorktrees.length} worktree(s)` +
            (swept.keptBranches.length ? `, kept ${swept.keptBranches.length} carrying work` : ""),
        );
        // A sweep that half-worked must not read as a clean slate.
        for (const err of swept.errors) console.log(`    ⚠️  ${err}`);
      }
    }
    console.log("");
  }

  const ctx: RunContext = {
    repoPath: repo,
    baseSha,
    baseBranch,
    runDir,
    model: args.model,
    dryRun: args.dryRun,
    jira: cfg,
    jiraUser: user,
  };

  const outcomes: Outcome[] = [];
  for (const s of labelled) {
    if (!isUnavailable(s.status)) continue;
    console.log(`\n⏭️   ${s.key}  skipped — status is ${s.status}, already past implementation`);
    outcomes.push({ kind: "skipped", subtask: s, reason: `status is ${s.status}` });
  }

  // Every handoff is read and validated BEFORE any Jira issue is claimed or any code is written,
  // because the order they get built in depends on what they say.
  const handoffPaths = new Map<string, string>();
  const buildable: typeof ready = [];
  for (const subtask of ready) {
    const artifacts = path.join(runDir, subtask.key, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const handoffPath = path.join(artifacts, `${subtask.key}.handoff.md`);
    const sp = spin("📖", `reading the ${HANDOFF_MARKER} comment on ${subtask.key}…`);
    const result = await fetchHandoff({ cfg, subtask }).catch(
      (err: Error) => ({ ok: false as const, error: err.message }),
    );
    if (!result.ok) {
      sp.stop("❌", `${subtask.key} — no usable handoff`);
      const reason =
        `handoff unusable: ${result.error}. ${subtask.key} is labelled \`${args.label}\` but carries no ` +
        `\`${HANDOFF_MARKER}\` comment — refusing to implement from the ticket summary alone.`;
      console.log(`      ${reason.split(".")[0]}.`);
      outcomes.push({ kind: "failed", subtask, reason, branch: null, worktree: null });
      continue;
    }
    await writeFile(handoffPath, result.markdown);
    sp.stop("📖", `${subtask.key} — handoff read, ${result.markdown.length} chars, by ${result.author}`);
    handoffPaths.set(subtask.key, handoffPath);
    buildable.push(subtask);
  }
  if (buildable.length === 0) {
    printSummary(survey.parent.key, args.label, ready.length, outcomes, emptyUsage(), Date.now() - runStarted);
    return;
  }

  // One subtask needs no plan; more than one might stack.
  let plan = buildable.map((s) => ({ key: s.key, dependsOn: null as string | null, reason: "" }));
  let planUsage = emptyUsage();
  if (buildable.length > 1) {
    const spPlan = spin("🧮", "planning implementation order from the handoffs…");
    const planned = await planOrder({
      ready: buildable,
      handoffPaths,
      cwd: repo,
      addDirs: [runDir],
      model: args.model,
    });
    plan = planned.plan;
    planUsage = planned.usage;
    spPlan.stop("🧮", "implementation order planned");
    console.log(`      └ ${formatUsage(planUsage)}`);
  }

  console.log("");
  console.log("🧮  Order");
  console.log("");
  for (const [i, stepPlan] of plan.entries()) {
    const on = stepPlan.dependsOn ? `  ⤷ stacked on ${stepPlan.dependsOn}` : "";
    console.log(`    ${i + 1}. ${stepPlan.key}${on}`);
    if (stepPlan.reason) console.log(`       ${stepPlan.reason}`);
  }
  console.log("");

  const byKey = new Map(buildable.map((s) => [s.key, s]));
  // What each completed subtask left behind for the next one to build on.
  const built = new Map<string, { branch: string; sha: string }>();

  for (const stepPlan of plan) {
    const subtask = byKey.get(stepPlan.key);
    if (!subtask) continue;

    let base: Base = { sha: baseSha, branch: baseBranch, dependsOn: null };
    if (stepPlan.dependsOn) {
      const parent = built.get(stepPlan.dependsOn);
      if (!parent) {
        // Stacking is a chain: if the subtask underneath never produced a branch, this one has
        // nothing to sit on, and building it from the base branch would silently drop the
        // dependency the plan said it has.
        const reason = `stranded — depends on ${stepPlan.dependsOn}, which produced no branch`;
        console.log(`\n⏭️   ${subtask.key}  skipped — ${reason}`);
        outcomes.push({ kind: "skipped", subtask, reason });
        continue;
      }
      base = { sha: parent.sha, branch: parent.branch, dependsOn: stepPlan.dependsOn };
    }

    try {
      const outcome = await runSubtask(ctx, subtask, handoffPaths.get(subtask.key) as string, base);
      outcomes.push(outcome);
      if (outcome.kind === "pr") {
        built.set(subtask.key, { branch: outcome.branch, sha: await git.branchHeadSha(repo, outcome.branch) });
      }
    } catch (err) {
      // One failed subtask must not stop the rest of the run.
      stopSpinner();
      const reason = (err as Error).message;
      console.log(`   ❌  ${subtask.key} failed: ${reason.split("\n")[0]}`);
      outcomes.push({
        kind: "failed",
        subtask,
        reason,
        branch: null,
        worktree: path.join(runDir, subtask.key, "worktree"),
      });
    }
  }

  const runUsage = outcomes.reduce(
    (total, o) => (o.usage ? addUsage(total, o.usage) : total),
    // The survey and the handoff reads are plain HTTP now and cost nothing to account for.
    addUsage(emptyUsage(), planUsage),
  );
  printSummary(survey.parent.key, args.label, ready.length, outcomes, runUsage, Date.now() - runStarted);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main().catch((err: Error) => {
    stopSpinner();
    console.error(`\n❌  ship-tickets: ${err.message}`);
    process.exit(1);
  });
}
