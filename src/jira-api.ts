/**
 * Deterministic Jira Cloud client.
 *
 * Reading a ticket, reading a comment and claiming an issue are CRUD, not judgement. Doing them
 * with an agent session made them the least reliable part of a run: no retries, a self-reported
 * "the tools didn't load" that the harness had to trust, minutes of wall clock and real money to
 * make five HTTP requests. This module is the whole Jira surface, and it never spawns anything.
 *
 * Everything here either returns typed data or throws a message a human can act on.
 */

import { exec } from "./proc.js";
import { adfToMarkdown } from "./adf.js";
import type { Subtask } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

export type JiraConfig = {
  /** e.g. https://user-testing.atlassian.net */
  baseUrl: string;
  email: string;
  token: string;
};

/** Which env var supplied the token, so an auth failure names the thing the user has to fix. */
const TOKEN_VARS = ["JIRA_API_TOKEN", "JIRA_TOKEN", "ATLASSIAN_API_TOKEN"] as const;
const EMAIL_VARS = ["JIRA_EMAIL", "ATLASSIAN_EMAIL"] as const;

function firstEnv(names: readonly string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

/** The Jira site a browse URL points at. The run's own argument decides the host, never an env var. */
export function siteFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http") ? `${parsed.protocol}//${parsed.host}` : null;
  } catch {
    return null;
  }
}

/**
 * Resolve credentials, or explain exactly what is missing.
 *
 * The email falls back to the repository's git identity, because that is the address the operator
 * already commits with and is almost always their Atlassian account.
 */
export async function resolveJiraConfig(opts: { parentUrl: string; repo: string }): Promise<JiraConfig> {
  const baseUrl = siteFromUrl(opts.parentUrl);
  if (!baseUrl) throw new Error(`could not read a Jira site from ${opts.parentUrl}`);

  const token = firstEnv(TOKEN_VARS);
  if (!token) {
    throw new Error(
      "no Jira API token. Create one at " +
        "https://id.atlassian.com/manage-profile/security/api-tokens\n" +
        `  then: export JIRA_API_TOKEN="..."\n` +
        `  (${TOKEN_VARS.join(", ")} are all accepted; a set-but-empty variable counts as missing)`,
    );
  }

  const fromEnv = firstEnv(EMAIL_VARS);
  const email = fromEnv?.value ?? (await gitEmail(opts.repo));
  if (!email) {
    throw new Error(
      "no Jira account email. Set JIRA_EMAIL, or give the repository a git identity " +
        "(`git config user.email`).",
    );
  }
  return { baseUrl, email, token: token.value };
}

async function gitEmail(repo: string): Promise<string> {
  const r = await exec("git", ["config", "--get", "user.email"], { cwd: repo, timeoutMs: 10_000 });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

/** A 4xx is the operator's problem and will never fix itself; 429/5xx and network faults will. */
function classify(status: number): boolean {
  return status === 429 || status >= 500;
}

function explain(status: number, key: string, body: string): string {
  const detail = body.slice(0, 300).replace(/\s+/g, " ").trim();
  switch (status) {
    case 401:
      return (
        "Jira rejected the credentials (401). Check JIRA_EMAIL and JIRA_API_TOKEN — note that a " +
        "Server/Data Center personal access token does not work on Jira Cloud; it needs an " +
        "Atlassian API token."
      );
    case 403:
      return `Jira refused the request (403) for ${key}. The account is authenticated but lacks permission.`;
    case 404:
      return `${key} does not exist, or is not visible to this account (404).`;
    default:
      return `Jira returned ${status} for ${key}${detail ? `: ${detail}` : ""}`;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated request, retried on the failures that are worth retrying.
 *
 * This is the piece the agent-based version never had. A single CONNECT_TIMEOUT used to end a
 * whole run; here it costs a second and a retry.
 */
async function request<T>(
  cfg: JiraConfig,
  method: "GET" | "POST" | "PUT",
  endpoint: string,
  body?: unknown,
  context = "Jira",
): Promise<T> {
  const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
  const url = `${cfg.baseUrl}/rest/api/3${endpoint}`;
  let last: JiraError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network fault, DNS, or our own timeout: always worth another go.
      last = new JiraError(`${context}: ${(err as Error).message}`, null, true);
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000);
      continue;
    }

    if (res.ok) {
      // 204 on a successful assignee PUT: there is no body to parse.
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const text = await res.text().catch(() => "");
    const retryable = classify(res.status);
    last = new JiraError(explain(res.status, context, text), res.status, retryable);
    if (!retryable) throw last;
    // Jira asks for a specific wait when it rate-limits; obey it rather than guessing.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (attempt < MAX_ATTEMPTS) {
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1000);
    }
  }
  throw last ?? new JiraError(`${context}: request failed`, null, false);
}

