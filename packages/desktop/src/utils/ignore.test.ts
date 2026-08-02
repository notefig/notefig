import { describe, it, expect } from "vitest";
import {
  isIgnoredDirectory,
  isIgnoredFile,
  isIgnoredPath,
  IGNORE_RULES,
  IGNORED_DIRECTORIES,
  IGNORED_EXTENSIONS,
} from "./ignore";

describe("isIgnoredDirectory", () => {
  it("matches known dependency directories", () => {
    expect(isIgnoredDirectory("node_modules")).toBe(true);
    expect(isIgnoredDirectory("dist")).toBe(true);
    expect(isIgnoredDirectory("__pycache__")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isIgnoredDirectory("Node_Modules")).toBe(true);
    expect(isIgnoredDirectory("PODS")).toBe(true);
  });

  it("does not match regular directories", () => {
    expect(isIgnoredDirectory("chapters")).toBe(false);
    expect(isIgnoredDirectory("my-dist")).toBe(false);
  });
});

describe("isIgnoredFile", () => {
  it("matches denylisted extensions", () => {
    expect(isIgnoredFile("movie.mp4")).toBe(true);
    expect(isIgnoredFile("archive.zip")).toBe(true);
    expect(isIgnoredFile("doc.pdf")).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(isIgnoredFile("MOVIE.MP4")).toBe(true);
  });

  it("keeps markdown, text, and images", () => {
    expect(isIgnoredFile("chapter.md")).toBe(false);
    expect(isIgnoredFile("notes.txt")).toBe(false);
    expect(isIgnoredFile("cover.png")).toBe(false);
  });

  it("keeps extensionless files", () => {
    expect(isIgnoredFile("LICENSE")).toBe(false);
    expect(isIgnoredFile("Makefile")).toBe(false);
  });
});

describe("isIgnoredPath", () => {
  it("ignores anything under an ignored directory", () => {
    expect(isIgnoredPath("/ws/node_modules/lib/index.js")).toBe(true);
    expect(isIgnoredPath("/ws/docs/dist/page.md")).toBe(true);
  });

  it("ignores files by extension anywhere", () => {
    expect(isIgnoredPath("/ws/media/clip.mp4")).toBe(true);
  });

  it("keeps tracked paths", () => {
    expect(isIgnoredPath("/ws/chapters/one.md")).toBe(false);
    expect(isIgnoredPath("/ws/LICENSE")).toBe(false);
  });

  it("only evaluates components inside the workspace when base is given", () => {
    // Workspace itself lives under a directory named like an ignored one.
    expect(isIgnoredPath("/home/u/build/my-book/chapter.md", "/home/u/build/my-book")).toBe(
      false,
    );
    expect(
      isIgnoredPath("/home/u/build/my-book/node_modules/x.js", "/home/u/build/my-book"),
    ).toBe(true);
    // The workspace root itself is never ignored.
    expect(isIgnoredPath("/home/u/build/my-book", "/home/u/build/my-book")).toBe(false);
  });

  it("without base, prefix components do count (raw form)", () => {
    expect(isIgnoredPath("/home/u/build/my-book/chapter.md")).toBe(true);
  });
});

describe("IGNORE_RULES", () => {
  it("mirrors the exported lists", () => {
    expect(IGNORE_RULES.directories).toBe(IGNORED_DIRECTORIES);
    expect(IGNORE_RULES.extensions).toBe(IGNORED_EXTENSIONS);
  });
});
