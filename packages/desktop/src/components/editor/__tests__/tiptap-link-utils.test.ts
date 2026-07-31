import { describe, it, expect } from "vitest";
import {
  isExternalUrl,
  resolvePath,
  buildInternalCandidates,
  normalizeLinkInput,
  relativeHrefFromDir,
} from "../tiptap-link-utils";

describe("isExternalUrl", () => {
  it("matches http, https, and mailto schemes case-insensitively", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("http://example.com")).toBe(true);
    expect(isExternalUrl("HTTP://EXAMPLE.COM")).toBe(true);
    expect(isExternalUrl("mailto:a@b.com")).toBe(true);
  });

  it("rejects workspace paths and other schemes", () => {
    expect(isExternalUrl("notes.md")).toBe(false);
    expect(isExternalUrl("./notes.md")).toBe(false);
    expect(isExternalUrl("/ws/notes.md")).toBe(false);
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalUrl("asset://localhost/x")).toBe(false);
  });
});

describe("resolvePath", () => {
  it("joins a plain filename onto the base dir", () => {
    expect(resolvePath("/ws/docs", "notes.md")).toBe("/ws/docs/notes.md");
  });

  it("resolves ./ prefix", () => {
    expect(resolvePath("/ws/docs", "./notes.md")).toBe("/ws/docs/notes.md");
  });

  it("resolves ../ into the parent directory", () => {
    expect(resolvePath("/ws/docs", "../notes.md")).toBe("/ws/notes.md");
  });

  it("resolves nested relative paths", () => {
    expect(resolvePath("/ws", "a/b.md")).toBe("/ws/a/b.md");
  });

  it("resolves mixed ./ and ../ segments", () => {
    expect(resolvePath("/ws/a/b", ".././c/./d.md")).toBe("/ws/a/c/d.md");
  });

  it("clamps .. at the root instead of escaping it", () => {
    expect(resolvePath("/ws", "../../../etc/passwd")).toBe("/etc/passwd");
    expect(resolvePath("/", "../a.md")).toBe("/a.md");
  });

  it("collapses duplicate slashes", () => {
    expect(resolvePath("/ws/", "//a.md")).toBe("/ws/a.md");
  });

  it("handles a root base dir", () => {
    expect(resolvePath("/", "a.md")).toBe("/a.md");
  });

  it("decodes percent-encoded segments (relativeHrefFromDir's output)", () => {
    expect(resolvePath("/ws/docs", "lihan%20%3C%3E%20andrew.md")).toBe(
      "/ws/docs/lihan <> andrew.md",
    );
  });

  it("tolerates a literal % that isn't a valid escape instead of throwing", () => {
    expect(resolvePath("/ws/docs", "100%.md")).toBe("/ws/docs/100%.md");
  });
});

describe("relativeHrefFromDir", () => {
  it("computes a plain sibling-file relative href", () => {
    expect(relativeHrefFromDir("/ws/docs", "/ws/docs/notes.md")).toBe(
      "notes.md",
    );
  });

  it("walks up to a shared ancestor", () => {
    expect(relativeHrefFromDir("/ws/docs/sub", "/ws/notes.md")).toBe(
      "../../notes.md",
    );
  });

  it("percent-encodes characters an unwrapped markdown link destination can't carry, and round-trips through resolvePath", () => {
    const href = relativeHrefFromDir("/ws/docs", "/ws/docs/lihan <> andrew.md");
    expect(href).toBe("lihan%20%3C%3E%20andrew.md");
    expect(href).not.toMatch(/\s/);
    expect(resolvePath("/ws/docs", href)).toBe("/ws/docs/lihan <> andrew.md");
  });
});

describe("buildInternalCandidates", () => {
  const ctx = { fileDir: "/ws/docs", basePath: "/ws" };

  it("tries file-relative before workspace-root", () => {
    expect(buildInternalCandidates("notes.md", ctx)).toEqual([
      "/ws/docs/notes.md",
      "/ws/notes.md",
    ]);
  });

  it("dedupes when the file dir is the workspace root", () => {
    expect(
      buildInternalCandidates("notes.md", { fileDir: "/ws", basePath: "/ws" }),
    ).toEqual(["/ws/notes.md"]);
  });

  it("passes an absolute in-workspace href through", () => {
    expect(buildInternalCandidates("/ws/a/b.md", ctx)).toEqual(["/ws/a/b.md"]);
  });

  it("clamps traversal outside the workspace to nothing", () => {
    expect(buildInternalCandidates("../../../etc/passwd", ctx)).toEqual([]);
    expect(buildInternalCandidates("/etc/passwd", ctx)).toEqual([]);
  });

  it("keeps every candidate inside the workspace", () => {
    for (const href of ["a.md", "../a.md", "./x/../y.md", "/ws/z.md"]) {
      for (const candidate of buildInternalCandidates(href, ctx)) {
        expect(candidate.startsWith("/ws/")).toBe(true);
      }
    }
  });

  it("resolves ../ relative to the containing file", () => {
    expect(buildInternalCandidates("../shared/a.md", ctx)).toEqual([
      "/ws/shared/a.md",
    ]);
  });
});

describe("normalizeLinkInput", () => {
  it("keeps schemes as-is", () => {
    for (const value of [
      "https://example.com",
      "http://example.com",
      "mailto:a@b.com",
      "data:image/png;base64,x",
    ]) {
      expect(normalizeLinkInput(value)).toBe(value);
    }
  });

  it("keeps path-like and anchor inputs as-is", () => {
    for (const value of [
      "/docs/readme",
      "./local.md",
      "../parent.md",
      "#anchor",
    ]) {
      expect(normalizeLinkInput(value)).toBe(value);
    }
  });

  it("keeps bare filenames the editor can open as-is (internal links)", () => {
    expect(normalizeLinkInput("notes.md")).toBe("notes.md");
    expect(normalizeLinkInput("docs/notes.md")).toBe("docs/notes.md");
  });

  it("prepends https:// to bare domains", () => {
    expect(normalizeLinkInput("google.com")).toBe("https://google.com");
    expect(normalizeLinkInput("sub.example.com/path")).toBe(
      "https://sub.example.com/path",
    );
  });
});
