import { describe, expect, it, vi } from "vitest";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import { manifestHash, marketingDocs } from "../content-manifest";
import { ensureMarketingWorkspaceSeeded } from "../seed";

type Fs = IPlatformAdapter["fs"];

function makeFs(storedHash: string | null) {
  const writeFiles = vi.fn(
    async (files: { path: string; content: string }[]) => ({
      succeeded: files.map((file) => file.path),
      failed: [],
    }),
  );
  const readFiles = vi.fn(async (paths: string[]) =>
    storedHash === null
      ? { succeeded: [], failed: [] }
      : { succeeded: [{ path: paths[0], content: storedHash }], failed: [] },
  );
  return { fs: { readFiles, writeFiles } as unknown as Fs, writeFiles };
}

describe("ensureMarketingWorkspaceSeeded", () => {
  it("seeds every doc plus the hash file into a fresh workspace", async () => {
    const { fs, writeFiles } = makeFs(null);
    await ensureMarketingWorkspaceSeeded(fs);

    expect(writeFiles).toHaveBeenCalledTimes(2);
    const seeded = writeFiles.mock.calls[0][0];
    expect(seeded.map((file) => file.path)).toEqual(
      marketingDocs.map((doc) => doc.path),
    );
    // The hash marker is written last, so an interrupted seed re-runs.
    expect(writeFiles.mock.calls[1][0]).toEqual([
      { path: "docs/.notefig-marketing-manifest", content: manifestHash },
    ]);
  });

  it("does not touch a workspace already on the current manifest", async () => {
    const { fs, writeFiles } = makeFs(manifestHash);
    await ensureMarketingWorkspaceSeeded(fs);
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("re-seeds (overwriting edits) when the stored hash is stale", async () => {
    const { fs, writeFiles } = makeFs("0000stalehash");
    await ensureMarketingWorkspaceSeeded(fs);
    expect(writeFiles).toHaveBeenCalledTimes(2);
  });

  it("surfaces write failures instead of recording the new hash", async () => {
    const fs = {
      readFiles: async () => ({ succeeded: [], failed: [] }),
      writeFiles: async (files: { path: string }[]) => ({
        succeeded: [],
        failed: files.map((file) => ({
          path: file.path,
          type: "io_error" as const,
          message: "quota exceeded",
        })),
      }),
    } as unknown as Fs;

    await expect(ensureMarketingWorkspaceSeeded(fs)).rejects.toThrow(
      /Marketing seed failed/,
    );
  });
});
