/**
 * End-to-end integrity of the typing → save → collection → adoption loop.
 *
 * Every other test severs this loop (mocking writeFileContent or passing a
 * static file prop). Here the real pieces run against an in-memory platform
 * adapter with realistic async latency, wired exactly like Workspace:
 *
 *   editor updates → DocumentSync → writeFileContent → content collection
 *   mutation (async adapter write) → synced-store writes → live query
 *   (metadata ⋈ content, as in workspace.tsx) → file prop → adoption
 *   effect in useEditorFileSync → editor.setContent
 *
 * The invariant under test: however fast the user types, the editor never
 * loses or reverts content, and the file on disk converges to exactly what
 * was typed — never empty, never an earlier snapshot.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, Fragment } from "react";
import { Editor } from "@tiptap/core";
import { useLiveQuery, eq, inArray } from "@tanstack/react-db";

// In-memory platform adapter with async latency (hoisted for vi.mock)
vi.mock("@/adapters", async () => {
  const { fake } = await import("@/testing/fake-fs-adapter");
  return {
    platformAdapter: {
      fs: fake.adapter,
      ui: fake.adapter,
      db: (await import("@/testing/node-db")).createNodeTestDb(),
    },
  };
});

import { fake, installWatcherSim } from "@/testing/fake-fs-adapter";

// Real modules — imported after the adapter mock so they bind to the fake fs.
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { useEditorFileSync } from "../use-editor-file-sync";
import {
  getOrCreateWorkspaceCollections,
  writeFileContent,
  type FileMetadata,
} from "@/entities/files";
import {
  closeDocumentSync,
  resetConverterForTests,
} from "@/utils/markdown-conversion";
import { handleContentFileSystemChange } from "@/utils/file-sync";
import { calculateContentHash } from "@/utils/hash";
import type { ContentChangeEvent } from "@/adapters/platform-adapter.interface";
import type { FileEntry } from "@/utils/fs";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // happy-dom has no module workers: force the deterministic inline codec.
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("Workers unavailable in this environment");
      }
    },
  );
  resetConverterForTests();
});

// Harness: the workspace.tsx data path, minus the chrome
let workspaceCounter = 0;
let WS: string;
let FILE: string;

let editor: Editor;
let root: Root;
let container: HTMLElement;
let pendingEvents: Promise<void>[] = [];

interface JoinedEntry extends FileMetadata {
  content: string;
  contentHash: string;
  isContentLoaded: boolean;
  contentError?: string;
}

function EditorSync({ entry }: { entry: JoinedEntry }) {
  useEditorFileSync(
    editor,
    entry as FileEntry,
    WS,
    entry.isContentLoaded,
    entry.contentError,
  );
  return null;
}

/** Replicates the workspace.tsx live query joining metadata and content. */
function Harness() {
  const { metadata, content } = getOrCreateWorkspaceCollections(WS);
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ file: metadata })
        .where(({ file }) => inArray(file.path, [FILE]))
        .leftJoin({ content }, ({ file, content }) =>
          eq(file.path, content.path),
        )
        .select(({ file, content }) => ({
          ...file,
          content: content?.content ?? "",
          contentHash: content?.contentHash ?? "",
          isContentLoaded: content !== undefined,
          contentError: content?.error,
        })),
    [WS],
  );

  const entry = data[0] as JoinedEntry | undefined;
  // Gate on contentHash: the join can emit isContentLoaded=true with empty
  // content before the on-demand row has real data; mounting then would
  // poison the DocumentSync baseline with "".
  if (!entry || !entry.isContentLoaded || !entry.contentHash) {
    return createElement(Fragment);
  }
  return createElement(EditorSync, { entry });
}

const INITIAL = "start";

async function tick(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * Wait until the fake fs content stops changing (save pipeline drained).
 * The stability window must exceed the content-write debounce, or a lull
 * between two debounced flushes would be mistaken for quiescence.
 */
async function settle() {
  let last = "";
  let stableTicks = 0;
  for (let i = 0; i < 400 && stableTicks < 70; i++) {
    await tick(10);
    const current = fake.store.get(FILE)?.content ?? "";
    if (current === last) {
      stableTicks++;
    } else {
      stableTicks = 0;
      last = current;
    }
  }
}

beforeEach(async () => {
  workspaceCounter++;
  WS = `/ws-typing-${workspaceCounter}`;
  FILE = `${WS}/note.md`;

  fake.store.clear();
  fake.store.set(FILE, {
    content: INITIAL,
    modifiedAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 60_000),
  });

  // Desktop (Tauri) watcher semantics (see @/testing/fake-fs-adapter for
  // the src-tauri mapping). The xor cancels the sim's internal mixing so
  // the historical event-delay sequence (eventSeed = 7) is preserved.
  installWatcherSim({
    fakeFs: fake,
    seed: 7 ^ 0x5bd1e995,
    pendingEvents,
    onExternalChange: (event) => handleContentFileSystemChange(event, WS),
  });

  editor = new Editor({
    extensions: editorExtensions,
    content: INITIAL,
    editable: true,
    autofocus: false,
  });

  container = document.createElement("div");
  root = createRoot(container);

  await act(async () => {
    root.render(createElement(Harness));
  });
  // Let the metadata collection load and the content row arrive on demand
  // (EditorSync mounts once the joined entry has real content).
  const { content } = getOrCreateWorkspaceCollections(WS);
  for (let i = 0; i < 100; i++) {
    await tick(10);
    if (content.get(FILE)?.contentHash) break;
  }
});

afterEach(async () => {
  fake.hooks.beforeWrite = undefined;
  fake.hooks.afterWrite = undefined;
  await Promise.all(pendingEvents);
  pendingEvents = [];
  await act(async () => {
    root.unmount();
  });
  editor.destroy();
  closeDocumentSync(FILE);
});

