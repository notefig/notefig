import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { platformAdapter } from "@/adapters";
import { FsError } from "@/adapters/platform-adapter.interface";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "../file-sync";
import { isRecentSelfWrite } from "../file-write-effects";
import { calculateContentHash } from "../hash";
import { getDocumentSync } from "../markdown-conversion";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import {
  getOrCreateEditor,
  getMarkdownEditor,
  disposeEditor,
} from "@/components/editor/editor-store";

vi.mock("@/adapters", () => ({
  platformAdapter: {
    readFiles: vi.fn(),
    writeFiles: vi.fn(),
  },
}));

const readMock = vi.mocked(platformAdapter.readFiles);
const writeMock = vi.mocked(platformAdapter.writeFiles);

beforeEach(() => {
  readMock.mockReset();
  writeMock.mockReset();
});

describe("writeWorkspaceTextFile", () => {
  it("records a self-write so the watcher echo is suppressed", async () => {
    writeMock.mockResolvedValue({ succeeded: ["/ws/a.md"], failed: [] });

    await writeWorkspaceTextFile("/ws/a.md", "hello\n");

    expect(
      isRecentSelfWrite("/ws/a.md", calculateContentHash("hello\n")),
    ).toBe(true);
  });

  it("throws FsError on adapter failure", async () => {
    writeMock.mockResolvedValue({
      succeeded: [],
      failed: [
        { path: "/ws/a.md", type: "NotFound", message: "no such file" },
      ] as never[],
    });

    await expect(
      writeWorkspaceTextFile("/ws/a.md", "hello\n"),
    ).rejects.toBeInstanceOf(FsError);
  });
});

describe("writeWorkspaceTextFile adoption (open editor)", () => {
  const path = "/ws/open.md";
  const codec = createMarkdownCodec();

  afterEach(() => {
    disposeEditor(path);
  });

  function openEditor(markdown: string) {
    return getOrCreateEditor(path, {
      type: "markdown",
      content: codec.parse(markdown),
      basePath: "/ws",
    });
  }

  function liveMarkdown(): string {
    return codec.serialize(getMarkdownEditor(path)!.getJSON());
  }

  it("pushes the written content into a live editor (disk alone is not enough)", async () => {
    writeMock.mockResolvedValue({ succeeded: [path], failed: [] });
    openEditor("# Doc\n\nOld body.\n");

    // The write is self-write-tagged, so the watcher-driven adoption path
    // never fires for it — writeWorkspaceTextFile must adopt directly.
    await writeWorkspaceTextFile(path, "# Doc\n\nNew body.\n");

    expect(liveMarkdown()).toContain("New body.");
    expect(liveMarkdown()).not.toContain("Old body.");
  });

  it("author_blob-shaped append to an open document renders in the live editor", async () => {
    writeMock.mockResolvedValue({ succeeded: [path], failed: [] });
    openEditor("# Doc\n");

    const fence = "```notefig:question\nid: q_1234\nstatus: pending\nprompt: OK?\n```\n";
    await writeWorkspaceTextFile(path, `# Doc\n\n${fence}`);

    expect(liveMarkdown()).toContain("id: q_1234");
  });

  it("history_restore-shaped full replace lands in the live editor", async () => {
    writeMock.mockResolvedValue({ succeeded: [path], failed: [] });
    openEditor("# Current\n\nEdited since checkpoint.\n");

    await writeWorkspaceTextFile(path, "# Restored\n\nCheckpoint content.\n");

    expect(liveMarkdown()).toContain("Checkpoint content.");
    expect(liveMarkdown()).not.toContain("Edited since checkpoint.");
  });

  it("skips adoption while a local edit is mid-debounce (prepareAdoption null), disk write intact", async () => {
    writeMock.mockResolvedValue({ succeeded: [path], failed: [] });
    openEditor("# Doc\n\nUser draft.\n");
    const editor = getMarkdownEditor(path)!;

    // Simulate a dirty local edit: a save held in flight keeps the sync
    // dirty/saving, so prepareAdoption resolves null and the user's edit wins.
    const sync = getDocumentSync(path);
    sync.writer = () => new Promise<void>(() => {});
    sync.pushUpdate(() => editor.getJSON());

    await writeWorkspaceTextFile(path, "# Doc\n\nAgent overwrite.\n");

    expect(writeMock).toHaveBeenCalledWith([
      { path, content: "# Doc\n\nAgent overwrite.\n" },
    ]);
    expect(liveMarkdown()).toContain("User draft.");
    expect(liveMarkdown()).not.toContain("Agent overwrite.");
  });
});

describe("readWorkspaceTextFile", () => {
  it("slices content with 1-based line/limit", async () => {
    readMock.mockResolvedValue({
      succeeded: [{ path: "/ws/a.md", content: "line1\nline2\nline3\n" }],
      failed: [],
    });

    const content = await readWorkspaceTextFile("/ws/a.md", {
      line: 2,
      limit: 1,
    });

    expect(content).toBe("line2");
  });

  it("throws FsError on adapter failure", async () => {
    readMock.mockResolvedValue({
      succeeded: [],
      failed: [
        { path: "/ws/a.md", type: "NotFound", message: "no such file" },
      ] as never[],
    });

    await expect(readWorkspaceTextFile("/ws/a.md")).rejects.toBeInstanceOf(
      FsError,
    );
  });
});
