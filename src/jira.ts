import { renderPrompt, runClaude, READ_ONLY_TOOLS } from "./claude.js";
import type { Subtask } from "./types.js";
import { addUsage, emptyUsage, type Usage } from "./usage.js";

export const DEFAULT_JIRA_TOOL = "mcp__claude_ai_Atlassian__getJiraIssue";

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

/**
 * Claude Code defers MCP tools when many servers are configured, and a semantic ToolSearch
 * ("jira atlassian") silently returns nothing — an agent then concludes Jira is unavailable and
 * implements from the issue key. Only an exact `select:` query is reliable, so every Jira-touching
 * prompt is handed one rather than left to search.
 */
export function jiraAccessBlock(jiraTool: string, extraTools: string[] = []): string {
  const names = [jiraTool, ...extraTools.map((t) => jiraToolPrefix(jiraTool) + t)];
  return [
    "Jira MCP tools are deferred. Load them with an exact select query, verbatim:",
    "",
    `    ToolSearch({ query: "select:${names.join(",")}" })`,
    "",
    "Semantic searches return nothing here. If you need another Jira tool, select it by exact name",
    `with the same \`${jiraToolPrefix(jiraTool)}\` prefix.`,
  ].join("\n");
}

/**
 * Tool names the Atlassian MCP server exposes for claiming an issue.
 * ToolSearch only resolves EXACT names — a keyword search like "+atlassian" returns nothing here,
 * so an agent left to guess these will wrongly report that no write tools exist.
 */
const JIRA_WRITE_TOOLS = [
  "atlassianUserInfo",
  "getJiraIssue",
  "editJiraIssue",
  "getTransitionsForJiraIssue",
  "transitionJiraIssue",
  "lookupJiraAccountId",
];

/** `mcp__claude_ai_Atlassian__getJiraIssue` -> `mcp__claude_ai_Atlassian__` */
export function jiraToolPrefix(jiraTool: string): string {
  const at = jiraTool.lastIndexOf("__");
  return at === -1 ? "" : jiraTool.slice(0, at + 2);
}

/** The exact, comma-separated select query that loads the whole claim toolset in one call. */
export function jiraWriteSelectQuery(jiraTool: string): string {
  const prefix = jiraToolPrefix(jiraTool);
  return `select:${JIRA_WRITE_TOOLS.map((t) => prefix + t).join(",")}`;
}

export function jiraWriteAccessBlock(jiraTool: string): string {
  return [
    "Jira write tools are deferred. Load them all in ONE call, verbatim:",
    "",
    `    ToolSearch({ query: "${jiraWriteSelectQuery(jiraTool)}" })`,
    "",
    "Only exact names resolve — keyword searches return nothing. If one name does not resolve, drop",
    "just that one and continue.",
  ].join("\n");
}

/** Pull the issue key out of a Jira browse URL. */
export function parseJiraKey(url: string): string | null {
  const m = url.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i) ?? url.match(/^([A-Z][A-Z0-9_]*-\d+)$/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/**
 * A subtask that is already moving is not the agent's to pick up: someone is on it, it is being
 * reviewed or verified, or it is finished. Only work that has not started is a candidate, so the
 * check is a deny-list — an unrecognised status is treated as available and the label decides.
 */
const UNAVAILABLE_STATUS =
  /^(in progress|in development|in dev|started|code review|in review|review|peer review|in verification|verification|verifying|qa|in qa|testing|in test|done|closed|resolved|complete[d]?|cancell?ed|won'?t do|duplicate)$/i;

export function isUnavailable(status: string | null): boolean {
  return status !== null && UNAVAILABLE_STATUS.test(status.trim());
}

export function hasLabel(subtask: Subtask, label: string): boolean {
  return subtask.labels.some((l) => l.trim().toLowerCase() === label.trim().toLowerCase());
}

// --- Phase 1: find the subtasks a human has marked ready ---------------------

const SURVEY_SCHEMA = {
  type: "object",
  properties: {
    jiraMcpAvailable: { type: "boolean" },
    jiraToolName: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    parent: {
      type: "object",
      properties: {
        key: { type: "string" },
        url: { type: "string" },
        summary: { type: "string" },
      },
      required: ["key", "url"],
    },
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          url: { type: "string" },
          summary: { type: "string" },
          status: { type: ["string", "null"] },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["key", "url", "summary", "labels"],
      },
    },
  },
  required: ["jiraMcpAvailable", "parent", "subtasks"],
} as const;

