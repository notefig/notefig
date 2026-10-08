import {
  addSummary,
  addTurn,
  cacheHitRate,
  costType,
  emptySummary,
  totalTokens,
  type TurnUsage,
} from "./usage";

function turn(
  tokens: Partial<TurnUsage["total"]["tokens"]>,
  cost: number | null,
  model: string | null = "m",
): TurnUsage {
  const total = {
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thought: 0, ...tokens },
    cost: cost === null ? null : { amount: cost, currency: "USD", type: "currency" as const },
  };
  return { total, byModel: [{ model, usage: total }] };
}

describe("usage summaries", () => {
  it("adds turns' tokens, cost and count", () => {
    const summary = addTurn(
      addTurn(emptySummary(), turn({ input: 10, output: 2 }, 0.5)),
      turn({ input: 3, cacheRead: 100, output: 1 }, 0.25),
    );
    expect(summary.turns).toBe(2);
    expect(summary.total.tokens).toEqual({
      input: 13,
      cacheRead: 100,
      cacheWrite: 0,
      output: 3,
      thought: 0,
    });
    expect(summary.total.cost).toEqual({ amount: 0.75, currency: "USD", type: "currency" });
    expect(totalTokens(summary.total.tokens)).toBe(116);
  });

  it("keeps cost null for a harness that reports none", () => {
    const summary = addTurn(addTurn(emptySummary(), turn({ input: 1 }, null)), turn({ input: 1 }, null));
    expect(summary.total.cost).toBeNull();
  });

  it("merges rows by model", () => {
    const summary = addTurn(
      addTurn(emptySummary(), turn({ output: 1 }, null, "a")),
      turn({ output: 2 }, null, "b"),
    );
    const again = addTurn(summary, turn({ output: 4 }, null, "a"));
    expect(again.byModel.map((row) => [row.model, row.usage.tokens.output])).toEqual([
      ["a", 5],
      ["b", 2],
    ]);
  });

  it("keeps the first currency rather than mixing", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const usd = addTurn(emptySummary(), turn({}, 1));
    const mixed = addTurn(usd, {
      total: { tokens: usd.total.tokens, cost: { amount: 5, currency: "devin-credit", type: "credits" } },
      byModel: [],
    });
    expect(mixed.total.cost).toEqual({ amount: 1, currency: "USD", type: "currency" });
    warn.mockRestore();
  });

  it("keeps a cost's type; one saved before types existed is money", () => {
    const credits: TurnUsage = {
      total: { ...turn({ input: 1 }, null).total, cost: { amount: 1.5, currency: "devin-credit", type: "credits" } },
      byModel: [],
    };
    const summary = addTurn(addTurn(emptySummary(), credits), credits);
    expect(summary.total.cost).toEqual({ amount: 3, currency: "devin-credit", type: "credits" });

    const legacy = turn({ input: 1 }, 0.5);
    delete (legacy.total.cost as { type?: unknown }).type;
    expect(costType(legacy.total.cost!)).toBe("currency");
    expect(addTurn(addTurn(emptySummary(), legacy), turn({}, 0.25)).total.cost).toEqual({
      amount: 0.75,
      currency: "USD",
      type: "currency",
    });
  });

  it("adds whole summaries, keeping the target's extra fields", () => {
    const a = { ...addTurn(emptySummary(), turn({ input: 1 }, 1)), label: "x" };
    const b = addTurn(emptySummary(), turn({ input: 2 }, 2));
    const sum = addSummary(a, b);
    expect(sum.label).toBe("x");
    expect(sum.turns).toBe(2);
    expect(sum.total.cost?.amount).toBe(3);
  });

  it("counts cache reads as a share of all input", () => {
    const tokens = { input: 10, cacheRead: 80, cacheWrite: 10, output: 500, thought: 0 };
    expect(cacheHitRate(tokens)).toBe(0.8);
    expect(cacheHitRate({ ...tokens, input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});
