import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  FsError,
  type FileSystemSurface,
} from "@/adapters/platform-adapter.interface";
import { calculateContentHash } from "@/utils/hash";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import {
  getOrCreateEditor,
  disposeEditor,
} from "@/components/editor/editor-store";
import { getMarkdownEditor } from "@/entities/editors";
import { createWorkspaceFiles, type WorkspaceFiles } from "./files";
import { createDocuments, type DocumentsApi } from "./documents";

const readMock = vi.fn();
const writeMock = vi.fn();
const fs = {
  readFiles: readMock,
  writeFiles: writeMock,
} as unknown as Pick<FileSystemSurface, "readFiles" | "writeFiles">;

/** The open workspaces' files the documents bring forward. */
let open: WorkspaceFiles[] = [];
let documents: DocumentsApi;

beforeEach(() => {
  readMock.mockReset();
  writeMock.mockReset();
  open = [];
  documents = createDocuments({ fs, openFiles: () => open });
});

describe("documents.write", () => {
  it("brings the loaded content row forward (rows lead disk for app writes)", async () => {
    // The write's watcher echo is consumed natively, so this row update is
    // the ONLY thing carrying the new content into the collection — a
    // stale row would later be adopted over the write.
    readMock.mockResolvedValue({ succeeded: [], failed: [] });
    const files = createWorkspaceFiles({
      workspacePath: "/ws-row",
      fs: {
        ...fs,
        readDirectory: async () => ({ ok: true, value: [] }),
        onFsEvent: () => () => {},
        startWatchingMetadata: async () => {},
        stopWatching: async () => {},
      } as unknown as FileSystemSurface,
      queryClient: new QueryClient(),
    });
    open = [files];
    const { content } = files.collections;
    await content.preload();
    content.utils.writeUpsert({
      path: "/ws-row/a.md",
      content: "old",
      contentHash: calculateContentHash("old"),
    });
    writeMock.mockResolvedValue({ succeeded: ["/ws-row/a.md"], failed: [] });

    await documents.write("/ws-row/a.md", "hello\n");

    expect(content.get("/ws-row/a.md")?.content).toBe("hello\n");
  });

  it("throws FsError on adapter failure", async () => {
    writeMock.mockResolvedValue({
      succeeded: [],
      failed: [
        { path: "/ws/a.md", type: "NotFound", message: "no such file" },
      ] as never[],
    });

    await expect(documents.write("/ws/a.md", "hello\n")).rejects.toBeInstanceOf(
      FsError,
    );
  });
});

describe("documents.write adoption (open editor)", () => {
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
    // never fires for it — the write must adopt directly.
    await documents.write(path, "# Doc\n\nNew body.\n");

    expect(liveMarkdown()).toContain("New body.");
    expect(liveMarkdown()).not.toContain("Old body.");
  });

  it("author_blob-shaped append to an open document renders in the live editor", async () => {
    writeMock.mockResolvedValue({ succeeded: [path], failed: [] });
    openEditor("# Doc\n");

    const fence =
      "```notefig:question\nid: q_1234\nstatus: pending\nprompt: OK?\n```\n";
    await documents.write(path, `# Doc\n\n${fence}`);

    expect(liveMarkdown()).toContain("id: q_1234");
  });

  it("history_restore-shaped full replace lands in the live editor", async () => {
    writeMock.mockResolvedValue({ succeeded: [path], failed: [] });
    openEditor("# Current\n\nEdited since checkpoint.\n");

    await documents.write(path, "# Restored\n\nCheckpoint content.\n");

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

    await documents.write(path, "# Doc\n\nAgent overwrite.\n");

    expect(writeMock).toHaveBeenCalledWith([
      { path, content: "# Doc\n\nAgent overwrite.\n" },
    ]);
    expect(liveMarkdown()).toContain("User draft.");
    expect(liveMarkdown()).not.toContain("Agent overwrite.");
  });
});

describe("documents.read", () => {
  it("slices content with 1-based line/limit", async () => {
    readMock.mockResolvedValue({
      succeeded: [{ path: "/ws/a.md", content: "line1\nline2\nline3\n" }],
      failed: [],
    });

    const content = await documents.read("/ws/a.md", {
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

    await expect(documents.read("/ws/a.md")).rejects.toBeInstanceOf(FsError);
  });
});

describe("in-flight write tracking", () => {
  it("serializes same-path writes and settles whenWorkspaceWritesSettled after them", async () => {
    const { whenWorkspaceWritesSettled } =
      await import("@/utils/workspace-write-tracker");
    const order: string[] = [];
    let releaseFirst!: () => void;
    writeMock
      .mockImplementationOnce(async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first-done");
        return { succeeded: ["/ws/a.md"], failed: [] };
      })
      .mockImplementationOnce(async () => {
        order.push("second");
        return { succeeded: ["/ws/a.md"], failed: [] };
      });

    const first = documents.write("/ws/a.md", "one");
    const second = documents.write("/ws/a.md", "two");
    const settled = whenWorkspaceWritesSettled("/ws/a.md").then(() =>
      order.push("settled"),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await Promise.all([first, second, settled]);

    expect(order).toEqual(["first-start", "first-done", "second", "settled"]);
  });
});
