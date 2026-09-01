import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "../src/cli.js";
import {
  parseJiraKey, parseSurvey, isAlreadyDone, hasLabel, parseClaim, describeClaim,
  jiraAccessBlock, validateHandoff, DEFAULT_JIRA_TOOL, DEFAULT_READY_LABEL,
  HANDOFF_MARKER, jiraToolPrefix, jiraWriteSelectQuery,
} from "../src/jira.js";
import { formatDuration } from "../src/spinner.js";
import { parseUsage, addUsage, emptyUsage, contextPercent, formatTokens, formatUsd, shortModel } from "../src/usage.js";
import { extractJson, findSkill, isUnknownCommand, IMPLEMENT_SKILL } from "../src/claude.js";

test("parseArgs reads the parent URL and --repo, and defaults the ready label", () => {
  const a = parseArgs(["https://x.atlassian.net/browse/RAD-85350", "--repo", "/tmp/r"]);
  assert.equal(a.parentUrl, "https://x.atlassian.net/browse/RAD-85350");
  assert.equal(a.repo, "/tmp/r");
  assert.equal(a.label, DEFAULT_READY_LABEL);
  assert.equal(a.dryRun, false);
  assert.equal(a.model, null);
});

test("parseArgs supports --dry-run, --model and --label", () => {
  const a = parseArgs(["RAD-1", "--repo", "/tmp/r", "--dry-run", "--model", "opus", "--label", "agent-ready"]);
  assert.equal(a.dryRun, true);
  assert.equal(a.model, "opus");
  assert.equal(a.label, "agent-ready");
});

