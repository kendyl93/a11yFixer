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
 * Claude Code defers MCP tools when many servers are configured, so a semantic ToolSearch
 * ("jira atlassian") can silently return nothing and an agent will wrongly conclude Jira is
 * unavailable. An exact `select:` query is deterministic. Every Jira-touching prompt gets this
 * block so no agent has to rediscover it.
 */
export function jiraAccessBlock(jiraTool: string, extraTools: string[] = []): string {
  const names = [jiraTool, ...extraTools.map((t) => jiraToolPrefix(jiraTool) + t)];
  return [
    "## Jira access",
    "",
    "Jira MCP tools are configured but may be DEFERRED, meaning they will not appear in your tool",
    "list until you load them. Load them with an exact select query — not a semantic search:",
    "",
    `    ToolSearch({ query: "select:${names.join(",")}" })`,
    "",
    "Semantic searches such as \"jira atlassian issue\" are unreliable in this environment and have",
    "silently returned nothing. Never conclude that Jira is unavailable because a semantic search",
    "failed. Try the exact select query above first, and if you need a different Jira tool, select it",
    `by exact name using the same \`${jiraToolPrefix(jiraTool)}\` prefix.`,
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
    "## Loading the Jira write tools",
    "",
    "Jira write tools are DEFERRED. Load them all in ONE call with this exact query, verbatim:",
    "",
    `    ToolSearch({ query: "${jiraWriteSelectQuery(jiraTool)}" })`,
    "",
    "Keyword and semantic searches (\"+atlassian\", \"jira transitions\") return nothing in this",
    "environment — only exact names resolve. If you skip the query above and search instead, you",
    "will wrongly conclude that no write tools exist. If a name in that list does not resolve, drop",
    "just that one and continue with the rest.",
  ].join("\n");
}

/** Pull the issue key out of a Jira browse URL. */
export function parseJiraKey(url: string): string | null {
  const m = url.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i) ?? url.match(/^([A-Z][A-Z0-9_]*-\d+)$/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

const DONE_STATUS = /^(done|closed|resolved|cancell?ed|won'?t do|duplicate)$/i;

export function isAlreadyDone(status: string | null): boolean {
  return status !== null && DONE_STATUS.test(status.trim());
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
 * This is the only Jira mutation a11yFixer performs, and it is never fatal.
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