describe("typing → save → adoption loop integrity", () => {
  it("fast typing with pauses converges: editor and disk hold exactly what was typed", async () => {
    // In this test there are NO external writers: every fs change is the
    // app's own save. Any adoption therefore means an internal write was
    // categorized as external — the editor got replaced under the user.
    let adoptionCount = 0;
    const origLog = console.log;
    vi.spyOn(console, "log").mockImplementation((...args) => {
      if (String(args[0]).includes("External change detected")) {
        adoptionCount++;
      }
      origLog(...args);
    });

    // Give the editor↔collection loop a moment to reach steady state.
    await tick(50);

    // Type 60 characters in bursts, pausing between bursts. Pauses matter:
    // they are the idle windows where a stale collection emission can win
    // the adoption race (during a burst, in-flight saves suppress adoption).
    //
    // Characters are inserted at the caret (insertContent), exactly like
    // keyboard input — so a document replacement that moves the caret or
    // reverts content corrupts the result, as it does for a real user.
    editor.commands.focus("end");
    let typed = "";
    for (let burst = 0; burst < 8; burst++) {
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          const char = String.fromCharCode(97 + ((burst * 10 + i) % 26));
          typed += char;
          editor.commands.insertContent(char);
          // A fast typist: ~3ms between keystrokes.
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
      });
      // Pause between bursts — longer than the save debounce, so every
      // burst flushes a write and its watcher events land while the editor
      // is idle. These idle windows are where a stale echo wins the
      // adoption race.
      await tick(700);

      // Mid-session remount, as a tab switch or dockable layout change
      // does. Editors survive in the editor-store; the live query
      // resubscribes.
      if (burst === 2 || burst === 5) {
        await act(async () => {
          root.unmount();
        });
        root = createRoot(container);
        await act(async () => {
          root.render(createElement(Harness));
        });
        await tick(30);
      }
    }

    const expected = INITIAL + typed;

    await settle();

    // No external writer exists in this test, so the app's own saves must
    // never come back as adopted "external" changes.
    expect(
      adoptionCount,
      "internal writes were categorized as external and adopted",
    ).toBe(0);

    // The editor must still hold everything that was typed (no reverts).
    expect(editor.state.doc.textContent).toBe(expected);

    // The file on disk must be the final document — not empty, not an
    // earlier snapshot.
    expect(fake.store.get(FILE)?.content).toBe(expected);

    // And the content collection (what any other view would render) must
    // agree with the disk.
    const { content } = getOrCreateWorkspaceCollections(WS);
    expect(content.get(FILE)?.content).toBe(expected);
  }, 30_000);

  it("a delayed echo of an earlier self-write never regresses the content row", async () => {
    // Model the residual echo window directly: the watcher read an older
    // flush of this app's own save, and IPC delivered it only after a
    // newer flush had already landed. The handler must not trust that
    // stale payload — it re-reads the file at handling time, so the row
    // stays on the newer content (and the adoption path never fires).
    const older = "start plus older flush";
    const newer = "start plus older flush plus newer flush";

    await writeFileContent(WS, FILE, older);
    await writeFileContent(WS, FILE, newer);

    await handleContentFileSystemChange(
      {
        changes: [
          {
            path: FILE,
            content: older,
            contentHash: calculateContentHash(older),
          },
        ],
      },
      WS,
    );
    await tick(20);

    const { content } = getOrCreateWorkspaceCollections(WS);
    expect(content.get(FILE)?.content).toBe(newer);

    // A genuinely external change must still come through — suppression
    // must not eat real edits. An external edit is on disk by definition
    // (the handler re-reads at handling time rather than trusting the
    // event payload), so put it there like a real external writer would.
    const external = "external edit from another program";
    fake.store.set(FILE, {
      content: external,
      modifiedAt: new Date(),
      createdAt: fake.store.get(FILE)?.createdAt ?? new Date(),
    });
    await handleContentFileSystemChange(
      {
        changes: [
          {
            path: FILE,
            content: external,
            contentHash: calculateContentHash(external),
          },
        ],
      },
      WS,
    );
    await tick(20);
    expect(content.get(FILE)?.content).toBe(external);
  });

  it("a delayed echo from far in the past still must not regress the row", async () => {
    // Historic root cause of the *intermittent* "older overwrites newer":
    // suppression once keyed on a capped ledger of recently-written hashes,
    // and a late echo whose hash had aged out of it (batched fs events, a
    // slow read, IPC backlog, a long save burst) wrote its stale payload
    // over the newer row. The handler now ignores event payloads entirely
    // and re-reads the file, so no amount of intervening saves can make a
    // stale echo win — a short burst is as conclusive as the 110-write
    // flood that once overflowed the ledger cap.
    const { content } = getOrCreateWorkspaceCollections(WS);

    const stale = "content from an early save";
    await writeFileContent(WS, FILE, stale);

    let newest = "";
    for (let i = 0; i < 3; i++) {
      newest = `newer save number ${i}`;
      await writeFileContent(WS, FILE, newest);
    }
    expect(content.get(FILE)?.content).toBe(newest);

    // The late watcher echo of the early write arrives now.
    await handleContentFileSystemChange(
      {
        changes: [
          {
            path: FILE,
            content: stale,
            contentHash: calculateContentHash(stale),
          },
        ],
      },
      WS,
    );
    await tick(20);

    // The row must still hold the newest content — the stale echo is this
    // app's own write and must never win, ledger capacity notwithstanding.
    expect(content.get(FILE)?.content).toBe(newest);
  });
});
