/**
 * Token usage and cost, normalized across harnesses. One shape at every
 * level: a turn's {@link TurnUsage}, a session's {@link SessionUsage} and a
 * time-series bucket are all a {@link UsageSummary} kept by {@link addTurn},
 * so no two levels can disagree about how turns add up.
 *
 * Harness quirks (Devin counting cache inside input, cost arriving as a
 * session-running total, …) are resolved before anything reaches these
 * types — see the desktop agent subsystem's turn-usage normalizer.
 */

export type TokenCounts = {
  /** Uncached input only — cache reads and writes are counted apart. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thought: number;
};

/**
 * What a harness charges, in the unit it bills in:
 *
 * - `"currency"`: money, `currency` an ISO 4217 code (`"USD"`).
 * - `"credits"`: the harness's own billing unit, named in `currency`
 *   (`"devin-credit"`). Not money — what a credit is worth depends on the
 *   account's plan — so a reader that adds harnesses together keeps the two
 *   apart, or converts.
 *
 * Costs saved before `type` existed are all money; read them through
 * {@link costType}.
 */
export type Cost = {
  amount: number;
  currency: string;
  type: "currency" | "credits";
};

/** A cost's type; one saved before `type` existed is money. */
export function costType(cost: Cost): Cost["type"] {
  return cost.type ?? "currency";
}

/** Tokens and cost: what every level adds up. */
export type Usage = {
  tokens: TokenCounts;
  /** Null when the harness reports no cost (a harness either always does or never does). */
  cost: Cost | null;
};

export type ModelUsage = {
  /** As the harness names it; null when it doesn't say. */
  model: string | null;
  usage: Usage;
};

/** What one turn spent. */
export type TurnUsage = {
  total: Usage;
  /** Usually one entry; some harnesses report side models (e.g. a title
   *  call). Cost the harness can't split goes to the turn's main model. */
  byModel: ModelUsage[];
};

/** Any number of turns added together: a session, or a time bucket. */
export type UsageSummary = TurnUsage & { turns: number };

export type ContextWindow = {
  /** Tokens currently in context. */
  used: number;
  /** The model's context window. */
  size: number;
};

export type SessionUsage = UsageSummary & {
  /** The latest context fill the harness reported, live across turns. */
  context: ContextWindow | null;
};

/** Where the account stands against a harness's limits: allowed, close to
 *  a limit, or held back by one. */
export type UsageLimitStatus = "ok" | "warning" | "blocked" | "unknown";

/** One rolling limit window — Claude's 5-hour and 7-day windows, a primary
 *  and secondary window elsewhere. Ids are the harness's own; anything the
 *  harness doesn't say is null rather than guessed. */
export type UsageLimitWindow = {
  /** The harness's name for the window, e.g. "five_hour". */
  id: string;
  /** Fraction used, 0–1. */
  utilization: number;
  /** When the window resets (epoch ms). */
  resetsAt: number | null;
  /** How long the window is (ms), when known. */
  durationMs: number | null;
};

/** A harness's account limits as last reported. Belongs to the harness
 *  account, not a session — every session on that harness shares it. */
export type UsageLimits = {
  status: UsageLimitStatus;
  windows: UsageLimitWindow[];
  /** Whether usage beyond the plan (pay-as-you-go overage) is being drawn on;
   *  null when the harness doesn't say. */
  usingOverage: boolean | null;
};

export function emptyTokens(): TokenCounts {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thought: 0 };
}

export function emptySummary(): UsageSummary {
  return {
    total: { tokens: emptyTokens(), cost: null },
    byModel: [],
    turns: 0,
  };
}

/** Every token, cached or not. */
export function totalTokens(tokens: TokenCounts): number {
  return (
    tokens.input +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.output +
    tokens.thought
  );
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    thought: a.thought + b.thought,
  };
}

function addCost(a: Cost | null, b: Cost | null): Cost | null {
  if (!b) return a;
  if (!a) return { ...b };
  if (a.currency !== b.currency || costType(a) !== costType(b)) {
    // One summary covers one harness's turns, and a harness bills in one
    // unit — so this is an adapter changing under us, not a real mix.
    console.warn(
      `[usage] dropping ${b.amount} ${b.currency}: summary is in ${a.currency}`,
    );
    return a;
  }
  return { amount: a.amount + b.amount, currency: a.currency, type: costType(a) };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { tokens: addTokens(a.tokens, b.tokens), cost: addCost(a.cost, b.cost) };
}

/** Merge model rows by model. */
export function addModelUsage(
  a: readonly ModelUsage[],
  b: readonly ModelUsage[],
): ModelUsage[] {
  const merged = a.map((row) => ({ model: row.model, usage: row.usage }));
  for (const row of b) {
    const index = merged.findIndex((existing) => existing.model === row.model);
    if (index === -1) merged.push({ model: row.model, usage: row.usage });
    else merged[index] = {
      model: row.model,
      usage: addUsage(merged[index].usage, row.usage),
    };
  }
  return merged;
}

/** Fold one turn into a summary. Pure: returns a new summary. */
export function addTurn<S extends UsageSummary>(summary: S, turn: TurnUsage): S {
  return {
    ...summary,
    total: addUsage(summary.total, turn.total),
    byModel: addModelUsage(summary.byModel, turn.byModel),
    turns: summary.turns + 1,
  };
}

/** Add whole summaries together (e.g. buckets into a day's total). */
export function addSummary<S extends UsageSummary>(
  summary: S,
  other: UsageSummary,
): S {
  return {
    ...summary,
    total: addUsage(summary.total, other.total),
    byModel: addModelUsage(summary.byModel, other.byModel),
    turns: summary.turns + other.turns,
  };
}
