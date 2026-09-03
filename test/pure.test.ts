import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli.js";
import {
  parseJiraKey, isUnavailable, hasLabel, describeClaim, parsePlan,
  validateHandoff, pickHandoffComment, DEFAULT_READY_LABEL, HANDOFF_MARKER,
} from "../src/jira.js";
import { siteFromUrl, pickInProgressTransition } from "../src/jira-api.js";
import { formatDuration } from "../src/spinner.js";
import { parseUsage, addUsage, emptyUsage, contextPercent, formatTokens, formatUsd, shortModel } from "../src/usage.js";
import { extractJson, findSkill, readSkillBody, IMPLEMENT_SKILL } from "../src/claude.js";

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

test("isUnavailable skips reviewed and finished work, but not in-progress work", () => {
  for (const status of [
    "Code Review", "In Review", "In Verification",
    "QA", "Testing", "Done", "closed", "Resolved", "Cancelled",
  ]) {
    assert.equal(isUnavailable(status), true, status);
  }
  // Not started, or started but not yet reviewed: both are candidates. In-progress matters
  // especially, because ship-tickets moves a subtask there itself before writing its code.
  for (const status of [
    "To Do", "Backlog", "Open", "Ready", "Selected for Development", null,
    "In Progress", "in development", "In Dev", "Started",
  ]) {
    assert.equal(isUnavailable(status), false, String(status));
  }
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

const comment = (markdown: string, created = "2026-09-01T10:00:00.000+0000") => ({
  author: "Paweł",
  created,
  markdown,
});

test("validateHandoff demands the marker heading and real substance", () => {
  const ok = validateHandoff(comment(HANDOFF), 1);
  assert.equal(ok.ok, true);
  assert.equal((ok as { markdown: string }).markdown, HANDOFF.trim());
  assert.equal((ok as { author: string }).author, "Paweł");

  // Other heading levels and trailing words are still a handoff.
  assert.equal(validateHandoff(comment(HANDOFF.replace("## Handoff", "### Handoff document")), 1).ok, true);

  // Prose with no marker is somebody's chatter, not an agreed plan.
  const noMarker = validateHandoff(comment("Looks good to me, ship it. ".repeat(20)), 1);
  assert.equal(noMarker.ok, false);
  assert.match((noMarker as { error: string }).error, /Handoff/);

  // Marker present but empty underneath.
  assert.equal(validateHandoff(comment(`${HANDOFF_MARKER}\ndo the thing`), 1).ok, false);
});

test("validateHandoff says whether the subtask was silent or just off-topic", () => {
  const silent = validateHandoff(null, 0);
  assert.equal(silent.ok, false);
  assert.match((silent as { error: string }).error, /no comments at all/);

  const chatter = validateHandoff(null, 4);
  assert.match((chatter as { error: string }).error, /4 comment\(s\)/);
});

test("pickHandoffComment takes the newest handoff, so a correction supersedes the original", () => {
  const comments = [
    comment(`${HANDOFF_MARKER}\n\nfirst plan`, "2026-09-01T10:00:00.000+0000"),
    comment("unrelated chatter", "2026-09-01T11:00:00.000+0000"),
    comment(`${HANDOFF_MARKER}\n\ncorrected plan`, "2026-09-01T12:00:00.000+0000"),
  ];
  assert.match(pickHandoffComment(comments)!.markdown, /corrected plan/);
  assert.equal(pickHandoffComment([comment("no marker here")]), null);
  assert.equal(pickHandoffComment([]), null);
});

test("siteFromUrl takes the Jira host from the run's own argument", () => {
  assert.equal(siteFromUrl("https://user-testing.atlassian.net/browse/RAD-1"), "https://user-testing.atlassian.net");
  assert.equal(siteFromUrl("RAD-1"), null);
  assert.equal(siteFromUrl("ftp://x/browse/RAD-1"), null);
});

test("pickInProgressTransition prefers the named status, then the category, and never guesses", () => {
  const t = (name: string, toStatus: string, toCategory: string, id = "1") =>
    ({ id, name, toStatus, toCategory });

  // An exactly-named target wins even when another indeterminate option comes first.
  assert.equal(
    pickInProgressTransition([t("Start review", "In Review", "indeterminate", "5"), t("Start", "In Progress", "indeterminate", "3")])!.id,
    "3",
  );
  // Whatever the project calls its in-progress column, the category identifies it.
  assert.equal(pickInProgressTransition([t("Begin", "Development", "indeterminate", "7")])!.id, "7");
  // Nothing that moves work forward: refuse rather than risk closing the issue.
  assert.equal(pickInProgressTransition([t("Done", "Done", "done"), t("Reject", "Cancelled", "done")]), null);
  assert.equal(pickInProgressTransition([]), null);
});

test("the implement prompt inlines the skill body and the handoff path", async () => {
  const prompt = await readFile(new URL("../prompts/implement.md", import.meta.url), "utf8");
  // Load-bearing: drop this placeholder and the phase silently becomes a prompt of our own
  // invention rather than the skill the engineer maintains.
  assert.match(prompt, /\{\{IMPLEMENT_SKILL\}\}/);
  assert.match(prompt, /\{\{HANDOFF_PATH\}\}/);
});

test("findSkill locates the implement skill this machine will actually run", async () => {
  const found = await findSkill(IMPLEMENT_SKILL, process.cwd());
  // The preflight must find a real SKILL.md, or refuse to start the run.
  assert.ok(found === null || found.endsWith(`skills/${IMPLEMENT_SKILL}/SKILL.md`));
  assert.equal(await findSkill("definitely-not-a-skill-name", process.cwd()), null);
});

test("readSkillBody strips frontmatter and keeps the instructions verbatim", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ship-tickets-skill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "SKILL.md");
  const body = "Implement the work.\n\nUse /tdd where possible, at pre-agreed seams.\n\n---\n\nCommit your work.";
  await writeFile(file, `---\nname: implement\ndescription: "x"\ndisable-model-invocation: true\n---\n\n${body}\n`);
  // Verbatim: a `---` inside the body is not frontmatter and must survive.
  assert.equal(await readSkillBody(file), body);
});

