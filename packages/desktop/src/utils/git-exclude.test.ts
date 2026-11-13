import { describe, expect, it } from "vitest";
import { setExcludeBlock, type ExcludeFs } from "./git-exclude";

function memory(initial = ""): ExcludeFs & { text(): string } {
  let content: string | null = initial || null;
  return {
    readFiles: async (paths: string[]) =>
      content === null
        ? { succeeded: [], failed: [{ path: paths[0]!, type: "not_found", message: "" }] }
        : { succeeded: [{ path: paths[0]!, content }], failed: [] },
    writeFiles: async (entries: { path: string; content: string }[]) => {
      content = entries[0]!.content;
      return { succeeded: [entries[0]!.path], failed: [] };
    },
    text: () => content ?? "",
  } as unknown as ExcludeFs & { text(): string };
}

describe("managed exclude blocks", () => {
  it("keeps a block whose name starts another's apart from it", async () => {
    const fs = memory();
    await setExcludeBlock(fs, "/r/.git", "notefig sync", ["a/"]);
    await setExcludeBlock(fs, "/r/.git", "notefig", ["b/"]);
    await setExcludeBlock(fs, "/r/.git", "notefig", ["c/"]);
    expect(fs.text()).toBe("# >>> notefig sync\na/\n# <<< notefig sync\n# >>> notefig\nc/\n# <<< notefig\n");
  });

  it("replaces its own block in place, and drops retired lines elsewhere", async () => {
    const fs = memory("# mine\n.notefig/\n# >>> notefig\nold/\n# <<< notefig\n*.log\n");
    await setExcludeBlock(fs, "/r/.git", "notefig", ["new/"], [".notefig/"]);
    expect(fs.text()).toBe("# mine\n# >>> notefig\nnew/\n# <<< notefig\n*.log\n");
  });
});
