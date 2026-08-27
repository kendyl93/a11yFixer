import type { Outcome } from "./types.js";
import { verdictIcon } from "./worker.js";

export function printSummary(parentKey: string, discovered: number, outcomes: Outcome[]): void {
  const prs = outcomes.filter((o): o is Extract<Outcome, { kind: "pr" }> => o.kind === "pr");
  const failed = outcomes.filter((o): o is Extract<Outcome, { kind: "failed" }> => o.kind === "failed");
  const skipped = outcomes.filter((o): o is Extract<Outcome, { kind: "skipped" }> => o.kind === "skipped");

  const out: string[] = [
    "",
    "═".repeat(72),
    "🏁  a11yFixer finished",
    "═".repeat(72),
    "",
    `📋  Parent: ${parentKey}   ·   ${discovered} direct subtask(s)`,
  ];

  if (prs.length) {
    out.push("", `✅  DRAFT PRS CREATED (${prs.length})`, "");
    for (const o of prs) {
      out.push(`    ${o.subtask.key}  ${o.subtask.summary}`);
      out.push(`      ${o.prUrl}`);
      out.push(`      reviewer: ${verdictIcon(o.verdict)} ${o.verdict}`, "");
    }
  }
  if (failed.length) {
    out.push("", `❌  FAILED (${failed.length})`, "");
    for (const o of failed) {
      out.push(`    ${o.subtask.key}  ${o.subtask.summary}`);
      out.push(`      ${o.reason.split("\n")[0]}`);
      if (o.branch) out.push(`      branch:   ${o.branch}`);
      if (o.worktree) out.push(`      worktree: ${o.worktree}`);
      out.push("");
    }
  }
  if (skipped.length) {
    out.push("", `⏭️   SKIPPED (${skipped.length})`, "");
    for (const o of skipped) out.push(`    ${o.subtask.key}  —  ${o.reason}`, "");
  }

  out.push(
    "",
    "ℹ️   Linked Jira issues were not used as implementation scope.",
    "ℹ️   Nothing was merged. Every PR is a draft.",
    prs.length || failed.some((f) => f.branch)
      ? "ℹ️   Jira: subtasks that reached implementation were assigned to you and moved to In Progress."
      : "ℹ️   No Jira issues were modified.",
    "ℹ️   Worktrees are left in place for inspection.",
    "═".repeat(72),
  );
  console.log(out.join("\n"));
}
