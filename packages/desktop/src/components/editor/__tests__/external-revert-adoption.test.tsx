/**
 * External writes that RESTORE previously-app-written content must be
 * adopted — the git-revert scenario.
 *
 * The sibling pacing sweep proves app-internal echoes are never adopted.
 * This suite proves the converse duty: when an EXTERNAL writer (the user's
 * own `git checkout --`/`git revert`, a backup tool, `cp old.bak note.md`)
 * puts bytes on disk, the editor must adopt them — even when those bytes
 * are byte-identical to something this app itself wrote moments ago.
 * Suppressing them leaves the editor stale, and its next autosave silently
 * overwrites the user's revert ("my reverted changes keep coming back").
 *
 * Same harness as typing-pacing-scenarios (@/testing/fake-fs-adapter): a
 * real editor + collections + DocumentSync loop over a jittered in-memory
 * fs with desktop watcher semantics. External writes do NOT register in the
 * watcher sim — exactly like a write from outside the app process.
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
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { useEditorFileSync } from "../use-editor-file-sync";
import {
  getOrCreateWorkspaceCollections,
  type FileMetadata,
} from "@/entities/files";
import {
  closeDocumentSync,
  resetConverterForTests,
} from "@/utils/markdown-conversion";
import {
  handleContentFileSystemChange,
  writeWorkspaceTextFile,
} from "@/utils/file-sync";
import { calculateContentHash } from "@/utils/hash";
import type { FileEntry } from "@/utils/fs";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
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

let workspaceCounter = 0;
let WS: string;
let FILE: string;

let editor: Editor;
let root: Root;
let container: HTMLElement;
let pendingEvents: Promise<void>[] = [];
let adoptionCount = 0;
let watcherSim: ReturnType<typeof installWatcherSim>;

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

async function settle() {
  let last = "";
  let stableTicks = 0;
  for (let i = 0; i < 500 && stableTicks < 70; i++) {
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

async function typeChars(text: string, delayMs: number) {
  await act(async () => {
    for (const char of text) {
      editor.commands.insertContent(char);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  });
}

/** A write from OUTSIDE the app process (git checkout/revert, cp, backup
 * restore): mutates disk and fires watcher events, but never registers in
 * APP_WRITES — the consume-one check finds nothing and emits external. */
async function externalWrite(content: string) {
  fake.store.set(FILE, {
    content,
    modifiedAt: new Date(),
    createdAt: fake.store.get(FILE)?.createdAt ?? new Date(),
  });
  watcherSim.scheduleFsEvent(FILE);
  watcherSim.scheduleFsEvent(FILE);
}

