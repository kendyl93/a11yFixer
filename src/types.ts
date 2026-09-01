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
      base: Base;
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

/** What one subtask's worktree and pull request are built on: BASE_SHA, or the subtask it stacks on. */
export type Base = {
  sha: string;
  branch: string;
  /** The subtask key this stacks on, or null when it starts from the run's base branch. */
  dependsOn: string | null;
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
