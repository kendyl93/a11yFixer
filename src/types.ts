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

export type Outcome =
  | {
      kind: "pr";
      subtask: Subtask;
      verdict: Verdict;
      prUrl: string;
      branch: string;
      worktree: string;
    }
  | {
      kind: "failed";
      subtask: Subtask;
      reason: string;
      branch: string | null;
      worktree: string | null;
      verdict?: Verdict;
    }
  | {
      kind: "skipped";
      subtask: Subtask;
      reason: string;
    };

export type RunContext = {
  repoPath: string;
  baseSha: string;
  baseBranch: string;
  runDir: string;
  model: string | null;
  dryRun: boolean;
};
