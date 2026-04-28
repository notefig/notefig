import { describe, expect, it } from "vitest";
import { ensureNewFileNameHasDefaultMarkdownExtension } from "../fs";

describe("ensureNewFileNameHasDefaultMarkdownExtension", () => {
  it("adds .md when no extension is present", () => {
    expect(ensureNewFileNameHasDefaultMarkdownExtension("notes")).toBe(
      "notes.md",
    );
  });

  it("keeps names that already have an extension", () => {
    expect(ensureNewFileNameHasDefaultMarkdownExtension("notes.txt")).toBe(
      "notes.txt",
    );
  });

  it("keeps dotfiles unchanged", () => {
    expect(ensureNewFileNameHasDefaultMarkdownExtension(".env")).toBe(".env");
  });

  it("converts trailing-dot names to .md", () => {
    expect(ensureNewFileNameHasDefaultMarkdownExtension("todo.")).toBe(
      "todo.md",
    );
  });
});
