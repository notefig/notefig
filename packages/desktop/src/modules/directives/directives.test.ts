import { describe, it, expect, vi } from "vitest";
import { createDirectives, type DirectiveNamespace } from "./directives";

const ctx = { workspacePath: "/ws", taskId: "task_1", harnessId: "claude-code" };

const model: DirectiveNamespace = {
  name: "model",
  candidates: () => [
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet", description: "Fast" },
    { value: "anthropic/haiku", label: "Haiku" },
  ],
  resolve: (values) => ({ config: [{ category: "model", value: values[values.length - 1] }] }),
};

const skill: DirectiveNamespace = {
  name: "skill",
  candidates: () => [{ value: "review", label: "review" }],
  resolve: (values) => ({ commands: values.map((name) => ({ name })) }),
};

function directives() {
  const api = createDirectives();
  api.register(model);
  api.register(skill);
  return api;
}

describe("directives", () => {
  it("lists the namespaces for a bare @, and members as soon as a query names or matches them", () => {
    const api = directives();

    expect(api.search("", ctx, 8)).toEqual([
      { namespace: "model", value: null, label: "model:" },
      { namespace: "skill", value: null, label: "skill:" },
    ]);
    // A query that starts a namespace's name lists its members.
    expect(api.search("mo", ctx, 8).map((match) => match.value)).toEqual([
      "opus",
      "sonnet",
      "anthropic/haiku",
    ]);
    // Any other lists the members it matches, in any namespace.
    expect(api.search("so", ctx, 8)).toEqual([
      { namespace: "model", value: "sonnet", label: "Sonnet", description: "Fast" },
    ]);
    expect(api.search("rev", ctx, 8)).toEqual([
      { namespace: "skill", value: "review", label: "review" },
    ]);
    expect(api.search("mo", ctx, 2)).toHaveLength(2);
  });

  it("lists one namespace's values, prefix matches first", () => {
    const api = directives();

    expect(api.search("model:", ctx, 8).map((match) => match.value)).toEqual([
      "opus",
      "sonnet",
      "anthropic/haiku",
    ]);
    expect(api.search("model:ha", ctx, 8).map((match) => match.value)).toEqual([
      "anthropic/haiku",
    ]);
    expect(api.search("model:", ctx, 1)).toHaveLength(1);
  });

  it("names a directive only for a registered namespace's current value", () => {
    const api = directives();

    expect(api.isDirective("model:opus", ctx)).toBe(true);
    expect(api.isDirective("model:anthropic/haiku", ctx)).toBe(true);
    expect(api.isDirective("model:nope", ctx)).toBe(false);
    expect(api.isDirective("effort:high", ctx)).toBe(false);
    expect(api.isDirective("notes.md", ctx)).toBe(false);
  });

  it("takes known directives out of the text and asks for what they mean", () => {
    const api = directives();

    expect(
      api.resolve("@model:opus fix @notes.md then @skill:review it @model:sonnet", ctx),
    ).toEqual({
      text: "fix @notes.md then it",
      extras: {
        config: [{ category: "model", value: "sonnet" }],
        commands: [{ name: "review" }],
      },
    });
  });

  it("leaves tokens that name nothing as text", () => {
    const api = directives();

    expect(api.resolve("use @model:nope and a@model:opus", ctx)).toEqual({
      text: "use @model:nope and a@model:opus",
      extras: {},
    });
  });

  it("keeps the text of a prompt that was only settings, so there is something to send", () => {
    const api = directives();

    expect(api.resolve("@model:opus", ctx)).toEqual({
      text: "@model:opus",
      extras: { config: [{ category: "model", value: "opus" }] },
    });
    expect(api.resolve("@skill:review", ctx).text).toBe("");
  });

  it("hands each namespace its context, and forgets one unregistered", () => {
    const api = createDirectives();
    const candidates = vi.fn(() => [{ value: "high", label: "High" }]);
    const off = api.register({ name: "effort", candidates, resolve: () => ({}) });

    expect(api.isDirective("effort:high", ctx)).toBe(true);
    expect(candidates).toHaveBeenCalledWith(ctx);
    off();
    expect(api.isDirective("effort:high", ctx)).toBe(false);
  });
});
