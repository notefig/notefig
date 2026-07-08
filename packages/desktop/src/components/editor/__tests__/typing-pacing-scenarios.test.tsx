/**
 * Pacing / paste / oscillation / remount-timing sweep over the typing →
 * save → collection → adoption loop.
 *
 * The sibling `typing-save-integrity.test.tsx` proves the loop converges for
 * ONE profile: fast bursts with long (>debounce) idle pauses, remounting only
 * while idle. That leaves whole classes of real-world timing unexercised —
 * and the user still sees "older content overwrites newer" occasionally. This
 * file drives the SAME realistic watcher against many profiles to find which
 * timing still regresses:
 *
 *   - pauses straddling the autosave debounce (just under / just over),
 *   - sustained typing with no pause long enough to flush between bursts,
 *   - large paste insertions (one huge update, like ⌘V),
 *   - oscillation: type then backspace, so content revisits EARLIER hashes
 *     (stresses the self-write ledger, which is a membership test),
 *   - remount (tab switch / layout change) while a save is still PENDING in
 *     the debounce window — the case the integrity test never hits.
 *
 * Invariant (identical for every profile, no external writer exists):
 *   editor text === disk === content row === exactly what was typed, and
 *   zero adoptions (any adoption = an internal write seen as external).
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

// ---------------------------------------------------------------------------
// In-memory platform adapter with jittered async latency (hoisted for vi.mock)
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  interface FakeFile {
    content: string;
    modifiedAt: Date;
    createdAt: Date;
  }

  const store = new Map<string, FakeFile>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Deterministic PRNG, reseedable per run so each profile can be replayed
  // under several interleavings without flaking.
  let seed = 42;
  const reseed = (n: number) => {
    seed = n;
  };
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const writeLatency = () => 2 + Math.floor(rand() * 20);
  const readLatency = () => 1 + Math.floor(rand() * 10);

  const listeners = new Set<(event: unknown) => void>();

  const hooks: {
    beforeWrite?: (path: string, newContent: string) => void;
    afterWrite?: (path: string) => void;
  } = {};

  const adapter = {
    async readDirectory(path: string) {
      await sleep(readLatency());
      const prefix = path.endsWith("/") ? path : path + "/";
      return {
        ok: true as const,
        value: [...store.keys()].filter((p) => p.startsWith(prefix)),
      };
    },

    async getMetadata(paths: string[]) {
      await sleep(readLatency());
      const succeeded = paths
        .filter((p) => store.has(p))
        .map((p) => {
          const f = store.get(p)!;
          return {
            path: p,
            type: "file" as const,
            size: f.content.length,
            modifiedAt: f.modifiedAt,
            createdAt: f.createdAt,
          };
        });
      return { succeeded, failed: [] };
    },

    async readFiles(paths: string[]) {
      await sleep(readLatency());
      const succeeded = paths
        .filter((p) => store.has(p))
        .map((p) => ({ path: p, content: store.get(p)!.content }));
      return { succeeded, failed: [] };
    },

    async writeFiles(files: { path: string; content: string }[]) {
      for (const f of files) {
        hooks.beforeWrite?.(f.path, f.content);
      }
      await sleep(writeLatency());
      for (const f of files) {
        const existing = store.get(f.path);
        store.set(f.path, {
          content: f.content,
          modifiedAt: new Date(),
          createdAt: existing?.createdAt ?? new Date(),
        });
      }
      for (const f of files) {
        hooks.afterWrite?.(f.path);
      }
      return { succeeded: files.map((f) => f.path), failed: [] };
    },

    async createFiles(paths: string[]) {
      return adapter.writeFiles(paths.map((path) => ({ path, content: "" })));
    },

    async createDirectories(paths: string[]) {
      return { succeeded: paths, failed: [] };
    },

    async deleteFiles(paths: string[]) {
      await sleep(writeLatency());
      paths.forEach((p) => store.delete(p));
      return { succeeded: paths, failed: [] };
    },

    async deleteDirectories(paths: string[]) {
      return { succeeded: paths, failed: [] };
    },

    async moveFile() {
      return { ok: true as const, value: undefined };
    },

    async moveDirectory() {
      return { ok: true as const, value: undefined };
    },

    addEventListener(cb: (event: unknown) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async startWatchingMetadata() {},
    async startWatchingContent() {},
    stopWatching() {},

    async pickDirectory() {
      return null;
    },
    async promptText() {
      return null;
    },
  };

  return { store, adapter, listeners, hooks, reseed };
});

vi.mock("@/adapters", () => ({
  platformAdapter: fake.adapter,
}));

import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { useEditorFileSync } from "../use-editor-file-sync";
import {
  getOrCreateWorkspaceCollections,
  type FileMetadata,
} from "@/utils/collections";
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

// ---------------------------------------------------------------------------
// Harness: workspace.tsx data path, minus the chrome
// ---------------------------------------------------------------------------

let workspaceCounter = 0;
let WS: string;
let FILE: string;

let editor: Editor;
let root: Root;
let container: HTMLElement;
let pendingEvents: Promise<void>[] = [];
let adoptionCount = 0;

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

function remount() {
  root.unmount();
  root = createRoot(container);
  root.render(createElement(Harness));
}

/** Type `text` at the caret, one char per keystroke with `delayMs` between. */
async function typeChars(text: string, delayMs: number) {
  await act(async () => {
    for (const char of text) {
      editor.commands.insertContent(char);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  });
}

/** Paste: a single large insertion, as ⌘V produces one update event. */
async function paste(text: string) {
  await act(async () => {
    editor.commands.insertContent(text);
  });
}

/** Backspace the last `count` characters (single-paragraph doc). */
async function backspace(count: number) {
  await act(async () => {
    const end = editor.state.doc.content.size - 1;
    editor.commands.deleteRange({ from: Math.max(1, end - count), to: end });
  });
}

async function setupWorkspace(seed: number) {
  workspaceCounter++;
  WS = `/ws-pacing-${workspaceCounter}`;
  FILE = `${WS}/note.md`;
  fake.reseed(seed);

  fake.store.clear();
  fake.store.set(FILE, {
    content: INITIAL,
    modifiedAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 60_000),
  });

  // Desktop (Tauri) watcher semantics, mirrored from src-tauri (see the
  // integrity test for the full rationale): register-hash-before-write,
  // read-at-handling-time, consume-one-or-emit-external, two events per
  // atomic write.
  const appWrites: { path: string; hash: string }[] = [];
  let eventSeed = seed ^ 0x5bd1e995;
  const eventDelay = () => {
    eventSeed = (eventSeed * 1103515245 + 12345) & 0x7fffffff;
    return 5 + (eventSeed % 60);
  };
  fake.hooks.beforeWrite = (path, newContent) => {
    appWrites.push({ path, hash: calculateContentHash(newContent) });
  };
  const scheduleFsEvent = (path: string) => {
    pendingEvents.push(
      (async () => {
        await new Promise((r) => setTimeout(r, eventDelay()));
        const content = fake.store.get(path)?.content ?? "";
        const hash = calculateContentHash(content);
        const index = appWrites.findIndex(
          (w) => w.path === path && w.hash === hash,
        );
        if (index !== -1) {
          appWrites.splice(index, 1);
          return;
        }
        await new Promise((r) => setTimeout(r, eventDelay()));
        const event: ContentChangeEvent = {
          changes: [{ path, content, contentHash: hash }],
        };
        await handleContentFileSystemChange(event, WS);
      })(),
    );
  };
  fake.hooks.afterWrite = (path) => {
    scheduleFsEvent(path);
    scheduleFsEvent(path);
  };

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

/** Assert the whole loop converged on exactly `expected`. */
function expectConverged(expected: string) {
  const { content } = getOrCreateWorkspaceCollections(WS);
  expect(
    adoptionCount,
    "internal writes were categorized as external and adopted",
  ).toBe(0);
  expect(editor.state.doc.textContent, "editor reverted/lost content").toBe(
    expected,
  );
  expect(fake.store.get(FILE)?.content, "disk holds stale content").toBe(
    expected,
  );
  expect(content.get(FILE)?.content, "content row holds stale content").toBe(
    expected,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 500;

// "Less frequent" means the regression only shows under a particular
// interleaving of write latency, fs-event delay, and IPC timing. A single
// seed samples one interleaving; each profile is swept over several so the
// race actually surfaces.
const SEEDS = [11, 137, 4242, 90210, 8675309, 271828];

describe("typing pacing / paste / oscillation / remount-timing sweep", () => {
  beforeEach(() => {
    pendingEvents = [];
  });
  afterEach(teardownWorkspace);

  // Pauses straddling the debounce boundary. Just-under never lets a burst
  // flush before the next begins; just-over flushes between every burst.
  for (const pauseMs of [
    AUTOSAVE_DEBOUNCE_MS - 120,
    AUTOSAVE_DEBOUNCE_MS + 120,
  ]) {
    it.each(SEEDS)(
      `converges with ${pauseMs}ms inter-burst pauses (seed %i)`,
      async (seed) => {
        await setupWorkspace(seed ^ pauseMs);
        let typed = "";
        for (let burst = 0; burst < 6; burst++) {
          const chunk = "abcdefgh";
          typed += chunk;
          await typeChars(chunk, 4);
          await tick(pauseMs);
        }
        await settle();
        expectConverged(INITIAL + typed);
      },
      30_000,
    );
  }

  it.each(SEEDS)(
    "converges under sustained typing with no flush-length pause (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0xa11ce);
      let typed = "";
      // 80 chars, only tiny gaps — many debounce windows never close until
      // the very end, maximizing coalescing and in-flight-save overlap.
      for (let i = 0; i < 80; i++) {
        const char = String.fromCharCode(97 + (i % 26));
        typed += char;
        await typeChars(char, 6);
      }
      await settle();
      expectConverged(INITIAL + typed);
    },
    30_000,
  );

  it.each(SEEDS)(
    "converges with large pastes interleaved with typing (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0xba5e);
      let expected = INITIAL;
      for (let burst = 0; burst < 4; burst++) {
        const chunk = `type${burst}`;
        expected += chunk;
        await typeChars(chunk, 5);
        // Alphanumeric only: markdown escapes punctuation like [], so a
        // plain-text expectation would spuriously mismatch the on-disk
        // markdown. The point here is the size of one paste, not its glyphs.
        const pasted = `PASTE${burst}${"x".repeat(40)}`;
        expected += pasted;
        await paste(pasted);
        await tick(300); // sub-debounce, then keep going
      }
      await settle();
      expectConverged(expected);
    },
    30_000,
  );

  it.each(SEEDS)(
    "converges when typing oscillates: type then backspace (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0x05c1);
      // Model the exact same edits to compute the expected final string.
      let model = INITIAL;
      for (let burst = 0; burst < 6; burst++) {
        const chunk = "wxyz";
        await typeChars(chunk, 5);
        model += chunk;
        await tick(120);
        // Backspace part of what we just typed — content now revisits an
        // earlier value, whose hash the self-write ledger already holds
        // (membership, not consume-once, must let that stand).
        await backspace(2);
        model = model.slice(0, -2);
        await tick(600); // let it flush
      }
      await settle();
      expectConverged(model);
    },
    30_000,
  );

  it.each(SEEDS)(
    "converges when remounted WHILE a save is still pending (seed %i)",
    async (seed) => {
      await setupWorkspace(seed ^ 0xdead);
      let typed = "";
      for (let burst = 0; burst < 6; burst++) {
        const chunk = "mnopqr";
        typed += chunk;
        await typeChars(chunk, 4);
        // Remount BEFORE the debounce fires: the pending save flushes on
        // teardown, a fresh hook mounts with an empty saveTimerRef, and the
        // on-demand join may re-read disk mid-flight. This is the window the
        // integrity test skips (it only remounts while idle).
        await tick(150);
        remount();
        await tick(80);
      }
      await settle();
      expectConverged(INITIAL + typed);
    },
    30_000,
  );
});