export type Survey = {
  parent: { key: string; url: string; summary: string };
  /** Every direct subtask, labelled or not, so the operator can see near-misses. */
  subtasks: Subtask[];
  /** Exact MCP tool name the agent used, e.g. mcp__claude_ai_Atlassian__getJiraIssue. */
  jiraTool: string;
};

export type SurveyResult = Survey & { usage: Usage };

/** Turn the survey agent's structured output into a validated Survey. */
export function parseSurvey(structured: unknown, parentKey: string): Survey {
  if (!structured || typeof structured !== "object") {
    throw new Error("survey agent returned no structured output");
  }
  const d = structured as Record<string, any>;
  if (d["jiraMcpAvailable"] === false) {
    throw new Error(`Jira MCP unavailable to the survey agent: ${d["error"] ?? "no detail given"}`);
  }
  if (typeof d["error"] === "string" && d["error"].trim()) {
    throw new Error(`survey failed: ${d["error"]}`);
  }
  const parent = d["parent"];
  if (!parent || typeof parent["key"] !== "string") {
    throw new Error("survey agent returned no parent issue");
  }
  if (parent["key"].toUpperCase() !== parentKey.toUpperCase()) {
    throw new Error(`survey agent returned parent ${parent["key"]}, expected ${parentKey}`);
  }
  const raw = Array.isArray(d["subtasks"]) ? d["subtasks"] : [];
  const seen = new Set<string>();
  const subtasks: Subtask[] = [];
  for (const s of raw) {
    if (!s || typeof s["key"] !== "string" || typeof s["url"] !== "string") continue;
    const key = s["key"].toUpperCase();
    if (key === parentKey.toUpperCase() || seen.has(key)) continue;
    seen.add(key);
    subtasks.push({
      key,
      url: s["url"],
      summary: typeof s["summary"] === "string" ? s["summary"] : "",
      status: typeof s["status"] === "string" ? s["status"] : null,
      labels: Array.isArray(s["labels"])
        ? s["labels"].filter((l: unknown): l is string => typeof l === "string" && l.trim() !== "")
        : [],
    });
  }
  const reported = typeof d["jiraToolName"] === "string" ? d["jiraToolName"].trim() : "";
  return {
    parent: {
      key: parent["key"].toUpperCase(),
      url: typeof parent["url"] === "string" ? parent["url"] : "",
      summary: typeof parent["summary"] === "string" ? parent["summary"] : "",
    },
    subtasks,
    jiraTool: /^mcp__\w+__\w+$/.test(reported) ? reported : DEFAULT_JIRA_TOOL,
  };
}

/**
 * Phase 1: a fresh, read-only Claude session that lists the parent's direct subtasks and their
 * labels. It is also the run's Jira connection check — if this fails, nothing else runs.
 * Its context is discarded before any code is read.
 */
export async function surveySubtasks(opts: {
  parentUrl: string;
  parentKey: string;
  readyLabel: string;
  cwd: string;
  model: string | null;
  jiraTool: string;
}): Promise<SurveyResult> {
  const prompt = await renderPrompt("find-ready.md", {
    PARENT_URL: opts.parentUrl,
    PARENT_KEY: opts.parentKey,
    READY_LABEL: opts.readyLabel,
    JIRA_ACCESS: jiraAccessBlock(opts.jiraTool, ["searchJiraIssuesUsingJql"]),
  });
  const res = await runClaude({
    prompt,
    cwd: opts.cwd,
    disallowedTools: READ_ONLY_TOOLS,
    jsonSchema: SURVEY_SCHEMA,
    model: opts.model,
    timeoutMs: 15 * 60 * 1000,
  });
  return { ...parseSurvey(res.structured, opts.parentKey), usage: res.usage };
}

// --- Phase 2: fetch the human's handoff comment ------------------------------

const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    key: { type: "string" },
    summary: { type: ["string", "null"] },
    commentAuthor: { type: ["string", "null"] },
    commentCreated: { type: ["string", "null"] },
    handoff: { type: "string" },
    error: { type: ["string", "null"] },
  },
  required: ["found", "handoff"],
} as const;

