import { renderPrompt, runClaude, READ_ONLY_TOOLS } from "./claude.js";
import type { Subtask } from "./types.js";
import { addUsage, emptyUsage, type Usage } from "./usage.js";

const DISCOVERY_SCHEMA = {
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
        },
        required: ["key", "url", "summary"],
      },
    },
  },
  required: ["jiraMcpAvailable", "parent", "subtasks"],
} as const;

export type Discovery = {
  parent: { key: string; url: string; summary: string };
  subtasks: Subtask[];
  /** Exact MCP tool name the discovery agent used, e.g. mcp__claude_ai_Atlassian__getJiraIssue. */
  jiraTool: string;
};

/**
 * Claude Code defers MCP tools when many servers are configured, so a semantic ToolSearch
 * ("jira atlassian") can silently return nothing and an agent will wrongly conclude Jira is
 * unavailable. An exact `select:` query is deterministic. Every Jira-touching prompt gets this
 * block so no agent has to rediscover it.
 */
export function jiraAccessBlock(jiraTool: string, ticketFile?: string): string {
  const lines = [
    "## Jira access",
    "",
    "Jira MCP tools are configured but may be DEFERRED, meaning they will not appear in your tool",
    "list until you load them. Load them with an exact select query — not a semantic search:",
    "",
    `    ToolSearch({ query: "select:${jiraTool}" })`,
    "",
    "Semantic searches such as \"jira atlassian issue\" are unreliable in this environment and have",
    "silently returned nothing. Never conclude that Jira is unavailable because a semantic search",
    "failed. Try the exact select query above first, and if you need a different Jira tool, select it",
    `by exact name using the same \`${jiraTool.replace(/[^_]+$/, "")}\` prefix.`,
  ];
  if (ticketFile) {
    lines.push(
      "",
      "The full text of this Jira subtask has ALREADY been fetched verbatim and saved to:",
      "",
      `    ${ticketFile}`,
      "",
      "Read that file. It is the authoritative statement of scope for this task. You may query Jira",
      "directly for extra detail, but never proceed on a guess about what the ticket says.",
    );
  }
  return lines.join("\n");
}

export const DEFAULT_JIRA_TOOL = "mcp__claude_ai_Atlassian__getJiraIssue";

export type DiscoveryResult = Discovery & { usage: Usage };

