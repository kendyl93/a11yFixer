export type Subtask = {
  key: string;
  url: string;
  summary: string;
  status: string | null;
  labels: string[];
};

import type { Usage } from "./usage.js";

export type Outcome =
  | {
      kind: "pr";
      subtask: Subtask;
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