const readyThree = ["RAD-1001", "RAD-1002", "RAD-1003"].map((key) => ({
  key, url: `https://x/browse/${key}`, summary: key, status: "To Do", labels: ["ready-for-implementation"],
}));

test("parsePlan keeps the agent's order but fixes its bookkeeping", () => {
  const plan = parsePlan({ order: [
    { key: "rad-1002", dependsOn: null, reason: "shared primitive first" },
    { key: "RAD-1001", dependsOn: "RAD-1002", reason: "consumes it" },
    { key: "RAD-1003", dependsOn: null, reason: "" },
  ] }, readyThree);
  assert.deepEqual(plan.map((p) => p.key), ["RAD-1002", "RAD-1001", "RAD-1003"]);
  assert.equal(plan[1]!.dependsOn, "RAD-1002");
  assert.equal(plan[0]!.reason, "shared primitive first");
});

test("parsePlan never produces a branch stacked on nothing", () => {
  // Forward reference: RAD-1003 has not been built yet when RAD-1001 runs.
  const forward = parsePlan({ order: [
    { key: "RAD-1001", dependsOn: "RAD-1003" },
    { key: "RAD-1002", dependsOn: null },
    { key: "RAD-1003", dependsOn: null },
  ] }, readyThree);
  assert.equal(forward[0]!.dependsOn, null);
  // Self-reference, unknown key, and a subtask the agent invented are all discarded.
  const junk = parsePlan({ order: [
    { key: "RAD-1001", dependsOn: "RAD-1001" },
    { key: "RAD-9999", dependsOn: null },
    { key: "RAD-1001", dependsOn: null },
  ] }, readyThree);
  assert.equal(junk[0]!.dependsOn, null);
  assert.deepEqual(junk.map((p) => p.key), ["RAD-1001", "RAD-1002", "RAD-1003"]);
});

test("parsePlan still builds everything when the agent returns junk", () => {
  // A forgotten subtask is built unstacked rather than silently dropped.
  const partial = parsePlan({ order: [{ key: "RAD-1003", dependsOn: null }] }, readyThree);
  assert.deepEqual(partial.map((p) => p.key), ["RAD-1003", "RAD-1001", "RAD-1002"]);
  assert.deepEqual(parsePlan(null, readyThree).map((p) => p.key), ["RAD-1001", "RAD-1002", "RAD-1003"]);
  assert.deepEqual(parsePlan({ order: "nope" }, readyThree).map((p) => p.dependsOn), [null, null, null]);
});

test("extractJson recovers JSON from fenced or prose output", () => {
  assert.deepEqual(extractJson('```json\n{"found":true}\n```'), { found: true });
  assert.deepEqual(extractJson('Here you go: {"a":1} thanks'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
});

const claim = (over: Partial<Parameters<typeof describeClaim>[0]> = {}) => ({
  assigned: true,
  transitioned: true,
  assignee: "Piotr",
  status: "In Progress",
  error: null,
  note: "",
  ...over,
});

test("describeClaim reports partial Jira failures instead of hiding them", () => {
  assert.equal(describeClaim(claim()), "assigned to Piotr · In Progress");

  const partial = describeClaim(claim({ transitioned: false, error: "no transition found" }));
  assert.match(partial, /status UNCHANGED/);
  assert.match(partial, /no transition found/);

  assert.match(describeClaim(claim({ assigned: false, transitioned: false })), /NOT assigned/);
  // An unnamed account still reads as a sentence.
  assert.match(describeClaim(claim({ assignee: null })), /assigned to you/);
});

test("parseArgs keeps --fresh and --fresh-force distinct, and force implies fresh", () => {
  const plain = parseArgs(["RAD-1", "--repo", "/r"]);
  assert.equal(plain.fresh, false);
  assert.equal(plain.freshForce, false);

  const fresh = parseArgs(["RAD-1", "--repo", "/r", "--fresh"]);
  assert.equal(fresh.fresh, true);
  // Destroying committed work is never something --fresh alone can do.
  assert.equal(fresh.freshForce, false);

  const forced = parseArgs(["RAD-1", "--repo", "/r", "--fresh-force"]);
  assert.equal(forced.fresh, true);
  assert.equal(forced.freshForce, true);
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
