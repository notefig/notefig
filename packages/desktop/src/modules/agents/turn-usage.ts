/**
 * Turns what a harness reports about usage into the normalized shapes of
 * `@notefig/shared/agent`'s usage types (docs/architecture/spikes/
 * acp-token-usage-spike.md). How each harness counts — its per-model split,
 * its credits, its per-request tokens — is its adapter's `UsageReader`;
 * this file only folds what the reader returns.
 *
 * - `PromptResponse.usage` (ACP-unstable) is per turn for every harness we
 *   ship, despite the SDK docs calling it a session total. The agent's own
 *   `totalTokens` means something different in each, so it is ignored.
 * - Cost only arrives on `usage_update`, as a session-running total; a turn's
 *   cost is the difference from the total at the previous turn.
 */
import {
  addTokens,
  emptyTokens,
  type ContextWindow,
  type Cost,
  type ModelUsage,
  type PromptResponse,
  type SessionNotification,
  type TokenCounts,
  type TurnUsage,
  type Usage,
} from "@notefig/shared/agent";
import {
  tokensFrom,
  type ModelTokens,
  type UsageReader,
  type UsageUpdate,
} from "@/modules/harness-adapters";

/** The context fill a `usage_update` reports. */
export function contextFrom(update: UsageUpdate): ContextWindow {
  return { used: update.used, size: update.size };
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
  /** How this task's harness counts. */
  usage: UsageReader;
  response: PromptResponse | null;
  /** The latest main-agent `usage_update` this runtime has seen. */
  lastUpdate: UsageUpdate | null;
  /** Every `usage_update` that arrived during this turn, in order. */
  turnUpdates?: readonly UsageUpdate[];
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

/** The difference of a running total from its baseline; a total below the
 *  baseline means the accumulator restarted, so all of it is this turn's. */
function sinceBaseline(total: number, baseline: number): number {
  return total >= baseline ? total - baseline : total;
}

/** The turn's share of the running cost: the difference from the baseline. */
function turnCost(runningCost: Cost | null, costBaseline: number): Cost | null {
  if (!runningCost) return null;
  return { ...runningCost, amount: sinceBaseline(runningCost.amount, costBaseline) };
}

/** Per-model rows: the harness's own split (its cost to the main model, as
 *  a harness that splits reports cost only in total), else one row for the
 *  session's model. */
function byModelRows(
  modelRows: ModelTokens[] | null,
  mainModel: string | null,
  total: Usage,
): ModelUsage[] {
  if (!modelRows) return [{ model: mainModel, usage: total }];
  const costModel = modelRows.some((row) => row.model === mainModel)
    ? mainModel
    : modelRows[0].model;
  return modelRows.map((row) => ({
    model: row.model,
    usage: {
      tokens: row.tokens,
      cost: row.model === costModel ? total.cost : null,
    },
  }));
}

/** The turn's tokens. A harness's per-model rows also count subagents,
 *  side calls (titles) and compaction — the fuller figure — so when they
 *  exist the total is their sum, keeping total and byModel in agreement. */
function turnTokens(
  usage: UsageReader,
  response: PromptResponse | null,
  modelRows: ModelTokens[] | null,
  perRequest: TokenCounts | null,
): TokenCounts {
  if (modelRows) {
    return modelRows.reduce((sum, row) => addTokens(sum, row.tokens), emptyTokens());
  }
  if (perRequest) return perRequest;
  if (!response?.usage) return emptyTokens();
  return tokensFrom(response.usage, usage.cacheInInput(response));
}

export function normalizeTurnUsage({
  usage: reader,
  response,
  lastUpdate,
  turnUpdates = [],
  model,
  costBaseline,
}: NormalizeTurnUsageInput): NormalizedTurnUsage {
  const runningCost = lastUpdate ? reader.costTotal(lastUpdate) : null;
  const costTotal = runningCost?.amount ?? null;
  const cost = turnCost(runningCost, costBaseline);
  const perRequest = reader.requestTokens(turnUpdates);
  // A running total that hasn't moved since the last turn is the previous
  // turn's report, still held — not this turn's. Without tokens too, the
  // turn reported nothing (a failed prompt) and must not count as a turn.
  if (!response?.usage && !perRequest && !(cost && cost.amount !== 0)) {
    return { usage: null, costTotal };
  }

  const modelRows = response ? reader.modelRows(response) : null;
  const total: Usage = {
    tokens: turnTokens(reader, response, modelRows, perRequest),
    cost,
  };
  const mainModel = (lastUpdate && reader.updateModel(lastUpdate)) ?? model;
  return {
    usage: { total, byModel: byModelRows(modelRows, mainModel, total) },
    costTotal,
  };
}