// --- identity ----------------------------------------------------------------

export type JiraUser = { accountId: string; displayName: string; email: string };

/**
 * Who the token belongs to. Doubles as the run's Jira preflight: one cheap call that proves the
 * site, the email and the token all agree, before anything expensive starts.
 */
export async function whoAmI(cfg: JiraConfig): Promise<JiraUser> {
  const d = await request<Record<string, unknown>>(cfg, "GET", "/myself", undefined, "myself");
  return {
    accountId: String(d["accountId"] ?? ""),
    displayName: String(d["displayName"] ?? ""),
    email: String(d["emailAddress"] ?? cfg.email),
  };
}

// --- reading the parent and its subtasks -------------------------------------

type IssueFields = {
  summary?: string;
  labels?: unknown;
  status?: { name?: string };
};

function toSubtask(baseUrl: string, key: string, fields: IssueFields | undefined): Subtask {
  return {
    key: key.toUpperCase(),
    url: `${baseUrl}/browse/${key.toUpperCase()}`,
    summary: typeof fields?.summary === "string" ? fields.summary : "",
    status: typeof fields?.status?.name === "string" ? fields.status.name : null,
    labels: Array.isArray(fields?.labels)
      ? fields.labels.filter((l): l is string => typeof l === "string" && l.trim() !== "")
      : [],
  };
}

export type ParentIssue = { key: string; url: string; summary: string };

export async function getParent(cfg: JiraConfig, key: string): Promise<ParentIssue> {
  const d = await request<{ key?: string; fields?: IssueFields }>(
    cfg,
    "GET",
    `/issue/${encodeURIComponent(key)}?fields=summary`,
    undefined,
    key,
  );
  return {
    key: (d.key ?? key).toUpperCase(),
    url: `${cfg.baseUrl}/browse/${(d.key ?? key).toUpperCase()}`,
    summary: typeof d.fields?.summary === "string" ? d.fields.summary : "",
  };
}

/**
 * Every direct subtask of the parent, labelled or not.
 *
 * The unlabelled ones are listed too, because the operator needs to see the near-misses: a
 * subtask that was meant to be picked up and is missing its label is the single most common
 * reason a run does less than expected.
 */
export async function getSubtasks(cfg: JiraConfig, parentKey: string): Promise<Subtask[]> {
  const d = await request<{ issues?: { key?: string; fields?: IssueFields }[] }>(
    cfg,
    "POST",
    "/search/jql",
    {
      jql: `parent = ${parentKey} ORDER BY key ASC`,
      fields: ["summary", "status", "labels"],
      maxResults: 200,
    },
    `subtasks of ${parentKey}`,
  );
  const seen = new Set<string>();
  const out: Subtask[] = [];
  for (const issue of d.issues ?? []) {
    const key = typeof issue.key === "string" ? issue.key.toUpperCase() : "";
    if (!key || key === parentKey.toUpperCase() || seen.has(key)) continue;
    seen.add(key);
    out.push(toSubtask(cfg.baseUrl, key, issue.fields));
  }
  return out;
}

