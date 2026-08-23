import { posix, win32 } from "./pathutil";

// The posix flavor's identity with pre-migration behavior is additionally
// pinned by the desktop characterization suite
// (packages/desktop/src/utils/__tests__/path-characterization.test.ts).

describe("posix flavor", () => {
  it("isAbsolute is the leading-slash test", () => {
    expect(posix.isAbsolute("/Users/parsa")).toBe(true);
    expect(posix.isAbsolute("notes/a.md")).toBe(false);
    expect(posix.isAbsolute("C:/Users")).toBe(false);
  });

  it("normalize collapses separators and strips trailing, keeping root", () => {
    expect(posix.normalize("/a//b///c/")).toBe("/a/b/c");
    expect(posix.normalize("/")).toBe("/");
    expect(posix.normalize("a/b/")).toBe("a/b");
    expect(posix.normalize("a\\b")).toBe("a/b");
  });

  it("join joins with single slashes, preserving absoluteness", () => {
    expect(posix.join("/ws", "sub", "a.md")).toBe("/ws/sub/a.md");
    expect(posix.join("/ws/", "/sub/")).toBe("/ws/sub");
    expect(posix.join("", "a", "b")).toBe("a/b");
  });

  it("dirname / basename", () => {
    expect(posix.dirname("/ws/sub/a.md")).toBe("/ws/sub");
    expect(posix.dirname("/a.md")).toBe("/");
    expect(posix.dirname("a.md")).toBe(".");
    expect(posix.basename("/ws/sub/a.md")).toBe("a.md");
    expect(posix.basename("/ws/sub/")).toBe("sub");
  });

  it("relative and contains", () => {
    expect(posix.relative("/ws", "/ws/sub/a.md")).toBe("sub/a.md");
    expect(posix.relative("/ws", "/ws")).toBe("");
    expect(posix.relative("/ws", "/ws-backup/a.md")).toBeUndefined();
    expect(posix.relative("/", "/a.md")).toBe("a.md");
    expect(posix.contains("/ws", "/ws/a.md")).toBe(true);
    expect(posix.contains("/ws", "/elsewhere")).toBe(false);
  });

  it("toKey, tree paths, and toPosixAbsolute are identities", () => {
    expect(posix.toKey("/Ws/A.md")).toBe("/Ws/A.md");
    expect(posix.toTreePath("sub/a.md")).toBe("sub/a.md");
    expect(posix.fromTreePath("sub/a.md")).toBe("sub/a.md");
    expect(posix.toPosixAbsolute("/ws/a.md")).toBe("/ws/a.md");
  });

  it("toFileUri percent-encodes per segment", () => {
    expect(posix.toFileUri("/ws/a b.md")).toBe("file:///ws/a%20b.md");
  });
});

describe("win32 flavor", () => {
  it("isAbsolute: drive-letter and UNC forms, both separators", () => {
    expect(win32.isAbsolute("C:\\Users\\p")).toBe(true);
    expect(win32.isAbsolute("C:/Users/p")).toBe(true);
    expect(win32.isAbsolute("c:\\")).toBe(true);
    expect(win32.isAbsolute("\\\\server\\share")).toBe(true);
    expect(win32.isAbsolute("//server/share")).toBe(true);
    // Drive-relative and plain relative are not absolute.
    expect(win32.isAbsolute("C:notes")).toBe(false);
    expect(win32.isAbsolute("notes\\a.md")).toBe(false);
    expect(win32.isAbsolute("/unix/style")).toBe(false);
  });

  it("normalize yields backslash spelling, collapsed, trailing stripped", () => {
    expect(win32.normalize("C:/Users//p/notes/")).toBe("C:\\Users\\p\\notes");
    expect(win32.normalize("C:\\Users\\p\\")).toBe("C:\\Users\\p");
    expect(win32.normalize("C:\\")).toBe("C:\\");
    expect(win32.normalize("C:/")).toBe("C:\\");
    // Mixed separators (the isomorphic-git `dir + "/" + filepath` shape).
    expect(win32.normalize("C:\\ws/notes.md")).toBe("C:\\ws\\notes.md");
  });

  it("normalize preserves the UNC prefix while collapsing the body", () => {
    expect(win32.normalize("\\\\server\\share\\a\\\\b\\")).toBe(
      "\\\\server\\share\\a\\b",
    );
    expect(win32.normalize("//server/share/a")).toBe("\\\\server\\share\\a");
  });

  it("normalize never changes character case", () => {
    expect(win32.normalize("c:\\Users\\P")).toBe("c:\\Users\\P");
  });

  it("join accepts either separator and yields native", () => {
    expect(win32.join("C:\\ws", "sub/a.md")).toBe("C:\\ws\\sub\\a.md");
    expect(win32.join("C:/ws/", "\\sub\\")).toBe("C:\\ws\\sub");
  });

  it("dirname respects drive and UNC roots", () => {
    expect(win32.dirname("C:\\ws\\a.md")).toBe("C:\\ws");
    expect(win32.dirname("C:\\a.md")).toBe("C:\\");
    expect(win32.dirname("C:\\")).toBe("C:\\");
    expect(win32.dirname("a.md")).toBe(".");
    expect(win32.dirname("\\\\srv\\share")).toBe("\\\\srv");
  });

  it("basename splits on either separator", () => {
    expect(win32.basename("C:\\ws\\a.md")).toBe("a.md");
    expect(win32.basename("C:/ws/a.md")).toBe("a.md");
    expect(win32.basename("C:\\ws\\")).toBe("ws");
  });

  it("relative is case- and separator-insensitive, returns native seps", () => {
    expect(win32.relative("C:\\ws", "C:\\ws\\sub\\a.md")).toBe("sub\\a.md");
    expect(win32.relative("c:/WS", "C:\\ws\\a.md")).toBe("a.md");
    expect(win32.relative("C:\\ws", "C:\\ws")).toBe("");
    expect(win32.relative("C:\\ws", "C:\\ws-backup\\a.md")).toBeUndefined();
    expect(win32.relative("C:\\ws", "D:\\ws\\a.md")).toBeUndefined();
    // The slice returns the ORIGINAL casing of the path, not the lowered key.
    expect(win32.relative("C:\\ws", "C:\\ws\\Sub\\A.md")).toBe("Sub\\A.md");
  });

  it("toKey lowercases the normalized spelling", () => {
    expect(win32.toKey("C:/Users/P/Notes/")).toBe("c:\\users\\p\\notes");
    expect(win32.toKey("c:\\foo")).toBe(win32.toKey("C:\\FOO"));
  });

  it("tree-path conversion round-trips", () => {
    expect(win32.toTreePath("sub\\deep\\a.md")).toBe("sub/deep/a.md");
    expect(win32.fromTreePath("sub/deep/a.md")).toBe("sub\\deep\\a.md");
    const native = "sub\\deep\\a.md";
    expect(win32.fromTreePath(win32.toTreePath(native))).toBe(native);
  });

  it("toPosixAbsolute yields the forward-slash drive form", () => {
    expect(win32.toPosixAbsolute("C:\\Users\\p\\a.md")).toBe("C:/Users/p/a.md");
    expect(win32.toPosixAbsolute("\\\\srv\\share\\a")).toBe("//srv/share/a");
  });

  it("toFileUri: three slashes for drive paths, host form for UNC, colon raw", () => {
    expect(win32.toFileUri("C:\\Users\\p\\a b.md")).toBe(
      "file:///C:/Users/p/a%20b.md",
    );
    expect(win32.toFileUri("\\\\srv\\share\\a b.md")).toBe(
      "file://srv/share/a%20b.md",
    );
  });
});
