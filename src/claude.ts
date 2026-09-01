import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { exec } from "./proc.js";
import { parseUsage, type Usage } from "./usage.js";

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The skill that does the engineering. `prompts/implement.md` invokes it as a slash command, so
 * this name is resolved by the claude CLI against the installed skills — install it from
 * https://github.com/mattpocock/skills and ship-tickets builds things the way that skill says.
 */
export const IMPLEMENT_SKILL = "implement";

/**
 * Locate the skill file whose text the implementation phase runs.
 *
 * Resolution mirrors the claude CLI: user skills, then the target repo's own, then plugins.
 * The run refuses to start when this returns null, because an implementation phase with no
 * process to follow would still look like a successful session.
 */
export async function findSkill(name: string, repo: string): Promise<string | null> {
  const home = os.homedir();
  const direct = [
    path.join(home, ".claude", "skills", name, "SKILL.md"),
    path.join(repo, ".claude", "skills", name, "SKILL.md"),
  ];
  for (const candidate of direct) {
    if (await stat(candidate).catch(() => null)) return candidate;
  }
  // Plugin-provided skills live under the plugin cache, one tree per marketplace and version.
  const found = await exec(
    "/bin/sh",
    ["-c", `ls -d "$HOME"/.claude/plugins/*/*/*/*/skills/${name}/SKILL.md 2>/dev/null | head -1`],
    { timeoutMs: 10_000 },
  );
  return found.stdout.trim() || null;
}

/**
 * The skill's instructions, frontmatter stripped.
 *
 * The body is inlined verbatim into the implementation prompt rather than invoked as
 * `/implement`, so what the agent runs is exactly the skill on disk at that moment — visible in
 * the run's artifacts, and impossible to silently downgrade to an ordinary prompt.
 */
export async function readSkillBody(skillPath: string): Promise<string> {
  const raw = await readFile(skillPath, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return body.trim();
}

/** /implement runs tests, a typecheck and a self-review, so it needs a much longer leash. */
export const IMPLEMENT_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * Denied to every phase except /implement. Built-in tools only; MCP tools stay reachable via
 * ToolSearch. A phase that only reads Jira, reads the repo or writes PR text has no business
 * running a shell or editing a file, and saying so is cheaper than hoping.
 */
export const READ_ONLY_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit"];

export type ClaudeCall = {
  /** Fully rendered prompt text. */
  prompt: string;
  /** Working directory for the session (usually the subtask worktree). */
  cwd: string;
  /** Resume an existing session instead of starting a fresh one. */
  resume?: string;
  /** Built-in tools to deny. */
  disallowedTools?: string[];
  addDirs?: string[];
  jsonSchema?: unknown;
  model?: string | null;
  timeoutMs?: number;
};

export type ClaudeResponse = {
  sessionId: string;
  text: string;
  structured: unknown;
  isError: boolean;
  raw: string;
  usage: Usage;
};

export async function renderPrompt(
  name: string,
  vars: Record<string, string>,
): Promise<string> {
  const template = await readFile(path.join(PROMPTS_DIR, name), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
}

/**
 * Extract a JSON object from free-form model text.
 * Used only as a fallback; --json-schema normally gives us structured_output.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export async function runClaude(call: ClaudeCall): Promise<ClaudeResponse> {
  const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"];

  if (call.resume) args.push("--resume", call.resume);
  if (call.model) args.push("--model", call.model);
  if (call.disallowedTools?.length) args.push("--disallowed-tools", ...call.disallowedTools);
  if (call.addDirs?.length) args.push("--add-dir", ...call.addDirs);
  if (call.jsonSchema) args.push("--json-schema", JSON.stringify(call.jsonSchema));

  const res = await exec("claude", args, {
    cwd: call.cwd,
    timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // The prompt goes over stdin so large diffs never hit argv limits.
    stdin: call.prompt,
  });

  if (res.timedOut) {
    throw new Error(`claude timed out after ${(call.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(
      `claude did not return JSON (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 800)}`,
    );
  }

  const text = typeof parsed["result"] === "string" ? (parsed["result"] as string) : "";
  const structured =
    parsed["structured_output"] !== undefined && parsed["structured_output"] !== null
      ? parsed["structured_output"]
      : extractJson(text);

  return {
    sessionId: String(parsed["session_id"] ?? ""),
    text,
    structured,
    isError: parsed["is_error"] === true || parsed["subtype"] !== "success",
    raw: res.stdout,
    usage: parseUsage(parsed),
  };
}
