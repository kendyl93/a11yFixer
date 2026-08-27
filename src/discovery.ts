import { renderPrompt, runClaude, READ_ONLY_TOOLS } from "./claude.js";
import type { Subtask } from "./types.js";

const DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    jiraMcpAvailable: { type: "boolean" },
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
};

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
  return {
    parent: {
      key: parent["key"].toUpperCase(),
      url: typeof parent["url"] === "string" ? parent["url"] : "",
      summary: typeof parent["summary"] === "string" ? parent["summary"] : "",
    },
    subtasks,
  };
}

/** Phase 1: a fresh, read-only Claude session whose only job is discovery. Its context is then discarded. */
export async function discoverSubtasks(opts: {
  parentUrl: string;
  parentKey: string;
  cwd: string;
  model: string | null;
}): Promise<Discovery> {
  const prompt = await renderPrompt("discover-subtasks.md", {
    PARENT_URL: opts.parentUrl,
    PARENT_KEY: opts.parentKey,
  });
  const res = await runClaude({
    prompt,
    cwd: opts.cwd,
    disallowedTools: READ_ONLY_TOOLS,
    jsonSchema: DISCOVERY_SCHEMA,
    model: opts.model,
    timeoutMs: 15 * 60 * 1000,
  });
  return parseDiscovery(res.structured, opts.parentKey);
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
}): Promise<Claim> {
  const prompt = await renderPrompt("claim-jira.md", {
    SUBTASK_URL: opts.subtask.url,
    SUBTASK_KEY: opts.subtask.key,
  });
  const res = await runClaude({
    prompt,
    cwd: opts.cwd,
    disallowedTools: READ_ONLY_TOOLS,
    jsonSchema: CLAIM_SCHEMA,
    model: opts.model,
    timeoutMs: 10 * 60 * 1000,
  });
  return parseClaim(res.structured);
}
