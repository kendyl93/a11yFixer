/**
 * The Jira phases of a run.
 *
 * Three of the four used to be Claude sessions driving MCP tools. They were the least reliable
 * part of ship-tickets: no retries, minutes of wall clock and real money spent to make a handful
 * of HTTP requests, and a design that had to trust an agent's own report about whether its tools
 * had loaded. Reading subtasks, reading a comment and claiming an issue are CRUD, so they are
 * now plain REST calls in `jira-api.ts` — deterministic, retried, and free.
 *
 * `planOrder` is the one that stays an agent, because deciding what to build on top of what is
 * judgement. It never touches Jira: it reads the handoff files this module wrote to disk.
 */

import { renderPrompt, runClaude, READ_ONLY_TOOLS } from "./claude.js";
import * as api from "./jira-api.js";
import type { JiraComment, JiraConfig, JiraUser } from "./jira-api.js";
import type { Subtask } from "./types.js";
import type { Usage } from "./usage.js";

/** The label a human puts on a subtask to say "this one is ready for the agent". */
export const DEFAULT_READY_LABEL = "ready-for-implementation";

/**
 * The heading a human writes above the grilling output when pasting it into a Jira comment.
 * A labelled subtask whose comments contain no such heading is never implemented.
 */
export const HANDOFF_MARKER = "## Handoff";

/** Matches `## Handoff`, `# handoff`, `### Handoff document`, etc., on a line of its own. */
export const HANDOFF_HEADING = /^[ \t]*#{1,6}[ \t]*handoff\b/im;

/** A handoff shorter than this cannot contain an agreed implementation plan. */
const MIN_HANDOFF_CHARS = 200;

/** Pull the issue key out of a Jira browse URL. */
export function parseJiraKey(url: string): string | null {
  const m = url.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i) ?? url.match(/^([A-Z][A-Z0-9_]*-\d+)$/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/**
 * A subtask whose code is already written is not the agent's to pick up: it is being reviewed or
 * verified, or it is finished. In-progress states are NOT excluded — work someone has started is
 * still a candidate, and ship-tickets moves a subtask to in-progress itself before writing its
 * code, so excluding those would make a re-run skip its own claims. The check is a deny-list — an
 * unrecognised status is treated as available and the label decides.
 */
const UNAVAILABLE_STATUS =
  /^(code review|in review|review|peer review|in verification|verification|verifying|qa|in qa|testing|in test|done|closed|resolved|complete[d]?|cancell?ed|won'?t do|duplicate)$/i;

export function isUnavailable(status: string | null): boolean {
  return status !== null && UNAVAILABLE_STATUS.test(status.trim());
}

export function hasLabel(subtask: Subtask, label: string): boolean {
  return subtask.labels.some((l) => l.trim().toLowerCase() === label.trim().toLowerCase());
}

// --- Phase 1: find the subtasks a human has marked ready ---------------------

export type Survey = {
  parent: { key: string; url: string; summary: string };
  /** Every direct subtask, labelled or not, so the operator can see near-misses. */
  subtasks: Subtask[];
};

/**
 * Phase 1: the parent and its direct subtasks, in two parallel requests.
 *
 * Was a $0.69 agent session that took nearly a minute and had no retry, so one transient MCP
 * timeout ended the whole run. Now it is two GETs with three attempts each.
 */
export async function surveySubtasks(opts: { cfg: JiraConfig; parentKey: string }): Promise<Survey> {
  const [parent, subtasks] = await Promise.all([
    api.getParent(opts.cfg, opts.parentKey),
    api.getSubtasks(opts.cfg, opts.parentKey),
  ]);
  return { parent, subtasks };
}

// --- Phase 2: fetch the human's handoff comment ------------------------------

export type Handoff =
  | { ok: true; markdown: string; author: string; created: string }
  | { ok: false; error: string };

/**
 * The newest comment that carries the handoff heading.
 *
 * Newest wins so that a corrected handoff supersedes an earlier one without the human having to
 * delete anything. Comments arrive oldest-first, so this walks backwards.
 */
export function pickHandoffComment(comments: JiraComment[]): JiraComment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] as JiraComment;
    if (HANDOFF_HEADING.test(c.markdown)) return c;
  }
  return null;
}

/**
 * The handoff is the whole contract between the human and the agent, so it is validated rather
 * than trusted: it must carry the marker heading and enough substance to be a real plan. A
 * missing handoff must never degrade into "implement from the summary".
 */
export function validateHandoff(comment: JiraComment | null, totalComments: number): Handoff {
  if (!comment) {
    return {
      ok: false,
      error:
        totalComments === 0
          ? "the subtask has no comments at all"
          : `no \`${HANDOFF_MARKER}\` heading in any of its ${totalComments} comment(s)`,
    };
  }
  const markdown = comment.markdown.trim();
  if (!HANDOFF_HEADING.test(markdown)) {
    return { ok: false, error: `no \`${HANDOFF_MARKER}\` heading in the selected comment` };
  }
  if (markdown.length < MIN_HANDOFF_CHARS) {
    return { ok: false, error: `handoff was only ${markdown.length} chars — too short to be a real plan` };
  }
  return { ok: true, markdown, author: comment.author, created: comment.created };
}

/**
 * Phase 2: read the newest handoff comment.
 *
 * Was an agent session per subtask ($0.80 each, ~2 minutes) that transcribed the comment and
 * could paraphrase it. Now the comment's own ADF is converted to Markdown, so what the
 * implementation agent reads is what the human wrote, byte for byte.
 */
export async function fetchHandoff(opts: { cfg: JiraConfig; subtask: Subtask }): Promise<Handoff> {
  const comments = await api.getComments(opts.cfg, opts.subtask.key);
  return validateHandoff(pickHandoffComment(comments), comments.length);
}

