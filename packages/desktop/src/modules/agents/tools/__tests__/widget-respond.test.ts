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

describe("widget_respond sends diffs and diagrams to the document", () => {
  const named = {
    workspacePath: "/ws",
    taskId: "task_1",
    agents: { task: () => ({ get: () => ({ titleSource: "agent" }) }) },
    services: {},
  } as unknown as Parameters<typeof widgetRespond.execute>[0];
  /** Why a response with `markdown` is refused, or null when it isn't. */
  const refusal = async (markdown: string) => {
    const result = await widgetRespond.execute(named, { kind: "answer", markdown, title: "Answer" });
    return result.ok ? null : result.error;
  };
  const DIFF = "```ts diff\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n```";
  const DIAGRAM = "```mermaid\nflowchart LR\n  A --> B\n```";

  it("refuses a diff block or a diagram, saying where it goes", async () => {
    expect(await refusal(`Like so:\n\n${DIFF}`)).toContain("write it into the document");
    expect(await refusal(`The flow:\n\n${DIAGRAM}`)).toContain("draw it in the document");
  });

  it("refuses one in a quote or a list, or with Windows line ends", async () => {
    for (const block of [DIFF, DIAGRAM]) {
      const lines = block.split("\n");
      expect(await refusal(lines.map((line) => `> ${line}`).join("\n"))).not.toBeNull();
      expect(await refusal(`- Like so:\n\n${lines.map((line) => `  ${line}`).join("\n")}`)).not.toBeNull();
      expect(await refusal(`Like so:\r\n\r\n${lines.join("\r\n")}`)).not.toBeNull();
    }
  });

  it("takes plain code, an indented example, and prose naming the syntax", async () => {
    expect(await refusal("```ts\nconst diff = 1;\n```")).toBeNull();
    // The unified-diff language, however spaced, is not a diff block.
    expect(await refusal("``` diff\n-a\n+b\n```")).toBeNull();
    expect(await refusal(`Write it as:\n\n${DIAGRAM.split("\n").map((line) => `    ${line}`).join("\n")}`)).toBeNull();
    expect(await refusal("> Write a ts diff block, or a mermaid one.")).toBeNull();
  });

  it("leaves the schema saved responses are read with alone", () => {
    expect(WidgetRespondInputSchema.safeParse({ kind: "answer", markdown: DIAGRAM, title: "Saved" }).success).toBe(true);
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
