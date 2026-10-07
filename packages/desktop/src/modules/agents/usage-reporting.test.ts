import { describe, it, expect } from "vitest";
import { usageReportingOf } from "./usage-reporting";

describe("usageReportingOf", () => {
  it("knows the built-ins", () => {
    expect(usageReportingOf("claude-code")).toEqual({ cost: true, limits: true });
    expect(usageReportingOf("opencode")).toEqual({ cost: true, limits: false });
    expect(usageReportingOf("devin")).toEqual({ cost: false, limits: false });
  });

  it("judges any harness by what it has sent", () => {
    expect(usageReportingOf("custom:1")).toEqual({ cost: false, limits: false });
    expect(usageReportingOf("custom:1", { cost: true })).toEqual({ cost: true, limits: false });
    expect(usageReportingOf("devin", { limits: true })).toEqual({ cost: false, limits: true });
  });
});
