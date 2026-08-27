import type { Outcome } from "./types.js";

export function printSummary(parentKey: string, discovered: number, outcomes: Outcome[]): void {
  const prs = outcomes.filter((o): o is Extract<Outcome, { kind: "pr" }> => o.kind === "pr");
  const failed = outcomes.filter((o): o is Extract<Outcome, { kind: "failed" }> => o.kind === "failed");
  const skipped = outcomes.filter((o): o is Extract<Outcome, { kind: "skipped" }> => o.kind === "skipped");

  const out: string[] = ["", "═".repeat(60), "a11yFixer finished", "", "Parent:", `  ${parentKey}`, "", "Direct subtasks:", `  ${discovered}`];

  if (prs.length) {
    out.push("", "DRAFT PRS CREATED", "");
    for (const o of prs) {
      out.push(`  ✓ ${o.subtask.key}`, `    ${o.prUrl}`, `    Reviewer: ${o.verdict}`, "");
    }
  }
  if (failed.length) {
    out.push("", "FAILED", "");
    for (const o of failed) {
      out.push(`  ✗ ${o.subtask.key}`, `    ${o.reason.split("\n")[0]}`);
      if (o.branch) out.push(`    Branch: ${o.branch}`);
      if (o.worktree) out.push(`    Worktree: ${o.worktree}`);
      out.push("");
    }
  }
  if (skipped.length) {
    out.push("", "SKIPPED", "");
    for (const o of skipped) out.push(`  - ${o.subtask.key}`, `    Reason: ${o.reason}`, "");
  }

  out.push(
    "",
    "Linked Jira issues were not used as implementation scope.",
    "Nothing was merged.",
    "No Jira issues were modified.",
    "Worktrees are left in place for inspection.",
    "═".repeat(60),
  );
  console.log(out.join("\n"));
}
