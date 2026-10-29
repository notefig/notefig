import { describe, it, expect, beforeAll } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ToolCallUpdate } from "@notefig/shared/agent";
import { renderDiffToolCall } from "../transcript";
import { defineDiffBlockElement } from "../element";

function call(overrides: Partial<ToolCallUpdate>): ToolCallUpdate {
  return { toolCallId: "call_1", title: "Edit", status: "completed", ...overrides };
}

const edit = { type: "diff", path: "/ws/src/a.ts", oldText: "const b = 2;", newText: "const b = 3;" } as const;

describe("renderDiffToolCall", () => {
  beforeAll(() => defineDiffBlockElement());

  it("draws each file a call edits as its card, at the line the edit is", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const element = renderDiffToolCall(
      call({
        content: [edit, { type: "diff", path: "/ws/b.ts", oldText: null, newText: "new" }],
        locations: [{ path: "/ws/src/a.ts", line: 40 }],
      }),
    )!;
    await act(async () => createRoot(root).render(element));
    const blocks = root.querySelectorAll("notefig-diff-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].textContent).toContain("@@ -40,1 +40,1 @@");
    await expect.poll(() => root.querySelectorAll("[data-diff-card]").length).toBe(2);
    expect(root.querySelectorAll("[data-diff-card]")[1].textContent).toContain("/ws/b.ts");
    root.remove();
  });

  it("starts each card closed, making its diff only once it is opened", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    await act(async () => createRoot(root).render(renderDiffToolCall(call({ content: [edit] }))!));
    await expect.poll(() => root.querySelector("[data-diff-card]")).not.toBeNull();
    const toggle = root.querySelector<HTMLButtonElement>("[data-diff-toggle]")!;
    const diffs = () => root.querySelectorAll("diffs-container").length;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(diffs()).toBe(0);
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(diffs()).toBe(1);
    // The header opens and closes it too.
    await act(async () => root.querySelector<HTMLElement>("[data-diff-card] > div")!.click());
    expect(diffs()).toBe(0);
    root.remove();
  });

  it("leaves a call that edits nothing, or failed, to the chat's line", () => {
    expect(renderDiffToolCall(call({ content: [{ type: "content", content: { type: "text", text: "ok" } }] }))).toBeNull();
    expect(renderDiffToolCall(call({}))).toBeNull();
    expect(renderDiffToolCall(call({ status: "failed", content: [edit] }))).toBeNull();
  });
});
