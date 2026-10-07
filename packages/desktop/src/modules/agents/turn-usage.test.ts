import { describe, it, expect } from "vitest";
import type { PromptResponse } from "@notefig/shared/agent";
import { isMainAgent, normalizeTurnUsage, type UsageUpdate } from "./turn-usage";

// Payloads as recorded from each harness in the token-usage spike
// (docs/architecture/spikes/acp-token-usage-spike.md).

const claudeUpdate = {
  sessionUpdate: "usage_update",
  used: 27033,
  size: 1_000_000,
  cost: { amount: 0.33740125, currency: "USD" },
  _meta: { "_claude/model": "claude-fable-5-1" },
} as UsageUpdate;

const claudeResponse = {
  stopReason: "end_turn",
  usage: {
    inputTokens: 2,
    outputTokens: 4,
    cachedReadTokens: 10345,
    cachedWriteTokens: 16682,
    totalTokens: 27033,
  },
  _meta: {
    quota: {
      model_usage: [
        {
          model: "claude-haiku-4-5-20251001",
          token_count: { inputTokens: 900, outputTokens: 11, cachedInputTokens: 0, cachedWriteTokens: 0, reasoningOutputTokens: 0 },
        },
        {
          model: "claude-fable-5-1",
          token_count: { inputTokens: 2, outputTokens: 4, cachedInputTokens: 10345, cachedWriteTokens: 16682, reasoningOutputTokens: 0 },
        },
      ],
    },
  },
} as PromptResponse;

const opencodeResponse = {
  stopReason: "end_turn",
  usage: { inputTokens: 98, outputTokens: 2, totalTokens: 19044, cachedReadTokens: 18944 },
  _meta: {},
} as PromptResponse;

const opencodeUpdate = {
  sessionUpdate: "usage_update",
  used: 19042,
  size: 200_000,
  cost: { amount: 0.02, currency: "USD" },
} as UsageUpdate;

const devinResponse = {
  stopReason: "end_turn",
  usage: { totalTokens: 11527, inputTokens: 11500, outputTokens: 27, cachedReadTokens: 11488 },
  _meta: { "cognition.ai/userMessageId": "fb089d08" },
} as PromptResponse;

const devinUpdate = {
  sessionUpdate: "usage_update",
  used: 11527,
  size: 200_000,
  _meta: { "cognition.ai/inputTokens": 11500 },
} as UsageUpdate;

