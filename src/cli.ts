import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandExists } from "./proc.js";
import * as git from "./git.js";
import { checkGh, defaultBranch } from "./github.js";
import { discoverSubtasks, isAlreadyDone, parseJiraKey } from "./discovery.js";
import { runSubtask } from "./worker.js";
import { printSummary } from "./report.js";
import type { Outcome, RunContext } from "./types.js";

export type Args = {
  parentUrl: string;
  repo: string;
  model: string | null;
  dryRun: boolean;
  allowMissingToken: boolean;
};

export function parseArgs(argv: string[]): Args {
  let parentUrl = "";
  let repo = "";
  let model: string | null = null;
  let dryRun = false;
  let allowMissingToken = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--model") model = argv[++i] ?? null;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-missing-token") allowMissingToken = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else if (!parentUrl) parentUrl = a;
    else throw new Error(`unexpected argument: ${a}`);
  }

  if (!parentUrl) throw new Error("missing parent Jira URL");
  if (!parseJiraKey(parentUrl)) throw new Error(`could not parse a Jira issue key from: ${parentUrl}`);
  if (!repo) throw new Error("missing --repo <path to target repository>");

  return { parentUrl, repo, model, dryRun, allowMissingToken };
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
  console.log(`    run dir     ${runDir}`);
  console.log("");
  console.log(`🔍  Discovering direct subtasks of ${parentKey} via Jira MCP…`);

  const discovery = await discoverSubtasks({
    parentUrl: args.parentUrl,
    parentKey,
    cwd: repo,
    model: args.model,
  });

  console.log("");
  console.log(`📋  Parent: ${discovery.parent.key}  ${discovery.parent.summary}`);
  console.log("");
  console.log(`    Direct subtasks discovered: ${discovery.subtasks.length}`);
  console.log("");
  for (const s of discovery.subtasks) {
    console.log(`      ${s.key}  ${s.summary}${s.status ? `  [${s.status}]` : ""}`);
  }
  console.log("");
  console.log("ℹ️   Linked Jira items are NOT implementation scope.");
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
  };

  const outcomes: Outcome[] = [];
  for (const subtask of discovery.subtasks) {
    if (isAlreadyDone(subtask.status)) {
      console.log(`\n⏭️   ${subtask.key}  skipped — status is ${subtask.status}`);
      outcomes.push({ kind: "skipped", subtask, reason: `already ${subtask.status}` });
      continue;
    }
    try {
      outcomes.push(await runSubtask(ctx, subtask));
    } catch (err) {
      // One failed subtask must not stop the rest of the run.
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

  printSummary(discovery.parent.key, discovery.subtasks.length, outcomes);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main().catch((err: Error) => {
    console.error(`\n❌  a11yFixer: ${err.message}`);
    process.exit(1);
  });
}
