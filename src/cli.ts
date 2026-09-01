import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandExists } from "./proc.js";
import * as git from "./git.js";
import { checkGh, defaultBranch } from "./github.js";
import {
  surveySubtasks,
  isAlreadyDone,
  hasLabel,
  parseJiraKey,
  DEFAULT_JIRA_TOOL,
  DEFAULT_READY_LABEL,
  HANDOFF_MARKER,
} from "./jira.js";
import { runSubtask } from "./worker.js";
import { printSummary } from "./report.js";
import { spin, stopSpinner } from "./spinner.js";
import { addUsage, emptyUsage, formatUsage } from "./usage.js";
import type { Outcome, RunContext } from "./types.js";

export type Args = {
  parentUrl: string;
  repo: string;
  label: string;
  model: string | null;
  dryRun: boolean;
  allowMissingToken: boolean;
  jiraTool: string | null;
};

export function parseArgs(argv: string[]): Args {
  let parentUrl = "";
  let repo = "";
  let label = DEFAULT_READY_LABEL;
  let model: string | null = null;
  let dryRun = false;
  let allowMissingToken = false;
  let jiraTool: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = (argv[i] as string).trim();
    // A stray backslash or pasted shell decoration produces empty args; ignore rather than choke.
    if (a === "" || a === "\\") continue;
    if (a === "--repo") repo = (argv[++i] ?? "").trim();
    else if (a === "--label") label = (argv[++i] ?? "").trim();
    else if (a === "--model") model = (argv[++i] ?? "").trim() || null;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-missing-token") allowMissingToken = true;
    else if (a === "--jira-tool") jiraTool = (argv[++i] ?? "").trim();
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else if (!parentUrl) parentUrl = a;
    else {
      throw new Error(
        `unexpected argument: "${a}"\n` +
          `  Received: ${argv.map((x) => JSON.stringify(x)).join(" ")}\n` +
          "  If you pasted a multi-line command, your shell prompt decoration may have been\n" +
          "  pasted with it. Try the single-line form:\n" +
          "    npm run a11y-fixer -- <jira-url> --repo <path> --dry-run",
      );
    }
  }

  if (!parentUrl) throw new Error("missing parent Jira URL");
  if (!parseJiraKey(parentUrl)) throw new Error(`could not parse a Jira issue key from: ${parentUrl}`);
  if (!repo) throw new Error("missing --repo <path to target repository>");
  if (!label) throw new Error("--label must not be empty");

  if (jiraTool !== null && !/^mcp__\w+__\w+$/.test(jiraTool)) {
    throw new Error(`--jira-tool must be a full MCP tool name, e.g. ${DEFAULT_JIRA_TOOL}`);
  }

  return { parentUrl, repo, label, model, dryRun, allowMissingToken, jiraTool };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

async function validate(args: Args): Promise<string> {
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

  const ghError = await checkGh();
  if (ghError) throw new Error(ghError);

  return repo;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = await validate(args);
  const parentKey = parseJiraKey(args.parentUrl) as string;

  // Freeze the base revision. Every subtask branch starts from exactly this commit.
  const baseSha = await git.headSha(repo);
  const baseBranch = (await git.currentBranch(repo)) ?? (await defaultBranch(repo));
  if (!baseBranch) throw new Error("could not determine a base branch for pull requests");

  const runDir = path.join(
    os.tmpdir(),
    "a11y-fixer",
    `${path.basename(repo)}-${parentKey}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(runDir, { recursive: true });

  console.log("");
  console.log("═".repeat(72));
  console.log(`🔧  a11yFixer${args.dryRun ? "   (dry run — no code, no Jira changes, no PRs)" : ""}`);
  console.log("═".repeat(72));
  console.log(`    repo        ${repo}`);
  console.log(`    base        ${baseBranch} @ ${baseSha.slice(0, 10)}`);
  console.log(`    label       ${args.label}`);
  console.log(`    run dir     ${runDir}`);
  console.log("");
  const runStarted = Date.now();

  // Phase 1: the only Jira read the run makes before it knows what to work on.
  // It doubles as the Jira connection check — if this fails, nothing else runs.
  const spSurvey = spin("🔍", `looking for subtasks of ${parentKey} labelled \`${args.label}\`…`);
  let survey;
  try {
    survey = await surveySubtasks({
      parentUrl: args.parentUrl,
      parentKey,
      readyLabel: args.label,
      cwd: repo,
      model: args.model,
      jiraTool: args.jiraTool ?? DEFAULT_JIRA_TOOL,
    });
  } catch (err) {
    spSurvey.stop("❌", `could not read ${parentKey} from Jira`);
    console.log("");
    console.log("   Jira MCP must be reachable before a11yFixer can do anything useful.");
    console.log("   Check `claude mcp list` shows your Atlassian server as Connected, and that");
    console.log(`   ${parentKey} exists and is visible to your account.`);
    console.log("   If your Jira MCP server is named differently, pass --jira-tool <mcp__server__getJiraIssue>.");
    throw err;
  }
  spSurvey.stop("🔍", `read ${parentKey} and its subtasks via ${survey.jiraTool}`);
  console.log(`      └ ${formatUsage(survey.usage)}`);

  const ready = survey.subtasks.filter((s) => hasLabel(s, args.label));

  console.log("");
  console.log(`📋  Parent: ${survey.parent.key}  ${survey.parent.summary}`);
  console.log("");
  console.log(`    ${survey.subtasks.length} subtask(s), ${ready.length} labelled \`${args.label}\``);
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

  const ctx: RunContext = {
    repoPath: repo,
    baseSha,
    baseBranch,
    runDir,
    model: args.model,
    dryRun: args.dryRun,
    jiraTool: survey.jiraTool,
  };

  const outcomes: Outcome[] = [];
  for (const subtask of ready) {
    if (isAlreadyDone(subtask.status)) {
      console.log(`\n⏭️   ${subtask.key}  skipped — status is ${subtask.status}`);
      outcomes.push({ kind: "skipped", subtask, reason: `already ${subtask.status}` });
      continue;
    }
    try {
      outcomes.push(await runSubtask(ctx, subtask, args.label));
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
    addUsage(emptyUsage(), survey.usage),
  );
  printSummary(survey.parent.key, args.label, ready.length, outcomes, runUsage, Date.now() - runStarted);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main().catch((err: Error) => {
    stopSpinner();
    console.error(`\n❌  a11yFixer: ${err.message}`);
    process.exit(1);
  });
}
