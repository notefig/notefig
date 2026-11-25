import { describe, expect, it, vi } from "vitest";
import { createOwnWip } from "./sync-wip";

const encode = (text: string) => new TextEncoder().encode(text);

describe("this device's work in progress", () => {
  it("parses a held file only when it, or the branch's copy, changed since the last heartbeat", async () => {
    const file = { here: "Typed.\n", branch: "Old.\n" };
    const fileUnits = vi.fn(async (markdown: string) => [{ key: markdown.trim(), content: markdown.trim() }]);
    const branchHas = vi.fn();
    const wip = createOwnWip({
      git: { isIgnored: async () => false, readFile: async () => encode(file.branch) },
      fs: { readBinaryFiles: async (paths: string[]) => ({ succeeded: paths.map((path) => ({ path, data: encode(file.here) })), failed: [] }) } as never,
      claims: { branchHas },
      head: async () => "tip",
      tree: (absolute) => absolute.slice(1),
      absolute: (path) => `/${path}`,
      flushEdits: async () => {},
      fileUnits,
    });
    const beat = async () => {
      fileUnits.mockClear();
      expect(await wip.files(["note.md"])).toEqual([{ filepath: "note.md", bytes: encode(file.here) }]);
      return fileUnits.mock.calls.map(([markdown]) => markdown);
    };

    expect(await beat()).toEqual(["Old.\n", "Typed.\n"]);
    // Nothing changed: the names stand.
    expect(await beat()).toEqual([]);
    file.here = "Typed more.\n";
    expect(await beat()).toEqual(["Typed more.\n"]);
    file.branch = "Typed.\n";
    expect(await beat()).toEqual(["Typed.\n", "Typed more.\n"]);
    expect(branchHas).toHaveBeenCalledTimes(3);
  });
});
