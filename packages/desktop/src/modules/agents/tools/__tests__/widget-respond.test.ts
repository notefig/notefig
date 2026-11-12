import { describe, it, expect } from "vitest";
import { WIDGET_RESPONSE_KINDS } from "@notefig/shared/agent";
import { WidgetRespondInputSchema, widgetRespond } from "../widget-respond";

describe("widget_respond input schema", () => {
  it("accepts every kind, a title on each but the choices", () => {
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "answer",
        markdown: "Two options stand out.",
        title: "Two options",
      }).success,
    ).toBe(true);
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "issue",
        markdown: "The doc references a section that no longer exists.",
        title: "Broken reference",
      }).success,
    ).toBe(true);
    for (const kind of ["single_choice", "multiple_choice"]) {
      expect(
        WidgetRespondInputSchema.safeParse({
          kind,
          markdown: "Which tiers should the section cover?",
          options: ["Pro", "Team", "Enterprise"],
        }).success,
      ).toBe(true);
    }
  });

  it("requires options on the choice kinds and refuses them elsewhere", () => {
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "single_choice",
        markdown: "Which tier?",
      }).success,
    ).toBe(false);
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "single_choice",
        markdown: "Which tier?",
        options: ["Only one"],
      }).success,
    ).toBe(false);
    expect(
      WidgetRespondInputSchema.safeParse({
        kind: "answer",
        markdown: "Done.",
        options: ["a", "b"],
      }).success,
    ).toBe(false);
  });

  it("requires a title of an answer and an issue, saying what it is for", () => {
    for (const kind of ["answer", "issue"]) {
      for (const title of [undefined, "", "   "]) {
        const parsed = WidgetRespondInputSchema.safeParse({ kind, markdown: "Done.", title });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]).toMatchObject({ path: ["title"] });
        expect(parsed.error?.issues[0].message).toContain("heading");
      }
    }
  });

  it("holds the title, a choice question and each option to a length", () => {
    const parse = (input: Record<string, unknown>) =>
      WidgetRespondInputSchema.safeParse({ kind: "single_choice", markdown: "Which?", options: ["a", "b"], ...input });
    expect(parse({ title: "x".repeat(80) }).success).toBe(true);
    expect(parse({ title: "x".repeat(81) }).success).toBe(false);
    expect(parse({ markdown: "x".repeat(200) }).success).toBe(true);
    expect(parse({ markdown: "x".repeat(201) }).success).toBe(false);
    expect(parse({ options: ["a", "x".repeat(61)] }).success).toBe(false);
    // An answer's markdown is a body, not a heading: no question limit.
    expect(
      WidgetRespondInputSchema.safeParse({ kind: "answer", markdown: "x".repeat(500), title: "Long" }).success,
    ).toBe(true);
  });

  it("advertises every kind and when to use it", () => {
    for (const [kind, { use }] of Object.entries(WIDGET_RESPONSE_KINDS)) {
      expect(widgetRespond.description).toContain(`"${kind}" — ${use}`);
    }
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

describe("widget_respond and diffs", () => {
  it("refuses a diff block, sending it to the document; plain code is fine", () => {
    const parsed = WidgetRespondInputSchema.safeParse({
      kind: "answer",
      markdown: "Like so:\n\n```ts diff\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n```",
      title: "The change",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toContain("write it into the document");
    expect(WidgetRespondInputSchema.safeParse({ kind: "answer", markdown: "```ts\nconst diff = 1;\n```", title: "Code" }).success).toBe(true);
    // The unified-diff language, however spaced, is not a diff block.
    expect(WidgetRespondInputSchema.safeParse({ kind: "answer", markdown: "``` diff\n-a\n+b\n```", title: "Diff" }).success).toBe(true);
  });
});

describe("widget_respond waits for the session's name", () => {
  const ctxNamed = (titleSource?: "agent") =>
    ({
      workspacePath: "/ws",
      taskId: "task_1",
      agents: {
        task: () => ({ get: () => ({ ...(titleSource ? { titleSource } : {}) }) }),
      },
      services: {},
    }) as unknown as Parameters<typeof widgetRespond.execute>[0];
  const input = { kind: "answer", markdown: "Done." } as const;

  it("refuses until the agent has named the session, saying how", async () => {
    const result = await widgetRespond.execute(ctxNamed(), input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("`session_rename`");
  });

  it("refuses for a task with no row", async () => {
    const ctx = {
      ...ctxNamed(),
      agents: { task: () => ({ get: () => undefined }) },
    } as unknown as Parameters<typeof widgetRespond.execute>[0];
    expect((await widgetRespond.execute(ctx, input)).ok).toBe(false);
  });

  it("delivers once the session is named", async () => {
    expect(await widgetRespond.execute(ctxNamed("agent"), input)).toEqual({
      ok: true,
      value: { recorded: true },
    });
  });
});
