import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";
import {
  parseJiraKey, parseDiscovery, isAlreadyDone, parseClaim, describeClaim,
  jiraAccessBlock, validateTicket, DEFAULT_JIRA_TOOL,
} from "../src/discovery.js";
import { parseVerdict, formatFailures, verdictIcon } from "../src/worker.js";
import { formatDuration } from "../src/spinner.js";
import { parseUsage, addUsage, emptyUsage, contextPercent, formatTokens, formatUsd, shortModel } from "../src/usage.js";
import { extractJson } from "../src/claude.js";

test("parseArgs reads the parent URL and --repo", () => {
  const a = parseArgs(["https://x.atlassian.net/browse/RAD-85350", "--repo", "/tmp/r"]);
  assert.equal(a.parentUrl, "https://x.atlassian.net/browse/RAD-85350");
  assert.equal(a.repo, "/tmp/r");
  assert.equal(a.dryRun, false);
  assert.equal(a.model, null);
});

test("parseArgs supports --dry-run and --model", () => {
  const a = parseArgs(["RAD-1", "--repo", "/tmp/r", "--dry-run", "--model", "opus"]);
  assert.equal(a.dryRun, true);
  assert.equal(a.model, "opus");
});

test("parseArgs rejects missing repo, missing url, bad key and unknown flags", () => {
  assert.throws(() => parseArgs(["RAD-1"]), /--repo/);
  assert.throws(() => parseArgs(["--repo", "/tmp/r"]), /parent Jira URL/);
  assert.throws(() => parseArgs(["not-a-jira-url", "--repo", "/tmp/r"]), /Jira issue key/);
  assert.throws(() => parseArgs(["RAD-1", "--repo", "/tmp/r", "--parallel"]), /unknown flag/);
});

test("parseJiraKey handles browse URLs, query strings and bare keys", () => {
  assert.equal(parseJiraKey("https://user-testing.atlassian.net/browse/RAD-85350"), "RAD-85350");
  assert.equal(parseJiraKey("https://x.atlassian.net/browse/rad-12?filter=1"), "RAD-12");
  assert.equal(parseJiraKey("RAD-7"), "RAD-7");
  assert.equal(parseJiraKey("https://x.atlassian.net/projects/RAD"), null);
});

test("isAlreadyDone only skips terminal statuses", () => {
  assert.equal(isAlreadyDone("Done"), true);
  assert.equal(isAlreadyDone("closed"), true);
  assert.equal(isAlreadyDone("To Do"), false);
  assert.equal(isAlreadyDone("In Progress"), false);
  assert.equal(isAlreadyDone(null), false);
});

const discovery = {
  jiraMcpAvailable: true,
  error: null,
  parent: { key: "RAD-85350", url: "https://x/browse/RAD-85350", summary: "Parent" },
  subtasks: [
    { key: "RAD-1001", url: "https://x/browse/RAD-1001", summary: "One", status: "To Do" },
    { key: "rad-1002", url: "https://x/browse/RAD-1002", summary: "Two", status: null },
  ],
};

test("parseDiscovery normalises keys and drops duplicates and the parent", () => {
  const d = parseDiscovery(
    { ...discovery, subtasks: [...discovery.subtasks, discovery.subtasks[0], { key: "RAD-85350", url: "u", summary: "s" }] },
    "RAD-85350",
  );
  assert.deepEqual(d.subtasks.map((s) => s.key), ["RAD-1001", "RAD-1002"]);
  assert.equal(d.subtasks[1]!.status, null);
});

test("parseDiscovery accepts zero subtasks", () => {
  assert.deepEqual(parseDiscovery({ ...discovery, subtasks: [] }, "RAD-85350").subtasks, []);
});

test("parseDiscovery fails loudly on missing MCP, errors, and parent mismatch", () => {
  assert.throws(() => parseDiscovery({ ...discovery, jiraMcpAvailable: false }, "RAD-85350"), /Jira MCP unavailable/);
  assert.throws(() => parseDiscovery({ ...discovery, error: "no access" }, "RAD-85350"), /no access/);
  assert.throws(() => parseDiscovery(discovery, "RAD-999"), /expected RAD-999/);
  assert.throws(() => parseDiscovery(null, "RAD-1"), /no structured output/);
});

