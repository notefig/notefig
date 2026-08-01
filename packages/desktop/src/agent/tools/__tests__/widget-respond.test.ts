import { describe, it, expect } from "vitest";
import { WidgetRespondInputSchema } from "../widget-respond";

describe("widget_respond input schema", () => {
  it("accepts answer and issue kinds, with title optional", () => {
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "answer",
        markdown: "Two options stand out.",
      }).success,
    ).toBe(true);
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "issue",
        markdown: "The doc references a section that no longer exists.",
        title: "Broken reference",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown kinds and empty markdown", () => {
    expect(
      WidgetRespondInputSchema.safeParse({ kind: "summary", markdown: "x" })
        .success,
    ).toBe(false);
    expect(
      WidgetRespondInputSchema.safeParse({ kind: "answer", markdown: "" })
        .success,
    ).toBe(false);
    expect(WidgetRespondInputSchema.safeParse({}).success).toBe(false);
  });
});
