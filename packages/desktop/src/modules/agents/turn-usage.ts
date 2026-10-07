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
 * - Devin's `PromptResponse.usage` is its last model request only. It sends
 *   one `usage_update` per request, with that request's tokens in `_meta`,
 *   twice for the main agent (plain, then tagged `subagent_context: root`)
 *   and once, tagged with its own id, for each subagent request — so the
 *   turn is the sum of the tagged updates
 *   (docs/architecture/spikes/acp-usage-multistep-spike.md). Its credits
 *   (`cognition.ai/totalCreditCost`) are a session-running total like cost,
 *   kept as {@link Credits} in `"devin-credit"`s, never as money.
 * - Claude splits tokens per model in `_meta.quota.model_usage`; cost it
 *   reports only in total, so it goes to the main model.
 */
import {
  addTokens,
  emptyTokens,
  type ContextWindow,
  type Credits,
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

/** The agent a Devin `usage_update` or chunk came from: `"root"` for the
 *  main agent, a subagent's id, or null when it isn't tagged (Devin's
 *  plain copy of a main-agent update, and every other harness). */
export function agentOf(update: { _meta?: Record<string, unknown> | null }): string | null {
  const context = update._meta?.["cognition.ai/subagent_context"] as
    | { parentAgentId?: unknown }
    | undefined;
  return typeof context?.parentAgentId === "string" ? context.parentAgentId : null;
}

/** Whether an update or chunk is the session's own agent's, not a
 *  subagent's — the only ones that speak for the session's context fill
 *  and transcript. */
export function isMainAgent(update: { _meta?: Record<string, unknown> | null }): boolean {
  const agent = agentOf(update);
  return agent === null || agent === "root";
}

/** A subagent's reasoning or reply chunk, streamed into its parent's
 *  session — not the session agent's words. */
export function isSubagentChunk(update: SessionNotification["update"]): boolean {
  return (
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk") &&
    !isMainAgent(update)
  );
}

export type NormalizeTurnUsageInput = {
  harnessId: string;
  response: PromptResponse | null;
  /** The latest main-agent `usage_update` this runtime has seen. */
  lastUpdate: UsageUpdate | null;
  /** Every `usage_update` that arrived during this turn, in order. */
  turnUpdates?: readonly UsageUpdate[];
  /** The session's current model option, for harnesses that don't name it. */
  model: string | null;
  /** The running cost total at the end of the previous turn (0 at spawn). */
  costBaseline: number;
  /** The running credit total at the end of the previous turn (0 at spawn). */
  creditBaseline?: number;
};

export type NormalizedTurnUsage = {
  usage: TurnUsage | null;
  /** The running total to use as the next turn's baseline. */
  costTotal: number | null;
  /** The running credit total to use as the next turn's baseline. */
  creditTotal: number | null;
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

function metaNumber(update: UsageUpdate | null, key: string): number | null {
  const value = (update?._meta as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Devin's per-request tokens, summed over the turn's tagged updates; null
 *  when the turn has none (another harness, or a Devin that sends plain
 *  copies only), so the response stands. */
function requestTokens(updates: readonly UsageUpdate[]): TokenCounts | null {
  let sum: TokenCounts | null = null;
  for (const update of updates) {
    if (agentOf(update) === null) continue;
    const input = metaNumber(update, "cognition.ai/inputTokens");
    if (input === null) continue;
    const tokens = tokensFrom(
      {
        inputTokens: input,
        outputTokens: metaNumber(update, "cognition.ai/outputTokens") ?? 0,
        cachedReadTokens: metaNumber(update, "cognition.ai/cachedReadTokens"),
        cachedWriteTokens: metaNumber(update, "cognition.ai/cachedWriteTokens"),
        totalTokens: 0,
      },
      true,
    );
    sum = sum ? addTokens(sum, tokens) : tokens;
  }
  return sum;
}

/** The unit Devin's `totalCreditCost` counts in. */
const DEVIN_CREDIT = "devin-credit";

/** The difference of a running total from its baseline; a total below the
 *  baseline means the accumulator restarted, so all of it is this turn's. */
function sinceBaseline(total: number, baseline: number): number {
  return total >= baseline ? total - baseline : total;
}

/** The model a `usage_update` names (Claude's `_claude/model`). */
function updateModel(update: UsageUpdate | null): string | null {
  const model = (update?._meta as Record<string, unknown> | null | undefined)?.[
    "_claude/model"
  ];
  return typeof model === "string" ? model : null;
}

/** The turn's share of the running cost: the difference from the baseline. */
function turnCost(
  runningCost: { amount: number; currency: string } | null,
  costBaseline: number,
): Usage["cost"] {
  if (!runningCost) return null;
  return {
    amount: sinceBaseline(runningCost.amount, costBaseline),
    currency: runningCost.currency,
  };
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
    usage: {
      tokens: row.tokens,
      cost: row.model === costModel ? total.cost : null,
      credits: row.model === costModel ? total.credits : null,
    },
  }));
}

/** The turn's tokens. Claude's per-model rows also count subagents, side
 *  calls (titles) and compaction — the fuller figure — so when they exist
 *  the total is their sum, keeping total and byModel in agreement. */
function turnTokens(
  harnessId: string,
  response: PromptResponse | null,
  quotaRows: { model: string; tokens: TokenCounts }[] | null,
  perRequest: TokenCounts | null,
): TokenCounts {
  if (quotaRows) {
    return quotaRows.reduce((sum, row) => addTokens(sum, row.tokens), emptyTokens());
  }
  if (perRequest) return perRequest;
  if (!response?.usage) return emptyTokens();
  return tokensFrom(response.usage, countsCacheInInput(harnessId, response));
}

export function normalizeTurnUsage({
  harnessId,
  response,
  lastUpdate,
  turnUpdates = [],
  model,
  costBaseline,
  creditBaseline = 0,
}: NormalizeTurnUsageInput): NormalizedTurnUsage {
  const runningCost = costTotalFrom(lastUpdate);
  const costTotal = runningCost?.amount ?? null;
  const cost = turnCost(runningCost, costBaseline);
  const creditTotal = metaNumber(lastUpdate, "cognition.ai/totalCreditCost");
  const credits: Credits | null =
    creditTotal === null
      ? null
      : { amount: sinceBaseline(creditTotal, creditBaseline), unit: DEVIN_CREDIT };
  const perRequest = requestTokens(turnUpdates);
  // A running total that hasn't moved since the last turn is the previous
  // turn's report, still held — not this turn's. Without tokens too, the
  // turn reported nothing (a failed prompt) and must not count as a turn.
  if (
    !response?.usage &&
    !perRequest &&
    !(cost && cost.amount !== 0) &&
    !(credits && credits.amount !== 0)
  ) {
    return { usage: null, costTotal, creditTotal };
  }

  const quotaRows = response ? quotaModelRows(response) : null;
  const total: Usage = {
    tokens: turnTokens(harnessId, response, quotaRows, perRequest),
    cost,
    credits,
  };
  const mainModel = updateModel(lastUpdate) ?? model;
  return {
    usage: { total, byModel: byModelRows(quotaRows, mainModel, total) },
    costTotal,
    creditTotal,
  };
}
