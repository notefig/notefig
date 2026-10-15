import { describe, it, expect, vi } from "vitest";
import { fakePromptWidgetHost } from "../../testing/fake-host";
import { draftToInline } from "../composer/draft-text";
import {
  findDirective,
  hostMentionSearch,
  isDirectiveToken,
  searchDirectives,
  type DirectiveSource,
} from "../composer/mention-suggestion";

const file = { relativePath: "notes.md", title: "notes.md", path: "/ws/notes.md" };

const sources: DirectiveSource[] = [
  {
    name: "model",
    candidates: () => [
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet", description: "Fast" },
      { value: "anthropic/haiku", label: "Haiku" },
    ],
  },
  { name: "skill", candidates: () => [{ value: "review", label: "review" }] },
];

describe("searching directives", () => {
  it("lists the namespaces for a bare @, and members as soon as a query names or matches them", () => {
    expect(searchDirectives(sources, "")).toEqual([
      { namespace: "model", value: null, label: "model:" },
      { namespace: "skill", value: null, label: "skill:" },
    ]);
    // A query that starts a namespace's name lists its members.
    expect(searchDirectives(sources, "mo").map((row) => row.value)).toEqual([
      "opus",
      "sonnet",
      "anthropic/haiku",
    ]);
    // Any other lists the members it matches, in any namespace.
    expect(searchDirectives(sources, "so")).toEqual([
      { namespace: "model", value: "sonnet", label: "Sonnet", description: "Fast" },
    ]);
    expect(searchDirectives(sources, "rev")).toEqual([
      { namespace: "skill", value: "review", label: "review" },
    ]);
  });

  it("lists one namespace's members, prefix matches first", () => {
    expect(searchDirectives(sources, "model:").map((row) => row.value)).toEqual([
      "opus",
      "sonnet",
      "anthropic/haiku",
    ]);
    expect(searchDirectives(sources, "model:ha").map((row) => row.value)).toEqual([
      "anthropic/haiku",
    ]);
  });

  it("finds a directive only for a registered namespace's current value", () => {
    expect(findDirective(sources, "model:opus")?.value).toBe("opus");
    expect(findDirective(sources, "model:anthropic/haiku")?.source.name).toBe("model");
    expect(findDirective(sources, "model:nope")).toBeNull();
    expect(findDirective(sources, "effort:high")).toBeNull();
    expect(findDirective(sources, "notes.md")).toBeNull();
    // No colon is no directive, even where dropping a letter names one.
    const skills = [{ name: "skill", candidates: () => [{ value: "skills", label: "skills" }] }];
    expect(findDirective(skills, "skills")).toBeNull();
    expect(findDirective(skills, "skill:skills")?.value).toBe("skills");
  });
});

describe("the @ menu's rows", () => {
  it("lists the session's directives before files", () => {
    const directives = vi.fn(() => sources);
    const host = fakePromptWidgetHost({
      directives,
      searchWorkspaceFiles: vi.fn(() => [file]),
    });

    expect(hostMentionSearch(host, { workspacePath: "/ws", taskId: "t" })("opu")).toEqual([
      { kind: "directive", directive: { namespace: "model", value: "opus", label: "Opus" } },
      { kind: "file", file },
    ]);
    expect(directives).toHaveBeenCalledWith({ workspacePath: "/ws", taskId: "t" });
  });

  it("lists only files where a directive means nothing", () => {
    const directives = vi.fn(() => sources);
    const host = fakePromptWidgetHost({
      directives,
      searchWorkspaceFiles: vi.fn(() => [file]),
    });

    expect(
      hostMentionSearch(host, { workspacePath: "/ws", taskId: null, directives: false })(""),
    ).toEqual([{ kind: "file", file }]);
    expect(directives).not.toHaveBeenCalled();
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
