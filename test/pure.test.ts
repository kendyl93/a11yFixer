import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";
import { parseJiraKey, parseDiscovery, isAlreadyDone, parseClaim, describeClaim } from "../src/discovery.js";
import { parseVerdict, formatFailures, formatDuration, verdictIcon } from "../src/worker.js";
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
  assert.equal(formatDuration(3_600_000), "60m00s");
});
