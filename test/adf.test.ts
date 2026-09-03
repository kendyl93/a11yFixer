import test from "node:test";
import assert from "node:assert/strict";
import { adfToMarkdown } from "../src/adf.js";
import { HANDOFF_HEADING, pickHandoffComment, validateHandoff } from "../src/jira.js";

/**
 * ADF -> Markdown is the seam where the human's handoff becomes the agent's specification.
 * These tests exist because a silent conversion bug here does not fail the run: it produces a
 * plausible-looking handoff with a section missing, and the agent implements the wrong thing.
 */

const doc = (...content: unknown[]) => ({ version: 1, type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

test("headings survive at every level, which is what the handoff marker depends on", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const md = adfToMarkdown(doc({ type: "heading", attrs: { level }, content: [text("Handoff")] }));
    assert.equal(md, `${"#".repeat(level)} Handoff`);
    // The whole gate on implementing anything at all.
    assert.ok(HANDOFF_HEADING.test(md), `level ${level} must satisfy the handoff marker`);
  }
  // A nonsense level is clamped rather than emitting a broken heading.
  assert.equal(adfToMarkdown(doc({ type: "heading", attrs: { level: 99 }, content: [text("X")] })), "###### X");
  assert.equal(adfToMarkdown(doc({ type: "heading", content: [text("X")] })), "# X");
});

test("inline marks convert, and code sits innermost so backticks are not escaped", () => {
  assert.equal(adfToMarkdown(doc(para(text("bold", [{ type: "strong" }])))), "**bold**");
  assert.equal(adfToMarkdown(doc(para(text("it", [{ type: "em" }])))), "_it_");
  assert.equal(adfToMarkdown(doc(para(text("gone", [{ type: "strike" }])))), "~~gone~~");
  assert.equal(adfToMarkdown(doc(para(text("aria-label", [{ type: "code" }])))), "`aria-label`");

  // A strong inline-code run: the backticks must be inside the asterisks.
  assert.equal(
    adfToMarkdown(doc(para(text("useId", [{ type: "strong" }, { type: "code" }])))),
    "**`useId`**",
  );

  assert.equal(
    adfToMarkdown(doc(para(text("WCAG 2.5.7", [{ type: "link", attrs: { href: "https://w3.org/x" } }])))),
    "[WCAG 2.5.7](https://w3.org/x)",
  );
  // Markdown has no underline; emphasis is closer than dropping the mark.
  assert.equal(adfToMarkdown(doc(para(text("u", [{ type: "underline" }])))), "_u_");
  // An unknown mark must not delete the text it wraps.
  assert.equal(adfToMarkdown(doc(para(text("kept", [{ type: "textColor" }])))), "kept");
});

test("lists convert, including a nested list inside an item", () => {
  const bullet = {
    type: "bulletList",
    content: [
      { type: "listItem", content: [para(text("first"))] },
      {
        type: "listItem",
        content: [
          para(text("second")),
          { type: "bulletList", content: [{ type: "listItem", content: [para(text("nested"))] }] },
        ],
      },
    ],
  };
  assert.equal(adfToMarkdown(doc(bullet)), "- first\n- second\n\n  - nested");

  const ordered = {
    type: "orderedList",
    attrs: { order: 1 },
    content: [
      { type: "listItem", content: [para(text("one"))] },
      { type: "listItem", content: [para(text("two"))] },
    ],
  };
  assert.equal(adfToMarkdown(doc(ordered)), "1. one\n2. two");

  // A list that starts at 3 keeps its numbering, so step references stay correct.
  const fromThree = { ...ordered, attrs: { order: 3 } };
  assert.equal(adfToMarkdown(doc(fromThree)), "3. one\n4. two");
});

test("code blocks keep their language and their contents verbatim", () => {
  const block = {
    type: "codeBlock",
    attrs: { language: "tsx" },
    content: [{ type: "text", text: '<button aria-label="Play">\n  {icon}\n</button>' }],
  };
  assert.equal(
    adfToMarkdown(doc(block)),
    '```tsx\n<button aria-label="Play">\n  {icon}\n</button>\n```',
  );
  // No language is still a fenced block, not indented prose.
  assert.match(adfToMarkdown(doc({ type: "codeBlock", content: [{ type: "text", text: "x" }] })), /^```\nx\n```$/);
});