// --- reading the handoff comment ---------------------------------------------

export type JiraComment = {
  author: string;
  created: string;
  markdown: string;
};

/**
 * All comments on an issue, oldest first, converted to Markdown.
 *
 * `maxResults=100` with `orderBy=-created` would give newest first, but the handoff selection is
 * done by the caller against the marker heading, so the full list is returned and the caller
 * picks. A handoff is never inferred here.
 */
export async function getComments(cfg: JiraConfig, key: string): Promise<JiraComment[]> {
  const d = await request<{ comments?: Record<string, any>[] }>(
    cfg,
    "GET",
    `/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`,
    undefined,
    `comments on ${key}`,
  );
  return (d.comments ?? []).map((c) => ({
    author: String(c["author"]?.["displayName"] ?? "unknown"),
    created: String(c["created"] ?? ""),
    markdown: adfToMarkdown(c["body"]),
  }));
}

// --- claiming ----------------------------------------------------------------

export type Transition = { id: string; name: string; toStatus: string; toCategory: string };

export async function getTransitions(cfg: JiraConfig, key: string): Promise<Transition[]> {
  const d = await request<{ transitions?: Record<string, any>[] }>(
    cfg,
    "GET",
    `/issue/${encodeURIComponent(key)}/transitions`,
    undefined,
    `transitions for ${key}`,
  );
  return (d.transitions ?? []).map((t) => ({
    id: String(t["id"] ?? ""),
    name: String(t["name"] ?? ""),
    toStatus: String(t["to"]?.["name"] ?? ""),
    toCategory: String(t["to"]?.["statusCategory"]?.["key"] ?? ""),
  }));
}

/**
 * Which transition means "I am starting this".
 *
 * Picked deterministically, in the order a human would: a target status literally called "In
 * Progress", then any target in Jira's `indeterminate` category (which is what every project's
 * in-progress column maps to, whatever it is named), then a transition whose own name says it
 * starts work. Returns null rather than guessing at a transition that might close the issue.
 */
export function pickInProgressTransition(transitions: Transition[]): Transition | null {
  const exact = transitions.find((t) => /^in\s*progress$/i.test(t.toStatus));
  if (exact) return exact;
  const category = transitions.find((t) => t.toCategory === "indeterminate");
  if (category) return category;
  const byName = transitions.find((t) => /^(start|begin)\b|in\s*progress/i.test(t.name));
  return byName ?? null;
}

export async function assignIssue(cfg: JiraConfig, key: string, accountId: string): Promise<void> {
  await request<void>(cfg, "PUT", `/issue/${encodeURIComponent(key)}/assignee`, { accountId }, key);
}

export async function transitionIssue(cfg: JiraConfig, key: string, transitionId: string): Promise<void> {
  await request<void>(
    cfg,
    "POST",
    `/issue/${encodeURIComponent(key)}/transitions`,
    { transition: { id: transitionId } },
    key,
  );
}

/**
 * Current assignee, status name and status category, used to skip work already done.
 *
 * The category matters more than the name: every project's in-progress column maps to
 * `indeterminate` whatever it is called, so this is how "already being worked on" is recognised
 * without hardcoding one project's workflow.
 */
export async function getIssueState(
  cfg: JiraConfig,
  key: string,
): Promise<{ assigneeId: string | null; status: string | null; statusCategory: string | null }> {
  const d = await request<{ fields?: Record<string, any> }>(
    cfg,
    "GET",
    `/issue/${encodeURIComponent(key)}?fields=assignee,status`,
    undefined,
    key,
  );
  const assignee = d.fields?.["assignee"];
  const status = d.fields?.["status"];
  return {
    assigneeId: assignee?.["accountId"] ? String(assignee["accountId"]) : null,
    status: status?.["name"] ? String(status["name"]) : null,
    statusCategory: status?.["statusCategory"]?.["key"] ? String(status["statusCategory"]["key"]) : null,
  };
}