/** Pull the issue key out of a Jira browse URL. */
export function parseJiraKey(url: string): string | null {
  const m = url.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i) ?? url.match(/^([A-Z][A-Z0-9_]*-\d+)$/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

const DONE_STATUS = /^(done|closed|resolved|cancell?ed|won'?t do|duplicate)$/i;

export function isAlreadyDone(status: string | null): boolean {
  return status !== null && DONE_STATUS.test(status.trim());
}

/** Turn the discovery agent's structured output into a validated Discovery. */
export function parseDiscovery(structured: unknown, parentKey: string): Discovery {
  if (!structured || typeof structured !== "object") {
    throw new Error("discovery agent returned no structured output");
  }
  const d = structured as Record<string, any>;
  if (d["jiraMcpAvailable"] === false) {
    throw new Error(`Jira MCP unavailable to the discovery agent: ${d["error"] ?? "no detail given"}`);
  }
  if (typeof d["error"] === "string" && d["error"].trim()) {
    throw new Error(`discovery failed: ${d["error"]}`);
  }
  const parent = d["parent"];
  if (!parent || typeof parent["key"] !== "string") {
    throw new Error("discovery agent returned no parent issue");
  }
  if (parent["key"].toUpperCase() !== parentKey.toUpperCase()) {
    throw new Error(`discovery agent returned parent ${parent["key"]}, expected ${parentKey}`);
  }
  const rawSubtasks = Array.isArray(d["subtasks"]) ? d["subtasks"] : [];
  const seen = new Set<string>();
  const subtasks: Subtask[] = [];
  for (const s of rawSubtasks) {
    if (!s || typeof s["key"] !== "string" || typeof s["url"] !== "string") continue;
    const key = s["key"].toUpperCase();
    if (key === parentKey.toUpperCase() || seen.has(key)) continue;
    seen.add(key);
    subtasks.push({
      key,
      url: s["url"],
      summary: typeof s["summary"] === "string" ? s["summary"] : "",
      status: typeof s["status"] === "string" ? s["status"] : null,
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
    jiraTool: /^mcp__[\w]+__[\w]+$/.test(reported) ? reported : DEFAULT_JIRA_TOOL,
  };
}

/** Phase 1: a fresh, read-only Claude session whose only job is discovery. Its context is then discarded. */
export async function discoverSubtasks(opts: {
  parentUrl: string;
  parentKey: string;
  cwd: string;
  model: string | null;
  jiraTool?: string;
}): Promise<DiscoveryResult> {
  const prompt = await renderPrompt("discover-subtasks.md", {
    PARENT_URL: opts.parentUrl,
    PARENT_KEY: opts.parentKey,
    JIRA_ACCESS: jiraAccessBlock(opts.jiraTool ?? DEFAULT_JIRA_TOOL),
  });
  const res = await runClaude({
    prompt,
    cwd: opts.cwd,
    disallowedTools: READ_ONLY_TOOLS,
    jsonSchema: DISCOVERY_SCHEMA,
    model: opts.model,
    timeoutMs: 15 * 60 * 1000,
  });
  return { ...parseDiscovery(res.structured, opts.parentKey), usage: res.usage };
}

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
 * Claim the subtask immediately before implementation begins: assign it to the
 * authenticated user and move it to the project's in-progress state.
 * This is the only Jira mutation a11yFixer performs, and it is never fatal.
 */
export async function claimSubtask(opts: {
  subtask: Subtask;
  cwd: string;
  model: string | null;
  jiraAccess: string;
}): Promise<{ claim: Claim; usage: Usage }> {
  const prompt = await renderPrompt("claim-jira.md", {
    SUBTASK_URL: opts.subtask.url,
    SUBTASK_KEY: opts.subtask.key,
    JIRA_ACCESS: opts.jiraAccess,
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

const FETCH_SCHEMA = {
  type: "object",
  properties: {
    fetched: { type: "boolean" },
    key: { type: "string" },
    summary: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    markdown: { type: "string" },
    error: { type: ["string", "null"] },
  },
  required: ["fetched", "markdown"],
} as const;

export type TicketFetch = { ok: true; markdown: string } | { ok: false; error: string };

/** A transcription this short cannot contain a real ticket description. */
const MIN_TICKET_CHARS = 120;

export function validateTicket(structured: unknown, key: string): TicketFetch {
  const d = (structured ?? {}) as Record<string, unknown>;
  const markdown = typeof d["markdown"] === "string" ? d["markdown"].trim() : "";
  if (d["fetched"] !== true) {
    return { ok: false, error: typeof d["error"] === "string" && d["error"] ? d["error"] : "agent reported it could not reach Jira" };
  }
  if (markdown.length < MIN_TICKET_CHARS) {
    return { ok: false, error: `Jira transcription was only ${markdown.length} chars — too short to be the real ticket` };
  }
  if (!markdown.toUpperCase().includes(key.toUpperCase())) {
    return { ok: false, error: `Jira transcription does not mention ${key}` };
  }
  return { ok: true, markdown };
}

/**
 * Fetch one Jira subtask verbatim into a file before any code is written.
 * Downstream agents read that file instead of each re-querying MCP, so a deferred-tool miss can
 * never silently turn into "implemented from the issue key". Retried once, then fatal.
 */
export async function fetchSubtaskTicket(opts: {
  subtask: Subtask;
  cwd: string;
  model: string | null;
  jiraTool: string;
  attempts?: number;
}): Promise<{ result: TicketFetch; usage: Usage }> {
  const prompt = await renderPrompt("fetch-subtask.md", {
    SUBTASK_URL: opts.subtask.url,
    SUBTASK_KEY: opts.subtask.key,
    JIRA_ACCESS: jiraAccessBlock(opts.jiraTool),
  });

  let usage = emptyUsage();
  let last: TicketFetch = { ok: false, error: "not attempted" };
  for (let attempt = 0; attempt < (opts.attempts ?? 2); attempt++) {
    const res = await runClaude({
      prompt,
      cwd: opts.cwd,
      disallowedTools: READ_ONLY_TOOLS,
      jsonSchema: FETCH_SCHEMA,
      model: opts.model,
      timeoutMs: 10 * 60 * 1000,
    });
    usage = addUsage(usage, res.usage);
    last = validateTicket(res.structured, opts.subtask.key);
    if (last.ok) break;
  }
  return { result: last, usage };
}
