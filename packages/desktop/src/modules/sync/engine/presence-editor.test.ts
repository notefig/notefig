/**
 * The presence plugin in a live editor: remote carets, selections and
 * agent holders drawn from the channel's value, kept in place through
 * local edits, the local caret reported throttled; and the attach manager
 * putting the plugin on only while enabled (the shared level).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createDocumentPort, type SyncRemoteCursor } from "../document-channel";
import {
  createPresenceEditors,
  createPresencePlugin,
  PRESENCE_CURSOR_THROTTLE_MS,
  presencePluginKey,
} from "./presence-editor";

const editors: Editor[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit],
    content: "<h1>Title</h1><p>Alpha line.</p><p>Beta line.</p>",
  });
  editors.push(editor);
  return editor;
}

const ada: SyncRemoteCursor = {
  holderId: "dev-ada",
  name: "Ada",
  color: "#8e4ec6",
  anchor: { blockIndex: 1, offset: 3 },
  head: { blockIndex: 1, offset: 8 },
};

const agent: SyncRemoteCursor = {
  holderId: "dev-ada/task-1",
  name: "Ada · claude",
  color: "#8e4ec6",
  anchor: { blockIndex: 2, offset: 1 },
  head: null,
  agent: { taskId: "task-1", harness: "claude", label: "Fix", status: "editing" },
};

const show = (editor: Editor, cursors: SyncRemoteCursor[]) =>
  editor.view.dispatch(editor.state.tr.setMeta(presencePluginKey, cursors));

describe("the presence plugin", () => {
  it("draws a remote caret with its name, its selection, and an agent holding a block", () => {
    const editor = makeEditor();
    editor.registerPlugin(createPresencePlugin({ onCursor: () => {} }));
    show(editor, [ada, agent]);
    const dom = editor.view.dom;
    const caret = dom.querySelector<HTMLElement>(".sync-presence-caret")!;
    expect(caret.textContent).toBe("Ada");
    expect(caret.style.borderLeft).toContain("2px solid");
    const selection = dom.querySelector<HTMLElement>(".sync-presence-selection")!;
    // Block 1 is the first paragraph ("Alpha line."): offsets 3..8 → "pha l".
    expect(selection.textContent).toBe("pha l");
    const held = dom.querySelector<HTMLElement>(".sync-presence-agent-block")!;
    expect(held.textContent).toContain("Beta line.");
    expect(held.querySelector(".sync-presence-agent-badge")?.textContent).toBe("AI");
    expect(held.textContent).toContain("Ada · claude");
  });

  it("keeps the caret on its text through a local edit above it, and clears on an empty value", () => {
    const editor = makeEditor();
    editor.registerPlugin(createPresencePlugin({ onCursor: () => {} }));
    show(editor, [{ ...ada, head: null }]);
    const before = presencePluginKey.getState(editor.state)!.decorations.find()[0].from;
    editor.commands.insertContentAt(1, "Big ");
    const after = presencePluginKey.getState(editor.state)!.decorations.find()[0].from;
    expect(after).toBe(before + 4);
    show(editor, []);
    expect(editor.view.dom.querySelector(".sync-presence-caret")).toBeNull();
  });

  it("reports the local caret as a block position, throttled, only while focused", () => {
    vi.useFakeTimers();
    const editor = makeEditor();
    const onCursor = vi.fn();
    editor.registerPlugin(createPresencePlugin({ onCursor }));
    vi.spyOn(editor.view, "hasFocus").mockReturnValue(true);
    editor.commands.setTextSelection(15);
    editor.commands.setTextSelection(16);
    editor.commands.setTextSelection(17);
    expect(onCursor).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS);
    expect(onCursor).toHaveBeenCalledTimes(1);
    // Title is 7 positions; "Alpha line." block starts at 7: 17 → offset 10.
    expect(onCursor).toHaveBeenCalledWith({
      anchor: { blockIndex: 1, offset: 10 },
      head: { blockIndex: 1, offset: 10 },
    });
    vi.mocked(editor.view.hasFocus).mockReturnValue(false);
    editor.commands.setTextSelection(3);
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS);
    expect(onCursor).toHaveBeenCalledTimes(1);
  });
});

describe("attaching to a workspace's editors", () => {
  it("puts the plugin on only while enabled, and follows the channel's carets", async () => {
    const editor = makeEditor();
    let enabled = false;
    const ports = new Map<string, ReturnType<typeof createDocumentPort>>();
    const manager = createPresenceEditors({
      workspacePath: "/ws",
      editors: {
        paths: () => ["/ws/a.md", "/elsewhere/b.md"],
        markdownEditor: (path) => (path === "/ws/a.md" ? editor : undefined),
      },
      enabled: () => enabled,
      openPort: (path) => {
        const port = createDocumentPort(path, { onClose: () => ports.delete(path) });
        ports.set(path, port);
        return port;
      },
    });
    const hasPlugin = () => !!presencePluginKey.getState(editor.state);
    manager.reconcile();
    expect(hasPlugin()).toBe(false);
    expect(ports.size).toBe(0);

    enabled = true;
    manager.reconcile();
    expect(hasPlugin()).toBe(true);
    expect(manager.attached()).toEqual(["/ws/a.md"]);
    ports.get("/ws/a.md")!.remoteCursors.set([ada]);
    await vi.waitFor(() =>
      expect(editor.view.dom.querySelector(".sync-presence-caret")?.textContent).toBe("Ada"),
    );

    enabled = false;
    manager.reconcile();
    expect(hasPlugin()).toBe(false);
    expect(editor.view.dom.querySelector(".sync-presence-caret")).toBeNull();
    expect(ports.size).toBe(0);
  });
});