test("parseArgs rejects missing repo, missing url, bad key, empty label and unknown flags", () => {
  assert.throws(() => parseArgs(["RAD-1"]), /--repo/);
  assert.throws(() => parseArgs(["--repo", "/tmp/r"]), /parent Jira URL/);
  assert.throws(() => parseArgs(["not-a-jira-url", "--repo", "/tmp/r"]), /Jira issue key/);
  assert.throws(() => parseArgs(["RAD-1", "--repo", "/tmp/r", "--label", ""]), /--label/);
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

const survey = {
  jiraMcpAvailable: true,
  error: null,
  parent: { key: "RAD-85350", url: "https://x/browse/RAD-85350", summary: "Parent" },
  subtasks: [
    { key: "RAD-1001", url: "https://x/browse/RAD-1001", summary: "One", status: "To Do", labels: ["ready-for-implementation"] },
    { key: "rad-1002", url: "https://x/browse/RAD-1002", summary: "Two", status: null, labels: [] },
  ],
};

test("parseSurvey normalises keys, keeps labels, and drops duplicates and the parent", () => {
  const s = parseSurvey(
    { ...survey, subtasks: [...survey.subtasks, survey.subtasks[0], { key: "RAD-85350", url: "u", summary: "s", labels: [] }] },
    "RAD-85350",
  );
  assert.deepEqual(s.subtasks.map((x) => x.key), ["RAD-1001", "RAD-1002"]);
  assert.deepEqual(s.subtasks[0]!.labels, ["ready-for-implementation"]);
  assert.deepEqual(s.subtasks[1]!.labels, []);
  assert.equal(s.subtasks[1]!.status, null);
});

test("parseSurvey reports unlabelled subtasks too, so a typo is visible", () => {
  const s = parseSurvey(survey, "RAD-85350");
  assert.equal(s.subtasks.length, 2);
  assert.equal(s.subtasks.filter((x) => hasLabel(x, DEFAULT_READY_LABEL)).length, 1);
});

test("parseSurvey accepts zero subtasks", () => {
  assert.deepEqual(parseSurvey({ ...survey, subtasks: [] }, "RAD-85350").subtasks, []);
});

test("parseSurvey fails loudly on missing MCP, errors, and parent mismatch", () => {
  assert.throws(() => parseSurvey({ ...survey, jiraMcpAvailable: false }, "RAD-85350"), /Jira MCP unavailable/);
  assert.throws(() => parseSurvey({ ...survey, error: "no access" }, "RAD-85350"), /no access/);
  assert.throws(() => parseSurvey(survey, "RAD-999"), /expected RAD-999/);
  assert.throws(() => parseSurvey(null, "RAD-1"), /no structured output/);
});

test("parseSurvey captures the exact Jira tool name and rejects junk", () => {
  const withTool = { ...survey, jiraToolName: "mcp__claude_ai_Atlassian__getJiraIssue" };
  assert.equal(parseSurvey(withTool, "RAD-85350").jiraTool, "mcp__claude_ai_Atlassian__getJiraIssue");
  // A prose answer must not become a tool name.
  assert.equal(parseSurvey({ ...survey, jiraToolName: "the jira tool" }, "RAD-85350").jiraTool, DEFAULT_JIRA_TOOL);
  assert.equal(parseSurvey(survey, "RAD-85350").jiraTool, DEFAULT_JIRA_TOOL);
});

const sub = (labels: string[]) => ({ key: "RAD-1", url: "u", summary: "s", status: null, labels });

test("hasLabel ignores case and stray whitespace but not typos", () => {
  assert.equal(hasLabel(sub(["Ready-For-Implementation"]), DEFAULT_READY_LABEL), true);
  assert.equal(hasLabel(sub([" ready-for-implementation "]), DEFAULT_READY_LABEL), true);
  assert.equal(hasLabel(sub(["a11y", "ready-for-implementation"]), DEFAULT_READY_LABEL), true);
  // A near miss must NOT be picked up — the operator has to see and fix it.
  assert.equal(hasLabel(sub(["ready-for-implementaton"]), DEFAULT_READY_LABEL), false);
  assert.equal(hasLabel(sub([]), DEFAULT_READY_LABEL), false);
});

const HANDOFF = `${HANDOFF_MARKER}\n\nUse the existing IconButton primitive. ${"Give every control an accessible name. ".repeat(6)}`;

test("validateHandoff demands the marker heading and real substance", () => {
  assert.deepEqual(validateHandoff({ found: true, handoff: HANDOFF }), { ok: true, markdown: HANDOFF.trim() });
  // Other heading levels and trailing words are still a handoff.
  assert.equal(validateHandoff({ found: true, handoff: HANDOFF.replace("## Handoff", "### Handoff document") }).ok, true);
  // Agent admitted it found nothing.
  assert.equal(validateHandoff({ found: false, handoff: HANDOFF, error: "no comment" }).ok, false);
  // Prose with no marker is somebody's chatter, not an agreed plan.
  const noMarker = validateHandoff({ found: true, handoff: "Looks good to me, ship it. ".repeat(20) });
  assert.equal(noMarker.ok, false);
  assert.match((noMarker as { error: string }).error, /Handoff/);
  // Marker present but empty underneath.
  assert.equal(validateHandoff({ found: true, handoff: `${HANDOFF_MARKER}\ndo the thing` }).ok, false);
  assert.equal(validateHandoff(null).ok, false);
});

test("the implement prompt still begins with the /implement slash command", async () => {
  const prompt = await readFile(new URL("../prompts/implement.md", import.meta.url), "utf8");
  // Load-bearing: claude only expands a skill when the prompt STARTS with the command.
  // Reflow this file and the skill silently stops running.
  assert.match(prompt, /^\/implement /);
  assert.match(prompt, /\{\{HANDOFF_PATH\}\}/);
});

test("an unknown slash command is detected, because claude reports it as a success", () => {
  // Real payload: {"is_error":false,"subtype":"success","num_turns":0,
  //                "result":"Unknown command: /implementt. Did you mean /implement?"}
  assert.equal(isUnknownCommand("Unknown command: /implementt. Did you mean /implement?"), true);
  assert.equal(isUnknownCommand("  Unknown command: /implement"), true);
  assert.equal(isUnknownCommand("I implemented the accessible names. Unknown command: /x"), false);
  assert.equal(isUnknownCommand(""), false);
});

test("findSkill locates the implement skill this machine will actually run", async () => {
  const found = await findSkill(IMPLEMENT_SKILL, process.cwd());
  // The preflight must find a real SKILL.md, or refuse to start the run.
  assert.ok(found === null || found.endsWith(`skills/${IMPLEMENT_SKILL}/SKILL.md`));
  assert.equal(await findSkill("definitely-not-a-skill-name", process.cwd()), null);
});

test("extractJson recovers JSON from fenced or prose output", () => {
  assert.deepEqual(extractJson('```json\n{"found":true}\n```'), { found: true });
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

test("jiraAccessBlock gives an exact select query, not a semantic search", () => {
  const block = jiraAccessBlock("mcp__claude_ai_Atlassian__getJiraIssue");
  assert.match(block, /select:mcp__claude_ai_Atlassian__getJiraIssue/);
  assert.match(block, /prefix/);
  // Extra tools are fully qualified with the same prefix, in the same one call.
  const withJql = jiraAccessBlock("mcp__claude_ai_Atlassian__getJiraIssue", ["searchJiraIssuesUsingJql"]);
  assert.match(withJql, /select:mcp__claude_ai_Atlassian__getJiraIssue,mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql/);
});

test("jiraWriteSelectQuery builds one exact multi-tool query from the discovered prefix", () => {
  assert.equal(jiraToolPrefix("mcp__claude_ai_Atlassian__getJiraIssue"), "mcp__claude_ai_Atlassian__");
  const q = jiraWriteSelectQuery("mcp__other__getJiraIssue");
  assert.ok(q.startsWith("select:"));
  // Every tool is fully qualified with the same prefix, comma separated, no spaces.
  assert.ok(!q.includes(" "));
  assert.match(q, /mcp__other__atlassianUserInfo/);
  assert.match(q, /mcp__other__transitionJiraIssue/);
  assert.equal(q.slice("select:".length).split(",").length, 6);
});

test("parseArgs validates --jira-tool", () => {
  assert.equal(parseArgs(["RAD-1", "--repo", "/r"]).jiraTool, null);
  assert.equal(
    parseArgs(["RAD-1", "--repo", "/r", "--jira-tool", "mcp__foo__getJiraIssue"]).jiraTool,
    "mcp__foo__getJiraIssue",
  );
  assert.throws(() => parseArgs(["RAD-1", "--repo", "/r", "--jira-tool", "atlassian"]), /full MCP tool name/);
});

test("parseArgs survives paste artifacts and explains a real stray argument", () => {
  // Empty args and a lone backslash from a mangled multi-line paste are ignored.
  const a = parseArgs(["RAD-1", "", "\\", "--repo", " /tmp/r ", "--dry-run"]);
  assert.equal(a.repo, "/tmp/r");
  assert.equal(a.dryRun, true);
  // A genuine stray argument still fails, but says what it saw and how to fix it.
  assert.throws(
    () => parseArgs(["RAD-1", "--repo", "/tmp/r", "took"]),
    /unexpected argument: "took"[\s\S]*single-line form/,
  );
});

test("formatDuration renders human output", () => {
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
