import { describe, it, expect } from "vitest";
import { diffStats, parseDiffBlock, patchOf } from "../patch";

const PATCH = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";

describe("parseDiffBlock", () => {
  it("reads a unified diff as Pierre does, in the block's language", () => {
    const diff = parseDiffBlock("ts", `diff --git a/src/a.ts b/src/a.ts\n${PATCH}`)!;
    expect(diff).toMatchObject({ name: "src/a.ts", lang: "ts" });
    expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
    // Pierre infers one from the name for a language Shiki doesn't know.
    expect(parseDiffBlock("nope", PATCH)!.lang).toBeUndefined();
  });

  it("is null for a body with no hunks", () => {
    expect(parseDiffBlock("ts", "-const b = 2;\n+const b = 3;")).toBeNull();
    expect(parseDiffBlock("ts", "const a = 1;")).toBeNull();
  });
});

describe("patchOf", () => {
  it("is a block's body for two texts, starting where they do in the file", () => {
    const patch = patchOf("/ws/src/a.ts", "const b = 2;", "const b = 3;", 12);
    expect(patch).toBe("--- /ws/src/a.ts\n+++ /ws/src/a.ts\n@@ -12,1 +12,1 @@\n-const b = 2;\n+const b = 3;");
    expect(diffStats(parseDiffBlock(null, patch)!)).toEqual({ added: 1, removed: 1 });
  });

  it("shows a change to the file's last newline", () => {
    const patch = patchOf("/ws/a.ts", "a", "a\n");
    expect(parseDiffBlock(null, patch)).not.toBeNull();
  });

  it("writes a new file against /dev/null", () => {
    const patch = patchOf("/ws/b.ts", null, "a\nb");
    expect(patch.split("\n").slice(0, 3)).toEqual(["--- /dev/null", "+++ /ws/b.ts", "@@ -0,0 +1,2 @@"]);
    expect(parseDiffBlock(null, patch)).toMatchObject({ name: "/ws/b.ts" });
  });
});
