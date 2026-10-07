import { describe, it, expect } from "vitest";
import { limitsFrom } from "./usage-limits";
import type { UsageUpdate } from "./turn-usage";

const update = (meta: Record<string, unknown> | undefined) =>
  ({ sessionUpdate: "usage_update", used: 1, size: 2, _meta: meta }) as UsageUpdate;

describe("limitsFrom", () => {
  it("reads Claude's rate-limit windows (as recorded in the token-usage spike)", () => {
    const limits = limitsFrom(
      update({
        "_claude/model": "claude-fable-5-1",
        "_claude/rateLimit": {
          status: "allowed",
          resetsAt: 1791355200,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          isUsingOverage: false,
          unifiedWindows: {
            five_hour: { utilization: 0.02, resetsAt: 1791355200 },
            seven_day: { utilization: 0.22, resetsAt: 1791342000 },
            seven_day_overage_included: { utilization: 0.15, resetsAt: 1791342000 },
          },
        },
      }),
    );
    expect(limits).toEqual({
      status: "ok",
      usingOverage: false,
      windows: [
        { id: "five_hour", utilization: 0.02, resetsAt: 1791355200000, durationMs: 5 * 3_600_000 },
        { id: "seven_day", utilization: 0.22, resetsAt: 1791342000000, durationMs: 7 * 24 * 3_600_000 },
        {
          id: "seven_day_overage_included",
          utilization: 0.15,
          resetsAt: 1791342000000,
          durationMs: 7 * 24 * 3_600_000,
        },
      ],
    });
  });

  it("maps warning and rejection, and leaves unknown windows' length null", () => {
    const limits = limitsFrom(
      update({
        "_claude/rateLimit": {
          status: "rejected",
          unifiedWindows: { mystery: { utilization: 1 }, broken: { utilization: "lots" } },
        },
      }),
    );
    expect(limits).toEqual({
      status: "blocked",
      usingOverage: null,
      windows: [{ id: "mystery", utilization: 1, resetsAt: null, durationMs: null }],
    });
    expect(
      limitsFrom(update({ "_claude/rateLimit": { status: "allowed_warning" } }))?.status,
    ).toBe("warning");
  });

  it("is null when the harness reports no limits", () => {
    expect(limitsFrom(update(undefined))).toBeNull();
    expect(limitsFrom(update({ "cognition.ai/inputTokens": 5 }))).toBeNull();
  });
});
