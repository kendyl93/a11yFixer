/**
 * Token / cost / context accounting, read straight out of the `claude -p --output-format json`
 * response. Nothing here is estimated by the harness.
 */
export type Usage = {
  model: string | null;
  contextWindow: number | null;
  /** Peak prompt size across the session's turns — what "context %" is measured against. */
  peakContextTokens: number;
  /** New tokens sent (fresh input + cache writes). Cache reads are excluded: summing them
   *  across turns counts the same tokens repeatedly and inflates the number. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number;
  sessions: number;
};

export const emptyUsage = (): Usage => ({
  model: null,
  contextWindow: null,
  peakContextTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  durationMs: 0,
  sessions: 0,
});

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Parse one `claude -p --output-format json` result object. */
export function parseUsage(parsed: Record<string, unknown>): Usage {
  const u = (parsed["usage"] ?? {}) as Record<string, unknown>;
  const models = (parsed["modelUsage"] ?? {}) as Record<string, Record<string, unknown>>;

  // Peak prompt size: the largest single turn's full input, cache included.
  const turns = Array.isArray(u["iterations"]) ? (u["iterations"] as Record<string, unknown>[]) : [u];
  const peakContextTokens = turns.reduce((peak, t) => {
    const size = num(t["input_tokens"]) + num(t["cache_read_input_tokens"]) + num(t["cache_creation_input_tokens"]);
    return Math.max(peak, size);
  }, 0);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let contextWindow: number | null = null;
  let model: string | null = null;
  let modelTokens = -1;

  for (const [name, m] of Object.entries(models)) {
    const fresh = num(m["inputTokens"]) + num(m["cacheCreationInputTokens"]);
    inputTokens += fresh;
    outputTokens += num(m["outputTokens"]);
    cacheReadTokens += num(m["cacheReadInputTokens"]);
    const window = num(m["contextWindow"]);
    if (window > (contextWindow ?? 0)) contextWindow = window;
    // When several models ran, label the line with whichever did the most work.
    if (fresh + num(m["outputTokens"]) > modelTokens) {
      modelTokens = fresh + num(m["outputTokens"]);
      model = name;
    }
  }

  if (inputTokens === 0 && outputTokens === 0) {
    inputTokens = num(u["input_tokens"]) + num(u["cache_creation_input_tokens"]);
    outputTokens = num(u["output_tokens"]);
    cacheReadTokens = num(u["cache_read_input_tokens"]);
  }

  return {
    model,
    contextWindow,
    peakContextTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd: num(parsed["total_cost_usd"]),
    durationMs: num(parsed["duration_ms"]),
    sessions: 1,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    model: b.model ?? a.model,
    contextWindow: Math.max(a.contextWindow ?? 0, b.contextWindow ?? 0) || null,
    peakContextTokens: Math.max(a.peakContextTokens, b.peakContextTokens),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    durationMs: a.durationMs + b.durationMs,
    sessions: a.sessions + b.sessions,
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatWindow(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1_000)}K`;
}

export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function shortModel(model: string | null): string {
  return model ? model.replace(/^claude-/, "") : "claude";
}

export function contextPercent(u: Usage): number | null {
  if (!u.contextWindow || u.peakContextTokens === 0) return null;
  return Math.round((u.peakContextTokens / u.contextWindow) * 100);
}

/** Compact one-liner for a single Claude session. */
export function formatUsage(u: Usage): string {
  const parts = [shortModel(u.model)];
  const pct = contextPercent(u);
  if (pct !== null) parts.push(`ctx ${pct}% of ${formatWindow(u.contextWindow as number)}`);
  parts.push(`↓ ${formatTokens(u.inputTokens)}  ↑ ${formatTokens(u.outputTokens)}`);
  parts.push(formatUsd(u.costUsd));
  return parts.join("  ·  ");
}

/** Rollup line for a subtask or a whole run. */
export function formatUsageTotal(u: Usage, label: string): string {
  const pct = contextPercent(u);
  const parts = [`${u.sessions} Claude session${u.sessions === 1 ? "" : "s"}`];
  if (pct !== null) parts.push(`peak ctx ${pct}% of ${formatWindow(u.contextWindow as number)}`);
  parts.push(`↓ ${formatTokens(u.inputTokens)}  ↑ ${formatTokens(u.outputTokens)}`);
  parts.push(formatUsd(u.costUsd));
  return `${label}: ${parts.join("  ·  ")}`;
}
