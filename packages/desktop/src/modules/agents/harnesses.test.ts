import { describe, it, expect } from "vitest";
import { testKv } from "@/testing/test-kv";
import { createHarnesses } from "./harnesses";
import { HARNESS_CUSTOM_KEY, HARNESS_SETTINGS_NAMESPACE } from "./harness-discovery";

describe("harnesses", () => {
  it("labels a harness from its settings, a built-in, or its raw id", async () => {
    const kv = testKv();
    const harnesses = createHarnesses({ kv });
    expect(harnesses.label("devin")).toBe("Devin");
    expect(harnesses.label("custom:gone")).toBe("custom:gone");

    await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY, [
      { id: "custom:1", label: "Lab", command: "lab-acp" },
    ]);
    expect(harnesses.label("custom:1")).toBe("Lab");
    expect(harnesses.configured().map((h) => h.id)).toContain("custom:1");
  });

  it("knows what the built-ins report, and believes the data over the table", () => {
    const harnesses = createHarnesses({ kv: testKv() });
    expect(harnesses.reporting("claude-code")).toEqual({ cost: true, limits: true });
    expect(harnesses.reporting("opencode")).toEqual({ cost: true, limits: false });
    expect(harnesses.reporting("devin")).toEqual({ cost: false, limits: false });
    expect(harnesses.reporting("gemini-cli")).toEqual({ cost: false, limits: false });
    expect(harnesses.reporting("custom:1", { cost: true })).toEqual({ cost: true, limits: false });
    expect(harnesses.reporting("devin", { limits: true })).toEqual({ cost: false, limits: true });
  });
});