async function setupWorkspace(seed: number) {
  workspaceCounter++;
  WS = `/ws-revert-${workspaceCounter}`;
  FILE = `${WS}/note.md`;
  fake.reseed(seed);

  fake.store.clear();
  fake.store.set(FILE, {
    content: INITIAL,
    modifiedAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 60_000),
  });

  watcherSim = installWatcherSim({
    fakeFs: fake,
    seed,
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

  adoptionCount = 0;
  const origLog = console.log;
  vi.spyOn(console, "log").mockImplementation((...args) => {
    if (String(args[0]).includes("External change detected")) {
      adoptionCount++;
    }
    origLog(...args);
  });

  await act(async () => {
    root.render(createElement(Harness));
  });
  const { content } = getOrCreateWorkspaceCollections(WS);
  for (let i = 0; i < 100; i++) {
    await tick(10);
    if (content.get(FILE)?.contentHash) break;
  }
  editor.commands.focus("end");
}

async function teardownWorkspace() {
  fake.hooks.beforeWrite = undefined;
  fake.hooks.afterWrite = undefined;
  await Promise.all(pendingEvents);
  pendingEvents = [];
  await act(async () => {
    root.unmount();
  });
  editor.destroy();
  closeDocumentSync(FILE);
  vi.mocked(console.log).mockRestore?.();
}

/** Editor, disk, and content row all hold exactly `expected`. */
function expectConverged(expected: string) {
  const { content } = getOrCreateWorkspaceCollections(WS);
  expect(editor.state.doc.textContent, "editor did not adopt").toBe(expected);
  expect(fake.store.get(FILE)?.content, "disk was overwritten").toBe(expected);
  expect(content.get(FILE)?.content, "content row is stale").toBe(expected);
}

const SEEDS = [11, 4242, 8675309];

describe("external writes restoring app-written content (git revert)", () => {
  beforeEach(() => {
    pendingEvents = [];
  });
  afterEach(teardownWorkspace);

  it.each(SEEDS)(
    "adopts a revert to app-saved content; typing then builds on it (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0x1e44);

      // The app writes v1, then v2 — both byte states are its own saves.
      await typeChars("abc", 5);
      await settle();
      const v1OnDisk = fake.store.get(FILE)!.content;
      await typeChars("def", 5);
      await settle();
      expect(fake.store.get(FILE)!.content).not.toBe(v1OnDisk);

      // git checkout -- note.md: disk goes back to v1, bytes identical to
      // the app's own earlier save. It must be adopted...
      await externalWrite(v1OnDisk);
      await settle();
      expect(adoptionCount, "the revert must be adopted").toBeGreaterThan(0);
      expectConverged(INITIAL + "abc");

      // ...and the next edit must extend the revert, not resurrect "def".
      await act(async () => {
        editor.commands.focus("end");
      });
      await typeChars("X", 5);
      await settle();
      expectConverged(INITIAL + "abcX");
    },
    30_000,
  );

  it("still adopts novel external content (baseline; not timing-sensitive)", async () => {
    await setupWorkspace(11 ^ 0x0b5e);

    await typeChars("abc", 5);
    await settle();

    await externalWrite("replaced from outside");
    await settle();

    expect(adoptionCount).toBeGreaterThan(0);
    expectConverged("replaced from outside");
  }, 30_000);

  it.each(SEEDS)(
    "an agent write to the open file converges and is never rolled back (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0xa9e7);

      await typeChars("abc", 5);
      await settle();

      // The agent/blob write primitive. Model the no-leak platform case —
      // every echo of this write is consumed natively (register a second
      // matching entry for the sim's second event) — so only the row
      // update the write performs itself can carry the new content into
      // the collection; a stale row would later be adopted over the
      // agent's write.
      await act(async () => {
        await writeWorkspaceTextFile(FILE, "agent wrote this");
        watcherSim.appWrites.push({
          path: FILE,
          hash: calculateContentHash("agent wrote this"),
        });
      });
      await settle();
      expectConverged("agent wrote this");

      // Typing afterwards must extend the agent content, not resurrect the
      // pre-agent state.
      await act(async () => {
        editor.commands.focus("end");
      });
      await typeChars("X", 5);
      await settle();
      expectConverged("agent wrote thisX");
    },
    30_000,
  );

  it.each(SEEDS)(
    "a revert landing mid-typing loses to the keystrokes everywhere (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0x717e);

      await typeChars("abc", 5);
      await settle();
      const v1OnDisk = fake.store.get(FILE)!.content;

      // Revert lands while edits sit in the debounce window: last-writer-
      // wins — the keystrokes survive in the editor AND overwrite the
      // revert on disk, leaving no split state.
      await typeChars("def", 5);
      await externalWrite(v1OnDisk);
      await typeChars("ghi", 5);
      await settle();

      expectConverged(INITIAL + "abcdefghi");
    },
    30_000,
  );

  it.each(SEEDS)(
    "alternating typing and external writes never oscillates (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0x05c2);

      // Two rounds suffice: an oscillation shows up on the first
      // external→internal round trip.
      let expected = INITIAL;
      for (let round = 0; round < 2; round++) {
        // Internal round: keystrokes converge.
        const chunk = `t${round}`;
        expected += chunk;
        await act(async () => {
          editor.commands.focus("end");
        });
        await typeChars(chunk, 5);
        await settle();
        expectConverged(expected);

        // External round: an outside writer (whose content includes bytes
        // this app has saved before) converges too.
        expected = `${expected}-ext${round}`;
        await externalWrite(expected);
        await settle();
        expectConverged(expected);
      }
    },
    30_000,
  );
});