test("block structures: quotes, rules, panels, tables and breaks", () => {
  assert.equal(adfToMarkdown(doc({ type: "blockquote", content: [para(text("quoted"))] })), "> quoted");
  assert.equal(adfToMarkdown(doc({ type: "rule" })), "---");
  assert.equal(
    adfToMarkdown(doc({ type: "panel", attrs: { panelType: "warning" }, content: [para(text("careful"))] })),
    "> careful",
  );
  assert.equal(adfToMarkdown(doc(para(text("a"), { type: "hardBreak" }, text("b")))), "a\nb");

  const table = {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [para(text("Control"))] },
          { type: "tableHeader", content: [para(text("Name"))] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [para(text("Play"))] },
          { type: "tableCell", content: [para(text("Play video"))] },
        ],
      },
    ],
  };
  assert.equal(
    adfToMarkdown(doc(table)),
    "| Control | Name |\n| --- | --- |\n| Play | Play video |",
  );
});

test("inline entities that Markdown has no syntax for still carry their text", () => {
  assert.equal(adfToMarkdown(doc(para({ type: "mention", attrs: { text: "@Paweł", id: "abc" } }))), "@Paweł");
  assert.equal(adfToMarkdown(doc(para({ type: "emoji", attrs: { text: "✅", shortName: ":check:" } }))), "✅");
  assert.equal(adfToMarkdown(doc(para({ type: "status", attrs: { text: "DONE" } }))), "`DONE`");
  assert.equal(adfToMarkdown(doc(para({ type: "inlineCard", attrs: { url: "https://x/y" } }))), "<https://x/y>");
  assert.match(adfToMarkdown(doc({ type: "mediaSingle", attrs: { alt: "screenshot" } })), /attachment: screenshot/);
});

test("an unknown node type degrades to its own contents instead of vanishing", () => {
  // The failure this prevents: Atlassian adds a node type, a section of the plan silently
  // disappears, and the agent implements a handoff with a hole in it.
  const md = adfToMarkdown(
    doc({ type: "someFutureLayout", content: [para(text("load-bearing requirement"))] }),
  );
  assert.equal(md, "load-bearing requirement");
});

test("adfToMarkdown accepts a plain string and refuses to throw on junk", () => {
  assert.equal(adfToMarkdown("  already markdown  "), "already markdown");
  assert.equal(adfToMarkdown(null), "");
  assert.equal(adfToMarkdown(undefined), "");
  assert.equal(adfToMarkdown(42), "");
  assert.equal(adfToMarkdown({}), "");
  assert.equal(adfToMarkdown(doc()), "");
});

test("a realistic handoff comment converts into something validateHandoff accepts", () => {
  const body = doc(
    { type: "heading", attrs: { level: 2 }, content: [text("Handoff")] },
    para(
      text("Give every control in "),
      text("VideoPlayerControls", [{ type: "code" }]),
      text(" an accessible name that matches its visible label, per "),
      text("WCAG 2.5.3", [{ type: "link", attrs: { href: "https://w3.org/2.5.3" } }]),
      text("."),
    ),
    { type: "heading", attrs: { level: 3 }, content: [text("Scope")] },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [para(text("FormFieldTimeInput — add a visible label"))] },
        { type: "listItem", content: [para(text("ClipTimeInput — forward the label to the input"))] },
      ],
    },
    { type: "codeBlock", attrs: { language: "tsx" }, content: [{ type: "text", text: "<label htmlFor={id}>" }] },
  );

  const markdown = adfToMarkdown(body);
  const comment = { author: "Paweł", created: "2026-09-02T10:00:00.000+0000", markdown };

  assert.equal(pickHandoffComment([comment]), comment);
  const result = validateHandoff(comment, 1);
  assert.equal(result.ok, true, `expected a valid handoff, got: ${JSON.stringify(result)}`);

  // The parts the implementation agent actually relies on.
  assert.match(markdown, /^## Handoff$/m);
  assert.match(markdown, /^### Scope$/m);
  assert.match(markdown, /`VideoPlayerControls`/);
  assert.match(markdown, /\[WCAG 2\.5\.3\]\(https:\/\/w3\.org\/2\.5\.3\)/);
  assert.match(markdown, /^- FormFieldTimeInput — add a visible label$/m);
  assert.match(markdown, /```tsx\n<label htmlFor=\{id\}>\n```/);
  // No runs of blank lines left behind by nested blocks.
  assert.ok(!/\n{3,}/.test(markdown));
});
