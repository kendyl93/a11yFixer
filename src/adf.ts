/**
 * Atlassian Document Format -> Markdown.
 *
 * Jira's REST API returns comment bodies as ADF, a JSON document tree. The handoff comment is the
 * whole contract between the human and the implementation agent, so this conversion has to be
 * faithful rather than approximate: `validateHandoff` looks for a `## Handoff` heading, and the
 * agent reads the prose as its specification.
 *
 * Two rules keep it honest:
 *   - An unknown node is never dropped. Its children are converted, so a node type Atlassian adds
 *     later degrades to its own text instead of silently deleting a paragraph of the plan.
 *   - Nothing here is lossy on purpose. Where Markdown cannot express an ADF feature (a status
 *     lozenge, a media attachment) the node's text or a visible placeholder is emitted.
 */

type Node = {
  type?: string;
  text?: string;
  content?: Node[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** ADF wraps runs of text in marks; Markdown needs them applied innermost-first. */
const MARK_WRAPPERS: Record<string, (s: string) => string> = {
  strong: (s) => `**${s}**`,
  em: (s) => `_${s}_`,
  code: (s) => `\`${s}\``,
  strike: (s) => `~~${s}~~`,
  // Markdown has no underline. Emphasis is closer to the author's intent than dropping it.
  underline: (s) => `_${s}_`,
};

function applyMarks(text: string, marks: Node["marks"]): string {
  if (!marks?.length) return text;
  let out = text;
  // `code` must sit closest to the text, or the backticks would escape the other markers.
  const ordered = [...marks].sort((a, b) => Number(b.type === "code") - Number(a.type === "code"));
  for (const mark of ordered) {
    const type = str(mark.type);
    if (type === "link") {
      const href = str(mark.attrs?.["href"]);
      out = href ? `[${out}](${href})` : out;
      continue;
    }
    const wrap = MARK_WRAPPERS[type];
    if (wrap) out = wrap(out);
  }
  return out;
}

/** Inline content: text runs, breaks, mentions, emoji, cards. Produces no block structure. */
function inline(nodes: Node[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += applyMarks(str(node.text), node.marks);
        break;
      case "hardBreak":
        out += "\n";
        break;
      case "mention":
        out += str(node.attrs?.["text"]) || `@${str(node.attrs?.["id"])}`;
        break;
      case "emoji":
        out += str(node.attrs?.["text"]) || str(node.attrs?.["shortName"]);
        break;
      case "date":
        out += str(node.attrs?.["timestamp"]);
        break;
      case "status":
        out += `\`${str(node.attrs?.["text"])}\``;
        break;
      case "inlineCard":
      case "blockCard": {
        const url = str(node.attrs?.["url"]);
        out += url ? `<${url}>` : "";
        break;
      }
      default:
        // Unknown inline node: keep whatever text hangs off it.
        out += node.text ? str(node.text) : inline(node.content);
    }
  }
  return out;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : line.trim() === "" ? "" : `${prefix}${line}`))
    .join("\n");
}

/** List items can hold paragraphs, nested lists and code blocks, so each item recurses. */
function list(node: Node, ordered: boolean): string {
  const items = node.content ?? [];
  const start = ordered ? (num(node.attrs?.["order"]) ?? 1) : 1;
  return items
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : "- ";
      const body = blocks(item.content, "\n\n").trim();
      return `${marker}${indent(body, " ".repeat(marker.length))}`;
    })
    .join("\n");
}

function table(node: Node): string {
  const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
  if (rows.length === 0) return "";
  const cells = (row: Node): string[] =>
    (row.content ?? []).map((cell) => blocks(cell.content, " ").replace(/\s*\n\s*/g, " ").trim());
  const [head, ...body] = rows;
  const header = cells(head as Node);
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of body) lines.push(`| ${cells(row).join(" | ")} |`);
  return lines.join("\n");
}

/** One block-level node. Returns "" for a node that contributes nothing. */
function block(node: Node): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.content);
    case "heading": {
      const level = Math.min(Math.max(num(node.attrs?.["level"]) ?? 1, 1), 6);
      return `${"#".repeat(level)} ${inline(node.content)}`.trim();
    }
    case "codeBlock": {
      const lang = str(node.attrs?.["language"]);
      // Code is raw text: marks inside a code block would be literal backticks in the source.
      const body = (node.content ?? []).map((c) => str(c.text)).join("");
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case "bulletList":
      return list(node, false);
    case "orderedList":
      return list(node, true);
    case "blockquote":
      return indent(blocks(node.content, "\n\n"), "> ").replace(/^/, "> ");
    case "panel":
      // A panel is Jira's callout. Its type (info/warning/error) is the only thing Markdown loses.
      return indent(blocks(node.content, "\n\n"), "> ").replace(/^/, "> ");
    case "rule":
      return "---";
    case "table":
      return table(node);
    case "mediaSingle":
    case "mediaGroup":
    case "media": {
      const alt = str(node.attrs?.["alt"]);
      return `_(attachment${alt ? `: ${alt}` : ""})_`;
    }
    case "text":
      return applyMarks(str(node.text), node.marks);
    default:
      // Unknown block: never drop the plan. Convert whatever is inside it.
      return node.content ? blocks(node.content, "\n\n") : str(node.text);
  }
}

function blocks(nodes: Node[] | undefined, join: string): string {
  if (!nodes) return "";
  return nodes
    .map(block)
    .filter((s) => s.trim() !== "")
    .join(join);
}

/**
 * Convert an ADF document (or any ADF fragment) to Markdown.
 *
 * A plain string is returned unchanged, so a caller can pass either a v2 `body` string or a v3
 * ADF object without branching. Anything unrecognisable yields "" rather than throwing — the
 * caller decides whether an empty handoff is fatal, and it always is.
 */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!doc || typeof doc !== "object") return "";
  const node = doc as Node;
  const text = node.content ? blocks(node.content, "\n\n") : block(node);
  // Collapse the runs of blank lines that nested blocks tend to produce.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
