/**
 * Targeted invariants for the disk → editor adoption path (MET-70).
 *
 * typing-save-integrity.test.tsx exercises the full pipeline under jittered
 * latencies — a lottery that happens to catch races only when the timing
 * dice land right (it never rolled MET-70's). This suite removes the dice:
 * the `file` prop that drives useEditorFileSync's adoption effect is
 * DELIVERED EXPLICITLY, so each hazard is constructed, not hoped for:
 *
 *  1. A row holding an EARLIER SELF-SAVE arrives after the editor moved on
 *     (what a stale render delivers under back-to-back autosaves — the
 *     MET-70 jump-back). Must never replace the editor, at any offset
 *     around an in-flight save.
 *  2. A genuinely EXTERNAL row (content this app never wrote) arrives while
 *     the editor is idle. Must replace the editor — the self-write guard
 *     must not overblock.
 *  3. An external row arrives during RAPID TYPING. The user's keystrokes
 *     win (last-writer-wins), and the file converges to what was typed.
 *
 * Everything else is real: TipTap editor, DocumentSync save loop,
 * writeFileContent → collections → (fake, latency-shaped) adapter, and the
 * recentSelfWrites ledger that writeFileContent feeds.
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
import { act, useState, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";

// ---------------------------------------------------------------------------
// In-memory platform adapter (hoisted for vi.mock). Fixed small latencies —
// determinism is the point of this suite.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const store = new Map<string, { content: string; modifiedAt: Date }>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const WRITE_LATENCY = 12;
  const READ_LATENCY = 4;

  const adapter = {
    async readDirectory(path: string) {
      await sleep(READ_LATENCY);
      const prefix = path.endsWith("/") ? path : path + "/";
      return {
        ok: true as const,
        value: [...store.keys()].filter((p) => p.startsWith(prefix)),
      };
    },
    async getMetadata(paths: string[]) {
      await sleep(READ_LATENCY);
      return {
        succeeded: paths
          .filter((p) => store.has(p))
          .map((p) => ({
            path: p,
            type: "file" as const,
            size: store.get(p)!.content.length,
            modifiedAt: store.get(p)!.modifiedAt,
            createdAt: store.get(p)!.modifiedAt,
          })),
        failed: [],
      };
    },
    async readFiles(paths: string[]) {
      await sleep(READ_LATENCY);
      return {
        succeeded: paths
          .filter((p) => store.has(p))
          .map((p) => ({ path: p, content: store.get(p)!.content })),
        failed: [],
      };
    },
    async writeFiles(files: { path: string; content: string }[]) {
      await sleep(WRITE_LATENCY);
      for (const f of files) {
        store.set(f.path, { content: f.content, modifiedAt: new Date() });
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
      paths.forEach((p) => store.delete(p));
      return { succeeded: paths, failed: [] };
    },
    async deleteDirectories(paths: string[]) {
      return { succeeded: paths, failed: [] };
    },
    addEventListener() {
      return () => {};
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

  return { store, adapter };
});

vi.mock("@/adapters", () => ({
  platformAdapter: fake.adapter,
}));

// Real modules — imported after the adapter mock so they bind to the fake fs.
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { useEditorFileSync } from "../use-editor-file-sync";
import {
  closeDocumentSync,
  resetConverterForTests,
} from "@/utils/markdown-conversion";
import { calculateContentHash } from "@/utils/hash";
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

// ---------------------------------------------------------------------------
// Harness: real hook, real editor, prop-controlled file entry
// ---------------------------------------------------------------------------

let workspaceCounter = 0;
let WS: string;
let FILE: string;
let editor: Editor;
let root: Root;

const INITIAL = "start";

function entryFor(content: string): FileEntry {
  return {
    path: FILE,
    type: "file",
    content,
    contentHash: calculateContentHash(content),
  };
}

/** The adoption path re-renders with whatever row state React delivers;
 * here that delivery is explicit. */
let deliverEntry: (entry: FileEntry) => void;

function Harness({ initial }: { initial: FileEntry }) {
  const [entry, setEntry] = useState(initial);
  deliverEntry = setEntry;
  useEditorFileSync(editor, entry, WS, true, undefined);
  return null;
}

