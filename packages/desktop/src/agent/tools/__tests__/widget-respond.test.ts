import { describe, it, expect } from "vitest";
import type { ToolContext } from "@metrists/shared/agent";
import { widgetRespond, WidgetRespondInputSchema } from "../widget-respond";

const ctx = {
  workspacePath: "/ws",
  taskId: "task_1",
  agents: {},
} as unknown as ToolContext;

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

describe("widget_respond execute", () => {
  // Validate-and-acknowledge by design: the record of the call is the
  // tool_call transcript entry the service writes (turnId + rawInput),
  // which deriveWidgetResponse reads — there is no state to mutate here.
  it("acknowledges without touching anything", async () => {
    const result = await widgetRespond.execute(ctx, {
      kind: "answer",
      markdown: "Done — trimmed the intro to two paragraphs.",
    });
    expect(result).toEqual({ ok: true, value: { recorded: true } });
  });
});
