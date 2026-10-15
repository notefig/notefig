import { describe, it, expect, vi } from "vitest";
import { fakePromptWidgetHost } from "../../testing/fake-host";
import { draftToInline } from "../composer/draft-text";
import { isDirectiveToken, searchMentionRows } from "../composer/mention-rows";

const file = { relativePath: "notes.md", title: "notes.md", path: "/ws/notes.md" };
const model = { namespace: "model", value: "opus", label: "Opus" };

describe("the @ menu's rows", () => {
  it("lists directives before files, a few unless the query names a namespace", () => {
    const searchDirectives = vi.fn(() => [model]);
    const host = fakePromptWidgetHost({
      searchDirectives,
      searchWorkspaceFiles: vi.fn(() => [file]),
    });

    expect(searchMentionRows(host, { workspacePath: "/ws", taskId: "t", query: "op" })).toEqual([
      { kind: "directive", directive: model },
      { kind: "file", file },
    ]);
    expect(searchDirectives).toHaveBeenLastCalledWith({
      workspacePath: "/ws",
      taskId: "t",
      query: "op",
      limit: 3,
    });
    searchMentionRows(host, { workspacePath: "/ws", taskId: null, query: "model:" });
    expect(searchDirectives).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 8 }));
  });

  it("lists only files where a directive means nothing", () => {
    const searchDirectives = vi.fn(() => [model]);
    const host = fakePromptWidgetHost({
      searchDirectives,
      searchWorkspaceFiles: vi.fn(() => [file]),
    });

    expect(
      searchMentionRows(host, { workspacePath: "/ws", taskId: null, query: "", directives: false }),
    ).toEqual([{ kind: "file", file }]);
    expect(searchDirectives).not.toHaveBeenCalled();
  });

  it("tells a directive's token from a path", () => {
    expect(isDirectiveToken("model:opus")).toBe(true);
    expect(isDirectiveToken("model:anthropic/claude")).toBe(true);
    expect(isDirectiveToken("docs/notes.md")).toBe(false);
    expect(isDirectiveToken("model:")).toBe(false);
    expect(isDirectiveToken("C:/notes.md")).toBe(false);
  });

  it("revives a directive as a chip labelled with its whole token", () => {
    const isMention = (token: string) =>
      token === "docs/notes.md" || token === "model:anthropic/claude";

    expect(draftToInline(isMention, "@model:anthropic/claude read @docs/notes.md")).toEqual([
      { type: "mention", attrs: { id: "model:anthropic/claude", label: "model:anthropic/claude" } },
      { type: "text", text: " read " },
      { type: "mention", attrs: { id: "docs/notes.md", label: "notes.md" } },
    ]);
  });
});