test("parseVerdict accepts the three verdicts and defaults safely", () => {
  assert.equal(parseVerdict({ verdict: "PASS", explanation: "ok" }).verdict, "PASS");
  assert.equal(parseVerdict({ verdict: "fail", explanation: "x" }).verdict, "FAIL");
  assert.equal(parseVerdict({ verdict: "MANUAL_REVIEW_REQUIRED", explanation: "x" }).verdict, "MANUAL_REVIEW_REQUIRED");
  // An unparseable verdict must never become a silent PASS.
  assert.equal(parseVerdict({ verdict: "probably fine" }).verdict, "MANUAL_REVIEW_REQUIRED");
  assert.equal(parseVerdict(null).verdict, "MANUAL_REVIEW_REQUIRED");
});

test("formatFailures reports only failed commands, with both streams", () => {
  const out = formatFailures([
    { command: "yarn lint", exitCode: 0, stdout: "clean", stderr: "", timedOut: false },
    { command: "yarn test", exitCode: 1, stdout: "1 failing", stderr: "boom", timedOut: false },
  ]);
  assert.ok(!out.includes("yarn lint"));
  assert.match(out, /yarn test/);
  assert.match(out, /1 failing/);
  assert.match(out, /boom/);
});

test("extractJson recovers JSON from fenced or prose output", () => {
  assert.deepEqual(extractJson('```json\n{"verdict":"PASS"}\n```'), { verdict: "PASS" });
  assert.deepEqual(extractJson('Here you go: {"a":1} thanks'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
});

test("parseClaim treats anything but an explicit true as not done", () => {
  const c = parseClaim({ assigned: true, transitioned: true, assignee: "Piotr", status: "In Progress", error: null });
  assert.deepEqual(c, { assigned: true, transitioned: true, assignee: "Piotr", status: "In Progress", error: null, note: "" });
  assert.equal(parseClaim({ assigned: "yes", transitioned: 1 }).assigned, false);
  assert.equal(parseClaim(null).transitioned, false);
  assert.equal(parseClaim({ assigned: true, transitioned: true, assignee: "  " }).assignee, null);
});

test("describeClaim reports partial Jira failures instead of hiding them", () => {
  assert.equal(
    describeClaim(parseClaim({ assigned: true, transitioned: true, assignee: "Piotr", status: "In Progress" })),
    "assigned to Piotr · In Progress",
  );
  const partial = describeClaim(parseClaim({ assigned: true, transitioned: false, assignee: "Piotr", error: "no transition found" }));
  assert.match(partial, /status UNCHANGED/);
  assert.match(partial, /no transition found/);
  assert.match(describeClaim(parseClaim({ assigned: false, transitioned: false })), /NOT assigned/);
});

test("verdictIcon and formatDuration render human output", () => {
  assert.equal(verdictIcon("PASS"), "✅");
  assert.equal(verdictIcon("FAIL"), "❌");
  assert.equal(verdictIcon("MANUAL_REVIEW_REQUIRED"), "👀");
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_600_000), "1h00m");
  assert.equal(formatDuration(8_064_000), "2h14m");
});

// A real (trimmed) `claude -p --output-format json` payload.
const CLAUDE_JSON = {
  total_cost_usd: 0.236886,
  duration_ms: 5877,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 58563,
    cache_read_input_tokens: 0,
    output_tokens: 263,
    iterations: [
      { input_tokens: 2, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 58563 },
      { input_tokens: 4, output_tokens: 143, cache_read_input_tokens: 58563, cache_creation_input_tokens: 1200 },
    ],
  },
  modelUsage: {
    "claude-opus-5": {
      inputTokens: 6,
      outputTokens: 263,
      cacheReadInputTokens: 58563,
      cacheCreationInputTokens: 59763,
      costUSD: 0.236886,
      contextWindow: 1_000_000,
    },
  },
};

test("parseUsage reads context, tokens and cost from a real claude payload", () => {
  const u = parseUsage(CLAUDE_JSON as unknown as Record<string, unknown>);
  assert.equal(u.model, "claude-opus-5");
  assert.equal(u.contextWindow, 1_000_000);
  // Peak prompt = the largest single turn's full input, cache included.
  assert.equal(u.peakContextTokens, 4 + 58563 + 1200);
  assert.equal(contextPercent(u), 6);
  // Fresh tokens only; cache reads are tracked separately so they are not double counted.
  assert.equal(u.inputTokens, 6 + 59763);
  assert.equal(u.outputTokens, 263);
  assert.equal(u.cacheReadTokens, 58563);
  assert.equal(u.costUsd, 0.236886);
  assert.equal(u.sessions, 1);
});