export type Handoff = { ok: true; markdown: string } | { ok: false; error: string };

/**
 * The handoff is the whole contract between the human and the agent, so it is validated
 * deterministically rather than trusted: it must carry the marker heading and enough substance
 * to be a real plan. A missing handoff must never degrade into "implement from the summary".
 */
export function validateHandoff(structured: unknown): Handoff {
  const d = (structured ?? {}) as Record<string, unknown>;
  const markdown = typeof d["handoff"] === "string" ? d["handoff"].trim() : "";
  if (d["found"] !== true) {
    const err = typeof d["error"] === "string" && d["error"] ? d["error"] : "agent reported no handoff comment";
    return { ok: false, error: err };
  }
  if (!HANDOFF_HEADING.test(markdown)) {
    return { ok: false, error: `no \`${HANDOFF_MARKER}\` heading in the returned text` };
  }
  if (markdown.length < MIN_HANDOFF_CHARS) {
    return { ok: false, error: `handoff was only ${markdown.length} chars — too short to be a real plan` };
  }
  return { ok: true, markdown };
}

/**
 * Phase 2: transcribe the newest handoff comment verbatim into a file. Every later agent reads
 * that file, so a deferred-tool miss can never silently turn into "implemented from the issue key".
 * Retried once, then fatal for this subtask.
 */
export async function fetchHandoff(opts: {
  subtask: Subtask;
  readyLabel: string;
  cwd: string;
  model: string | null;
  jiraTool: string;
  attempts?: number;
}): Promise<{ result: Handoff; usage: Usage }> {
  const prompt = await renderPrompt("fetch-handoff.md", {
    SUBTASK_URL: opts.subtask.url,
    SUBTASK_KEY: opts.subtask.key,
    READY_LABEL: opts.readyLabel,
    HANDOFF_MARKER,
    JIRA_ACCESS: jiraAccessBlock(opts.jiraTool),
  });

  let usage = emptyUsage();
  let last: Handoff = { ok: false, error: "not attempted" };
  for (let attempt = 0; attempt < (opts.attempts ?? 2); attempt++) {
    const res = await runClaude({
      prompt,
      cwd: opts.cwd,
      disallowedTools: READ_ONLY_TOOLS,
      jsonSchema: HANDOFF_SCHEMA,
      model: opts.model,
      timeoutMs: 10 * 60 * 1000,
    });
    usage = addUsage(usage, res.usage);
    last = validateHandoff(res.structured);
    if (last.ok) break;
  }
  return { result: last, usage };
}

// --- Phase 3: claim the subtask ---------------------------------------------

const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    assigned: { type: "boolean" },
    transitioned: { type: "boolean" },
    assignee: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    note: { type: "string" },
  },
  required: ["assigned", "transitioned"],
} as const;

export type Claim = {
  assigned: boolean;
  transitioned: boolean;
  assignee: string | null;
  status: string | null;
  error: string | null;
  note: string;
};

export function parseClaim(structured: unknown): Claim {
  const d = (structured ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    assigned: d["assigned"] === true,
    transitioned: d["transitioned"] === true,
    assignee: str(d["assignee"]),
    status: str(d["status"]),
    error: str(d["error"]),
    note: str(d["note"]) ?? "",
  };
}

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
 * Phase 3: assign the subtask to the authenticated user and move it to the project's
 * in-progress state, immediately before implementation starts.
 * This is the only Jira mutation ship-tickets performs, and it is never fatal.
 */
export async function claimSubtask(opts: {
  subtask: Subtask;
  cwd: string;
  model: string | null;
  jiraTool: string;
}): Promise<{ claim: Claim; usage: Usage }> {
  const prompt = await renderPrompt("claim-jira.md", {
    SUBTASK_URL: opts.subtask.url,
    SUBTASK_KEY: opts.subtask.key,
    JIRA_WRITE_ACCESS: jiraWriteAccessBlock(opts.jiraTool),
  });
  const res = await runClaude({
    prompt,
    cwd: opts.cwd,
    disallowedTools: READ_ONLY_TOOLS,
    jsonSchema: CLAIM_SCHEMA,
    model: opts.model,
    timeoutMs: 10 * 60 * 1000,
  });
  return { claim: parseClaim(res.structured), usage: res.usage };
}

// --- Phase 3: decide what gets built on top of what --------------------------

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
