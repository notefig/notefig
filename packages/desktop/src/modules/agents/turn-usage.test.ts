import { describe, it, expect } from "vitest";
import type { PromptResponse } from "@notefig/shared/agent";
import { normalizeTurnUsage, type UsageUpdate } from "./turn-usage";

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
