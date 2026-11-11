import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@notefig/agent";
import { SessionRenameInputSchema, sessionRename } from "../session-rename";

describe("session_rename input schema", () => {
  it("trims, and holds the title to 2–60 characters", () => {
    expect(SessionRenameInputSchema.parse({ title: "  Investor intro  " })).toEqual({
      title: "Investor intro",
    });
    expect(SessionRenameInputSchema.safeParse({ title: " a " }).success).toBe(false);
    expect(SessionRenameInputSchema.safeParse({ title: "x".repeat(60) }).success).toBe(true);
    expect(SessionRenameInputSchema.safeParse({ title: "x".repeat(61) }).success).toBe(false);
  });
});

describe("session_rename", () => {
  const ctxWith = (rename: (title: string) => unknown) =>
    ({
      workspacePath: "/ws",
      taskId: "task_1",
      agents: { task: (taskId: string) => ({ taskId, rename }) },
      services: {},
    }) as unknown as ToolContext;

  it("renames its own task through the facade", async () => {
    const rename = vi.fn(() => ({ ok: true }));
    const result = await sessionRename.execute(ctxWith(rename), { title: "Investor intro" });
    expect(rename).toHaveBeenCalledWith("Investor intro");
    expect(result).toEqual({ ok: true, value: { renamed: true, title: "Investor intro" } });
  });

  it("passes a refusal back to the agent as the tool's error", async () => {
    const refusal = { ok: false, error: 'This session is already named "A"; keep it.' };
    const result = await sessionRename.execute(ctxWith(() => refusal), { title: "B" });
    expect(result).toEqual(refusal);
  });
});
