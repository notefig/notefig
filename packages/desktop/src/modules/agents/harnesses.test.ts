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
});