describe("normalizeTurnUsage", () => {
  it("Claude: per-model rows are the total; cost goes to the main model", () => {
    const { usage, costTotal } = normalizeTurnUsage({
      harnessId: "claude-code",
      response: claudeResponse,
      lastUpdate: claudeUpdate,
      model: "default",
      costBaseline: 0,
    });
    expect(costTotal).toBe(0.33740125);
    expect(usage?.total.tokens).toEqual({
      input: 902,
      cacheRead: 10345,
      cacheWrite: 16682,
      output: 15,
      thought: 0,
    });
    expect(usage?.byModel.map((row) => [row.model, row.usage.cost?.amount ?? null])).toEqual([
      ["claude-haiku-4-5-20251001", null],
      ["claude-fable-5-1", 0.33740125],
    ]);
  });

  it("opencode: input excludes cache already; one row for the session's model", () => {
    const { usage } = normalizeTurnUsage({
      harnessId: "opencode",
      response: opencodeResponse,
      lastUpdate: opencodeUpdate,
      model: "anthropic/claude-sonnet",
      costBaseline: 0,
    });
    expect(usage?.total.tokens).toEqual({
      input: 98,
      cacheRead: 18944,
      cacheWrite: 0,
      output: 2,
      thought: 0,
    });
    expect(usage?.byModel).toEqual([{ model: "anthropic/claude-sonnet", usage: usage?.total }]);
  });

  it("Devin: cache reads come out of input; no cost", () => {
    const { usage, costTotal } = normalizeTurnUsage({
      harnessId: "devin",
      response: devinResponse,
      lastUpdate: devinUpdate,
      model: null,
      costBaseline: 0,
    });
    expect(usage?.total.tokens.input).toBe(12);
    expect(usage?.total.tokens.cacheRead).toBe(11488);
    expect(usage?.total.cost).toBeNull();
    expect(costTotal).toBeNull();
  });

  it("recognizes Devin's counting under a custom harness id", () => {
    const { usage } = normalizeTurnUsage({
      harnessId: "custom:1",
      response: devinResponse,
      lastUpdate: null,
      model: null,
      costBaseline: 0,
    });
    expect(usage?.total.tokens.input).toBe(12);
  });

  it("cost is the running total's difference; a drop reads as a restart", () => {
    const at = (amount: number, baseline: number) =>
      normalizeTurnUsage({
        harnessId: "opencode",
        response: opencodeResponse,
        lastUpdate: { ...opencodeUpdate, cost: { amount, currency: "USD" } },
        model: null,
        costBaseline: baseline,
      }).usage?.total.cost?.amount;
    expect(at(0.5, 0.25)).toBe(0.25);
    expect(at(0.1, 0.25)).toBe(0.1);
  });

  describe("Devin per request", () => {
    // A 3-tool-step turn as recorded (devin-full.log): four requests, each
    // sent plain and again tagged root; the response is the last request.
    const req = (agent: string | null, input: number, output: number, cached: number) =>
      ({
        sessionUpdate: "usage_update",
        used: input + output,
        size: 200_000,
        _meta: {
          "cognition.ai/inputTokens": input,
          "cognition.ai/outputTokens": output,
          "cognition.ai/cachedReadTokens": cached,
          ...(agent ? { "cognition.ai/subagent_context": { parentAgentId: agent } } : {}),
        },
      }) as UsageUpdate;
    const requests: [number, number, number][] = [
      [11521, 137, 11200],
      [11664, 61, 11520],
      [11807, 99, 11648],
      [11909, 15, 11776],
    ];
    const lastResponse = {
      stopReason: "end_turn",
      usage: { totalTokens: 11924, inputTokens: 11909, outputTokens: 15, cachedReadTokens: 11776 },
      _meta: { "cognition.ai/userMessageId": "7fd27982" },
    } as PromptResponse;

    it("sums every request once, not just the last", () => {
      const turnUpdates = requests.flatMap(([i, o, c]) => [req(null, i, o, c), req("root", i, o, c)]);
      const { usage } = normalizeTurnUsage({
        harnessId: "devin",
        response: lastResponse,
        lastUpdate: turnUpdates.at(-1)!,
        turnUpdates,
        model: "swe-1-6-slow",
        costBaseline: 0,
      });
      expect(usage?.total.tokens).toEqual({
        input: 46901 - 46144,
        cacheRead: 46144,
        cacheWrite: 0,
        output: 312,
        thought: 0,
      });
    });

    it("counts a subagent's requests, sent once under its own id", () => {
      // devin-meta.log: two root requests around two subagent ones.
      const turnUpdates = [
        req(null, 11958, 226, 11904),
        req("root", 11958, 226, 11904),
        req("b25b62a7", 2123, 133, 2048),
        req("b25b62a7", 2270, 74, 2112),
        req(null, 12071, 131, 11936),
        req("root", 12071, 131, 11936),
      ];
      const { usage } = normalizeTurnUsage({
        harnessId: "devin",
        response: lastResponse,
        lastUpdate: turnUpdates.at(-1)!,
        turnUpdates,
        model: null,
        costBaseline: 0,
      });
      const tokens = usage!.total.tokens;
      expect(tokens.input + tokens.cacheRead).toBe(11958 + 2123 + 2270 + 12071);
      expect(tokens.output).toBe(226 + 133 + 74 + 131);
    });

    it("plain copies alone leave the response standing", () => {
      const { usage } = normalizeTurnUsage({
        harnessId: "devin",
        response: lastResponse,
        lastUpdate: null,
        turnUpdates: [req(null, 1, 1, 0)],
        model: null,
        costBaseline: 0,
      });
      expect(usage?.total.tokens.output).toBe(15);
    });

    it("credits are its cost: the running total's difference, typed credits", () => {
      const withCredits = (total: number) =>
        ({
          ...req("root", 11909, 15, 11776),
          _meta: { ...req("root", 11909, 15, 11776)._meta, "cognition.ai/totalCreditCost": total },
        }) as UsageUpdate;
      const result = normalizeTurnUsage({
        harnessId: "devin",
        response: lastResponse,
        lastUpdate: withCredits(3.5),
        model: null,
        costBaseline: 1.25,
      });
      const cost = { amount: 2.25, currency: "devin-credit", type: "credits" };
      expect(result.usage?.total.cost).toEqual(cost);
      expect(result.usage?.byModel[0].usage.cost).toEqual(cost);
      expect(result.costTotal).toBe(3.5);
    });

    it("tells a subagent's update from the main agent's", () => {
      expect(isMainAgent(req(null, 1, 1, 0))).toBe(true);
      expect(isMainAgent(req("root", 1, 1, 0))).toBe(true);
      expect(isMainAgent(req("b25b62a7", 1, 1, 0))).toBe(false);
    });
  });

  it("nothing reported is null usage", () => {
    expect(
      normalizeTurnUsage({
        harnessId: "opencode",
        response: { stopReason: "end_turn" },
        lastUpdate: null,
        model: null,
        costBaseline: 0,
      }),
    ).toEqual({ usage: null, costTotal: null });
  });

  it("a failed prompt after a costed turn is null: the held cost hasn't moved", () => {
    // The previous turn's usage_update (cost 0.5) is still the latest; its
    // total is already the baseline.
    expect(
      normalizeTurnUsage({
        harnessId: "claude-code",
        response: null,
        lastUpdate: { ...opencodeUpdate, cost: { amount: 0.5, currency: "USD" } },
        model: null,
        costBaseline: 0.5,
      }),
    ).toEqual({ usage: null, costTotal: 0.5 });
  });
});