async function tick(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Type text into the editor character by character, like keyboard input. */
async function type(text: string, msPerChar = 3) {
  await act(async () => {
    for (const char of text) {
      editor.commands.insertContent(char);
      await new Promise((resolve) => setTimeout(resolve, msPerChar));
    }
  });
}

/** Past the 500ms autosave debounce + write latency: the save has flushed
 * and its hash sits in the self-write ledger. */
async function flushSave() {
  await tick(700);
}

beforeEach(async () => {
  workspaceCounter++;
  WS = `/ws-adoption-${workspaceCounter}`;
  FILE = `${WS}/note.md`;

  fake.store.clear();
  fake.store.set(FILE, {
    content: INITIAL,
    modifiedAt: new Date(Date.now() - 60_000),
  });

  editor = new Editor({
    extensions: editorExtensions,
    content: INITIAL,
    editable: true,
    autofocus: false,
  });

  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(Harness, { initial: entryFor(INITIAL) }));
  });
  await tick(30);
  editor.commands.focus("end");
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  editor.destroy();
  closeDocumentSync(FILE);
});

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

describe("adoption integrity: self-writes vs external writes vs typing", () => {
  it("a row holding an earlier self-save never replaces the editor (MET-70 jump-back)", async () => {
    // Two consecutive autosaved states, exactly like a deletion/undo/paste
    // sequence: state A saved, then state B saved. (Segments are space-free:
    // insertContent collapses whitespace-only chunks.)
    await type("Alpha");
    await flushSave();
    const stateA = editor.state.doc.textContent;

    await type("Beta");
    await flushSave();
    const stateB = editor.state.doc.textContent;
    expect(fake.store.get(FILE)?.content).toBe(stateB);

    // The MET-70 hazard: a render delivers the PREVIOUS save's row while
    // the editor is idle. Every guard that depends on save-in-flight state
    // (saving/dirty/debounce timer) is clear — only the self-write ledger
    // can tell this row is not an external change.
    deliverEntry(entryFor(stateA));
    await tick(300);

    expect(
      editor.state.doc.textContent,
      "editor rolled back to an earlier self-saved state",
    ).toBe(stateB);

    // Same delivery at offsets straddling an in-flight save: right as the
    // debounce fires, mid-write, and just after completion. None may roll
    // the editor back or corrupt what gets saved.
    let previous = stateB;
    for (const offset of [490, 505, 540, 620]) {
      await type("x");
      const current = editor.state.doc.textContent;
      await tick(offset);
      deliverEntry(entryFor(previous));
      await tick(900);
      expect(
        editor.state.doc.textContent,
        `stale row delivered at +${offset}ms replaced the editor`,
      ).toBe(current);
      expect(fake.store.get(FILE)?.content).toBe(current);
      previous = current;
    }
  }, 20_000);

  it("a genuinely external row is adopted while idle — the guard must not overblock", async () => {
    await type("Mine");
    await flushSave();

    // Content this app never wrote: not in the ledger, hash unknown.
    const external = "replaced by another program entirely";
    deliverEntry(entryFor(external));
    await tick(300);

    expect(editor.state.doc.textContent).toBe(external);

    // Adoption must be committed, not just painted: a follow-up edit saves
    // on top of the adopted baseline instead of resurrecting the old one.
    await type("PlusMore");
    await flushSave();
    expect(fake.store.get(FILE)?.content).toBe(external + "PlusMore");
  }, 15_000);

  it("rapid typing wins over a concurrent external change (last-writer-wins)", async () => {
    await type("Mine");
    await flushSave();
    const base = editor.state.doc.textContent;

    // External change lands mid-burst: the debounce timer / in-flight save
    // guards must hold it off, and the user's keystrokes must survive.
    await type("Typing");
    deliverEntry(entryFor("external mid-typing clobber attempt"));
    await type("Continues");
    await flushSave();
    await tick(300);

    const typed = base + "TypingContinues";
    expect(
      editor.state.doc.textContent,
      "external content replaced the editor mid-typing",
    ).toBe(typed);
    expect(fake.store.get(FILE)?.content).toBe(typed);
  }, 15_000);
});
