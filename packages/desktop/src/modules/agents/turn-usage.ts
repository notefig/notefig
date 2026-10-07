/**
 * Turns what a harness reports about usage into the normalized shapes of
 * `@notefig/shared/agent`'s usage types. Pure, and the only place that knows
 * how each harness counts (docs/architecture/spikes/acp-token-usage-spike.md):
 *
 * - `PromptResponse.usage` (ACP-unstable) is per turn for every harness we
 *   ship, despite the SDK docs calling it a session total.
 * - Devin counts cache reads inside `inputTokens`; Claude and opencode don't.
 *   The agent's own `totalTokens` means something different in each, so it
 *   is ignored.
 * - Cost only arrives on `usage_update`, as a session-running total; a turn's
 *   cost is the difference from the total at the previous turn.
 * - Claude splits tokens per model in `_meta.quota.model_usage`; cost it
 *   reports only in total, so it goes to the main model.
 */
import {
  addTokens,
  emptyTokens,
  type ContextWindow,
  type ModelUsage,
  type PromptResponse,
  type SessionNotification,
  type TokenCounts,
  type TurnUsage,
  type Usage,
} from "@notefig/shared/agent";

export type UsageUpdate = Extract<
  SessionNotification["update"],
  { sessionUpdate: "usage_update" }
>;

/** The context fill a `usage_update` reports. */
export function contextFrom(update: UsageUpdate): ContextWindow {
  return { used: update.used, size: update.size };
}

/** The session-running cost a `usage_update` reports, if any. */
export function costTotalFrom(
  update: UsageUpdate | null,
): { amount: number; currency: string } | null {
  const cost = update?.cost;
  if (!cost || typeof cost.amount !== "number") return null;
  return { amount: cost.amount, currency: cost.currency };
}

export type NormalizeTurnUsageInput = {
  harnessId: string;
  response: PromptResponse | null;
  /** The latest `usage_update` this runtime has seen. */
  lastUpdate: UsageUpdate | null;
  /** The session's current model option, for harnesses that don't name it. */
  model: string | null;
  /** The running cost total at the end of the previous turn (0 at spawn). */
  costBaseline: number;
};

export type NormalizedTurnUsage = {
  usage: TurnUsage | null;
  /** The running total to use as the next turn's baseline. */
  costTotal: number | null;
};

type RawUsage = NonNullable<PromptResponse["usage"]>;

type QuotaTokenCount = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cachedWriteTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Devin reports cache reads inside input (cognition.ai `_meta` gives it away
 *  even under a custom harness id). */
function countsCacheInInput(
  harnessId: string,
  response: PromptResponse,
): boolean {
  if (harnessId === "devin") return true;
  const meta = response._meta;
  return (
    !!meta && Object.keys(meta).some((key) => key.startsWith("cognition.ai/"))
  );
}

function tokensFrom(raw: RawUsage, cacheInInput: boolean): TokenCounts {
  const cacheRead = count(raw.cachedReadTokens);
  const input = count(raw.inputTokens);
  return {
    input: cacheInInput ? Math.max(0, input - cacheRead) : input,
    cacheRead,
    cacheWrite: count(raw.cachedWriteTokens),
    output: count(raw.outputTokens),
    thought: count(raw.thoughtTokens),
  };
}

function quotaTokens(tokenCount: QuotaTokenCount): TokenCounts {
  return {
    input: count(tokenCount.inputTokens),
    cacheRead: count(tokenCount.cachedInputTokens),
    cacheWrite: count(tokenCount.cachedWriteTokens),
    output: count(tokenCount.outputTokens),
    thought: count(tokenCount.reasoningOutputTokens),
  };
}

/** Claude's per-model rows (`_meta.quota.model_usage`), when present. */
function quotaModelRows(
  response: PromptResponse,
): { model: string; tokens: TokenCounts }[] | null {
  const quota = (response._meta as { quota?: unknown } | null | undefined)
    ?.quota as { model_usage?: unknown } | undefined;
  if (!Array.isArray(quota?.model_usage)) return null;
  const rows: { model: string; tokens: TokenCounts }[] = [];
  for (const row of quota.model_usage as unknown[]) {
    const { model, token_count } = (row ?? {}) as {
      model?: unknown;
      token_count?: QuotaTokenCount;
    };
    if (typeof model !== "string" || !token_count) continue;
    rows.push({ model, tokens: quotaTokens(token_count) });
  }
  return rows.length > 0 ? rows : null;
}

/** The model a `usage_update` names (Claude's `_claude/model`). */
function updateModel(update: UsageUpdate | null): string | null {
  const model = (update?._meta as Record<string, unknown> | null | undefined)?.[
    "_claude/model"
  ];
  return typeof model === "string" ? model : null;
}

/** The turn's share of the running cost: the difference from the baseline.
 *  A total below the baseline means the agent's accumulator restarted under
 *  us, so what it reports now is all this turn's. */
function turnCost(
  runningCost: { amount: number; currency: string } | null,
  costBaseline: number,
): Usage["cost"] {
  if (!runningCost) return null;
  const amount =
    runningCost.amount >= costBaseline
      ? runningCost.amount - costBaseline
      : runningCost.amount;
  return { amount, currency: runningCost.currency };
}

/** Per-model rows: Claude's own split (its cost to the main model, since it
 *  reports cost only in total), else one row for the session's model. */
function byModelRows(
  quotaRows: { model: string; tokens: TokenCounts }[] | null,
  mainModel: string | null,
  total: Usage,
): ModelUsage[] {
  if (!quotaRows) return [{ model: mainModel, usage: total }];
  const costModel = quotaRows.some((row) => row.model === mainModel)
    ? mainModel
    : quotaRows[0].model;
  return quotaRows.map((row) => ({
    model: row.model,
    usage: { tokens: row.tokens, cost: row.model === costModel ? total.cost : null },
  }));
}

/** The turn's tokens. Claude's per-model rows also count subagents, side
 *  calls (titles) and compaction — the fuller figure — so when they exist
 *  the total is their sum, keeping total and byModel in agreement. */
function turnTokens(
  harnessId: string,
  response: PromptResponse | null,
  quotaRows: { model: string; tokens: TokenCounts }[] | null,
): TokenCounts {
  if (quotaRows) {
    return quotaRows.reduce((sum, row) => addTokens(sum, row.tokens), emptyTokens());
  }
  if (!response?.usage) return emptyTokens();
  return tokensFrom(response.usage, countsCacheInInput(harnessId, response));
}

export function normalizeTurnUsage({
  harnessId,
  response,
  lastUpdate,
  model,
  costBaseline,
}: NormalizeTurnUsageInput): NormalizedTurnUsage {
  const runningCost = costTotalFrom(lastUpdate);
  const costTotal = runningCost?.amount ?? null;
  const cost = turnCost(runningCost, costBaseline);
  // A running cost that hasn't moved since the last turn is the previous
  // turn's report, still held — not this turn's. Without tokens too, the
  // turn reported nothing (a failed prompt) and must not count as a turn.
  if (!response?.usage && !(cost && cost.amount !== 0)) return { usage: null, costTotal };

  const quotaRows = response ? quotaModelRows(response) : null;
  const total: Usage = { tokens: turnTokens(harnessId, response, quotaRows), cost };
  const mainModel = updateModel(lastUpdate) ?? model;
  return {
    usage: { total, byModel: byModelRows(quotaRows, mainModel, total) },
    costTotal,
  };
}
