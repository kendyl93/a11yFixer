import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exec } from "./proc.js";

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Tool policy per role. Built-in tools only; MCP tools stay reachable via ToolSearch. */
export const READ_ONLY_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit"];
export const EDIT_NO_SHELL_TOOLS = ["Bash", "NotebookEdit"];

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
  };
}