// --- Phase 3: claim the subtask ---------------------------------------------

export type Claim = {
  assigned: boolean;
  transitioned: boolean;
  assignee: string | null;
  status: string | null;
  error: string | null;
  note: string;
};

/** One-line human summary of what happened to the Jira issue. */
export function describeClaim(c: Claim): string {
  if (c.assigned && c.transitioned) {
    return `assigned to ${c.assignee ?? "you"} · ${c.status ?? "In Progress"}`;
  }
  const parts: string[] = [];
  parts.push(c.assigned ? `assigned to ${c.assignee ?? "you"}` : "NOT assigned");
  parts.push(c.transitioned ? `${c.status ?? "In Progress"}` : "status UNCHANGED");
  if (c.error) parts.push(c.error);
  return parts.join(" · ");
}

/**
 * Phase 3: assign the subtask to the token's owner and move it to the project's in-progress
 * state, immediately before implementation starts.
 *
 * This is the only Jira mutation ship-tickets performs, and it is never fatal: a Jira workflow
 * quirk must not stop code from being written. Both halves are idempotent — already assigned and
 * already in progress is success, not a no-op worth warning about.
 */
export async function claimSubtask(opts: {
  cfg: JiraConfig;
  subtask: Subtask;
  user: JiraUser;
}): Promise<Claim> {
  const { cfg, subtask, user } = opts;
  const claim: Claim = {
    assigned: false,
    transitioned: false,
    assignee: user.displayName || user.email,
    status: null,
    error: null,
    note: "",
  };
  const notes: string[] = [];

  let state: { assigneeId: string | null; status: string | null; statusCategory: string | null };
  try {
    state = await api.getIssueState(cfg, subtask.key);
  } catch (err) {
    claim.error = (err as Error).message;
    return claim;
  }
  claim.status = state.status;

  if (state.assigneeId === user.accountId) {
    claim.assigned = true;
    notes.push("already assigned to you");
  } else {
    try {
      await api.assignIssue(cfg, subtask.key, user.accountId);
      claim.assigned = true;
    } catch (err) {
      notes.push(`assign failed: ${(err as Error).message}`);
    }
  }

  // Jira's `indeterminate` category is what every project's in-progress column maps to, whatever
  // the column is called, so this recognises a subtask that is already being worked on.
  if (state.statusCategory === "indeterminate") {
    claim.transitioned = true;
    notes.push(`already in "${state.status}"`);
  } else {
    try {
      const transitions = await api.getTransitions(cfg, subtask.key);
      const target = api.pickInProgressTransition(transitions);
      if (!target) {
        notes.push(
          `no in-progress transition available from "${state.status}" ` +
            `(offered: ${transitions.map((t) => t.toStatus).join(", ") || "none"})`,
        );
      } else {
        await api.transitionIssue(cfg, subtask.key, target.id);
        claim.transitioned = true;
        claim.status = target.toStatus;
      }
    } catch (err) {
      notes.push(`transition failed: ${(err as Error).message}`);
    }
  }

  claim.note = notes.join(" · ");
  if (!claim.assigned || !claim.transitioned) claim.error = claim.error ?? null;
  return claim;
}

// --- Phase 4: decide what gets built on top of what --------------------------

const ORDER_SCHEMA = {
  type: "object",
  properties: {
    order: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          dependsOn: { type: ["string", "null"] },
          reason: { type: "string" },
        },
        required: ["key", "dependsOn"],
      },
    },
  },
  required: ["order"],
} as const;

export type PlanStep = { key: string; dependsOn: string | null; reason: string };

/**
 * Trust the agent for the judgement, not the bookkeeping: the plan is forced back into a
 * permutation of the ready keys, and a dependency that does not appear earlier in the order is
 * dropped rather than allowed to produce a worktree stacked on nothing.
 */
export function parsePlan(structured: unknown, ready: Subtask[]): PlanStep[] {
  const d = (structured ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(d["order"]) ? d["order"] : [];
  const byKey = new Map(ready.map((s) => [s.key.toUpperCase(), s]));
  const steps: PlanStep[] = [];
  const placed = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item["key"] !== "string") continue;
    const key = item["key"].toUpperCase();
    if (!byKey.has(key) || placed.has(key)) continue;
    const dep = typeof item["dependsOn"] === "string" ? item["dependsOn"].toUpperCase() : null;
    placed.add(key);
    steps.push({
      key,
      dependsOn: dep && placed.has(dep) && dep !== key ? dep : null,
      reason: typeof item["reason"] === "string" ? item["reason"].trim() : "",
    });
  }
  // Anything the agent forgot still gets built, unstacked, in Jira's order.
  for (const s of ready) {
    if (!placed.has(s.key)) steps.push({ key: s.key, dependsOn: null, reason: "" });
  }
  return steps;
}

/** A fresh context that reads only the handoffs, decides the order, and dies. */
export async function planOrder(opts: {
  ready: Subtask[];
  handoffPaths: Map<string, string>;
  cwd: string;
  addDirs: string[];
  model: string | null;
}): Promise<{ plan: PlanStep[]; usage: Usage }> {
  const prompt = await renderPrompt("order.md", {
    SUBTASKS: opts.ready
      .map((s) => `${s.key}  ${s.summary}\n  handoff: ${opts.handoffPaths.get(s.key) ?? "(none)"}`)
      .join("\n\n"),
  });
  const res = await runClaude({
    prompt,
    cwd: opts.cwd,
    disallowedTools: READ_ONLY_TOOLS,
    addDirs: opts.addDirs,
    jsonSchema: ORDER_SCHEMA,
    model: opts.model,
    timeoutMs: 15 * 60 * 1000,
  });
  return { plan: parsePlan(res.structured, opts.ready), usage: res.usage };
}