test("parseUsage falls back to top-level usage when modelUsage is absent", () => {
  const u = parseUsage({ usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 } });
  assert.equal(u.inputTokens, 15);
  assert.equal(u.outputTokens, 7);
  assert.equal(contextPercent(u), null);
  assert.equal(parseUsage({}).sessions, 1);
});

test("addUsage sums tokens and cost but takes the peak context, not the sum", () => {
  const a = parseUsage(CLAUDE_JSON as unknown as Record<string, unknown>);
  const total = addUsage(addUsage(emptyUsage(), a), a);
  assert.equal(total.sessions, 2);
  assert.equal(total.outputTokens, 526);
  assert.ok(Math.abs(total.costUsd - 0.473772) < 1e-9);
  assert.equal(total.peakContextTokens, a.peakContextTokens);
  assert.equal(contextPercent(total), 6);
});

test("token, cost and model formatting stay compact", () => {
  assert.equal(formatTokens(940), "940");
  assert.equal(formatTokens(133_400), "133.4K");
  assert.equal(formatTokens(1_600_000), "1.6M");
  assert.equal(formatUsd(4.8), "$4.80");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(shortModel("claude-opus-5"), "opus-5");
  assert.equal(shortModel(null), "claude");
});

test("parseDiscovery captures the exact Jira tool name and rejects junk", () => {
  const withTool = { ...discovery, jiraToolName: "mcp__claude_ai_Atlassian__getJiraIssue" };
  assert.equal(parseDiscovery(withTool, "RAD-85350").jiraTool, "mcp__claude_ai_Atlassian__getJiraIssue");
  // A prose answer must not become a tool name.
  assert.equal(parseDiscovery({ ...discovery, jiraToolName: "the jira tool" }, "RAD-85350").jiraTool, DEFAULT_JIRA_TOOL);
  assert.equal(parseDiscovery(discovery, "RAD-85350").jiraTool, DEFAULT_JIRA_TOOL);
});

test("jiraAccessBlock gives an exact select query, not a semantic search", () => {
  const block = jiraAccessBlock("mcp__claude_ai_Atlassian__getJiraIssue");
  assert.match(block, /select:mcp__claude_ai_Atlassian__getJiraIssue/);
  assert.match(block, /prefix/);
  assert.ok(!block.includes("/tmp/ticket.md"));

  const withTicket = jiraAccessBlock("mcp__claude_ai_Atlassian__getJiraIssue", "/tmp/ticket.md");
  assert.match(withTicket, /\/tmp\/ticket\.md/);
  assert.match(withTicket, /authoritative statement of scope/);
});

const TICKET = "RAD-85351 — [a11y] Accessible names for all video-player controls. ".repeat(4);

test("validateTicket rejects anything that is not a real transcription", () => {
  assert.deepEqual(validateTicket({ fetched: true, markdown: TICKET }, "RAD-85351"), { ok: true, markdown: TICKET.trim() });
  // Agent admitted failure.
  assert.equal(validateTicket({ fetched: false, markdown: TICKET, error: "no tools" }, "RAD-85351").ok, false);
  // Too short to be a real ticket body.
  assert.equal(validateTicket({ fetched: true, markdown: "RAD-85351 accessible names" }, "RAD-85351").ok, false);
  // Long enough, but not actually this ticket.
  assert.equal(validateTicket({ fetched: true, markdown: "x".repeat(400) }, "RAD-85351").ok, false);
  assert.equal(validateTicket(null, "RAD-85351").ok, false);
});

test("parseArgs validates --jira-tool", () => {
  assert.equal(parseArgs(["RAD-1", "--repo", "/r"]).jiraTool, null);
  assert.equal(
    parseArgs(["RAD-1", "--repo", "/r", "--jira-tool", "mcp__foo__getJiraIssue"]).jiraTool,
    "mcp__foo__getJiraIssue",
  );
  assert.throws(() => parseArgs(["RAD-1", "--repo", "/r", "--jira-tool", "atlassian"]), /full MCP tool name/);
});
