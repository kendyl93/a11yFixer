export type Subtask = {
  key: string;
  url: string;
  summary: string;
  status: string | null;
};

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type Verdict = "PASS" | "FAIL" | "MANUAL_REVIEW_REQUIRED";

import type { Usage } from "./usage.js";

export type Outcome =
  | {
      kind: "pr";
      subtask: Subtask;
      verdict: Verdict;
      prUrl: string;
      branch: string;
      worktree: string;
      usage: Usage;
    }
  | {
      kind: "failed";
      subtask: Subtask;
      reason: string;
      branch: string | null;
      worktree: string | null;
      verdict?: Verdict;
      usage?: Usage;
    }
  | {
      kind: "skipped";
      subtask: Subtask;
      reason: string;
      usage?: Usage;
    };

export type RunContext = {
  repoPath: string;
  baseSha: string;
  baseBranch: string;
  runDir: string;
  model: string | null;
  dryRun: boolean;
  jiraTool: string;
};
