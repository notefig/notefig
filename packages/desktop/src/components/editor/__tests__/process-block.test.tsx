/**
 * The process block through the real markdown pipeline and node view: its
 * marker survives file → doc → file, a block the app never registered is
 * dropped however it arrives (but never before the registry has loaded),
 * and the block runs its registered command again once the process's
 * stream is gone.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  createProcessBlocks,
  PROCESS_FLUSH_MS as FLUSH_MS,
  widgetRendererNodes,
  type ProcessBlocksApi,
  type ProcessRegistry,
  type SpawnProcess,
} from "@notefig/widgets";
import { editorExtensions } from "../tiptap-editor-kit";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MARKER = '<!-- notefig:process id="blob_proc_1a2b" -->';
const FOREIGN = '<!-- notefig:process id="blob_forged" -->';
const SOURCE = `# Title\n\n${MARKER}\n\nAfter\n`;

/** blob_proc_1a2b is registered; the registry loads when `finish` is called. */
function registry() {
  let finish!: () => void;
  const load = new Promise<void>((resolve) => (finish = resolve));
  const fake: ProcessRegistry = {
    load: () => load,
    get: (blobId) =>
      blobId === "blob_proc_1a2b"
        ? { command: "npm run dev", cwd: "/ws" }
        : undefined,
  };
  return { registry: fake, finish };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Past the service's batch window: emitted lines have landed. */
const flushed = () =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS + 10));

const extensions = (processes?: ProcessBlocksApi) => [
  ...editorExtensions.filter(
    (e) => e.name !== "aiPrompt" && e.name !== "processBlock",
  ),
  ...widgetRendererNodes({
    filePath: "/ws/doc.md",
    basePath: "/ws",
    processes,
  }),
];

function markdownOf(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
}

function blockIds(editor: Editor) {
  const ids: unknown[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "processBlock") ids.push(node.attrs.blobId);
  });
  return ids;
}

describe("process marker round trip", () => {
  it("parses a marker into a block and writes it back unchanged", () => {
    const editor = new Editor({ extensions: extensions(), content: SOURCE });
    expect(blockIds(editor)).toEqual(["blob_proc_1a2b"]);
    expect(markdownOf(editor)).toBe(SOURCE.trimEnd());
    editor.destroy();
  });
});

describe("dropping blocks the app never minted", () => {
  const spawn: SpawnProcess = () => {
    throw new Error("nothing runs here");
  };

  it("keeps every block until the registry loads, then drops the foreign one", async () => {
    const { registry: fake, finish } = registry();
    const processes = createProcessBlocks({ spawn, registry: fake });
    const editor = new Editor({
      extensions: extensions(processes),
      content: `${MARKER}\n\n${FOREIGN}\n\nAfter\n`,
    });

    // Loading: no id is known to be foreign, so a save now keeps both,
    // and so does a write adopted meanwhile.
    await settle();
    editor.commands.setContent(`${MARKER}\n\n${FOREIGN}\n\nAfter\n`);
    expect(blockIds(editor)).toEqual(["blob_proc_1a2b", "blob_forged"]);
    expect(markdownOf(editor)).toContain(FOREIGN);

    finish();
    await processes.loaded();
    await settle();
    expect(blockIds(editor)).toEqual(["blob_proc_1a2b"]);
    expect(markdownOf(editor)).not.toContain("blob_forged");
    // Out of history: undo doesn't bring it back.
    editor.commands.undo();
    expect(blockIds(editor)).toEqual(["blob_proc_1a2b"]);
    editor.destroy();
  });

  it("drops a foreign block that arrives later: an adopted write, a paste", async () => {
    const { registry: fake, finish } = registry();
    const processes = createProcessBlocks({ spawn, registry: fake });
    finish();
    const editor = new Editor({
      extensions: extensions(processes),
      content: "x",
    });
    await processes.loaded();

    editor.commands.setContent(`${MARKER}\n\n${FOREIGN}\n`);
    expect(blockIds(editor)).toEqual(["blob_proc_1a2b"]);

    editor.commands.insertContentAt(
      editor.state.doc.content.size,
      '<div data-type="process" data-blob-id="blob_forged"></div>' +
        '<div data-type="process"></div>' +
        '<div data-type="process" data-blob-id="blob_proc_1a2b"></div>',
    );
    expect(blockIds(editor)).toEqual(["blob_proc_1a2b", "blob_proc_1a2b"]);
    editor.destroy();
  });
});

describe("process block view", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  let editor: Editor | null = null;

  function Harness({ processes }: { processes: ProcessBlocksApi }) {
    editor = useEditor({ extensions: extensions(processes), content: SOURCE });
    return editor ? createElement(EditorContent, { editor }) : null;
  }

  const lines: Array<(line: string) => void> = [];
  const exits: Array<() => void> = [];
  const kill = vi.fn();
  const spawn = vi.fn<SpawnProcess>(() => ({
    start: () => Promise.resolve(),
    onLine: (listener) => (lines.push(listener), () => {}),
    onClose: (listener) => (exits.push(listener), () => {}),
    close: async () => {
      kill();
      exits.at(-1)!();
    },
  }));

  async function mount(options: { load?: boolean } = {}) {
    lines.length = 0;
    exits.length = 0;
    spawn.mockClear();
    kill.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const { registry: fake, finish } = registry();
    if (options.load !== false) finish();
    await act(async () => {
      root!.render(
        createElement(Harness, {
          processes: createProcessBlocks({ spawn, registry: fake }),
        }),
      );
      await settle();
    });
    return finish;
  }

  const button = (label: string) => () =>
    container!.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
  const run = button("processBlockRun");
  const stop = button("processBlockStop");

  it("shows nothing until the registry says what the block runs", async () => {
    const finish = await mount({ load: false });
    expect(container!.querySelector("code")).toBeNull();
    await act(async () => {
      finish();
      await settle();
    });
    expect(container!.querySelector("code")?.textContent).toBe("npm run dev");
  });

  it("runs the registered command again once its stream is gone", async () => {
    await mount();

    // Read from the file: no stream yet, nothing runs until asked.
    expect(spawn).not.toHaveBeenCalled();
    await act(async () => run()!.click());
    expect(spawn).toHaveBeenCalledWith({
      procId: "proc_1a2b",
      command: "npm run dev",
      cwd: "/ws",
    });
    expect(run()).toBeNull();

    await act(async () => {
      lines[0]("ready on :3000");
      await flushed();
    });
    expect(container!.querySelector("pre")?.textContent).toBe("ready on :3000");

    await act(async () => exits[0]());
    await act(async () => run()!.click());
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("stops the running process from its stop button", async () => {
    await mount();
    await act(async () => run()!.click());
    await act(async () => stop()!.click());
    expect(kill).toHaveBeenCalledTimes(1);
    expect(stop()).toBeNull();
    expect(run()).not.toBeNull();
  });

  it("follows the newest line, and stops following once scrolled up", async () => {
    await mount();
    await act(async () => run()!.click());
    const pre = () => container!.querySelector("pre")!;
    const emit = (line: string) =>
      act(async () => {
        lines[0](line);
        await flushed();
      });
    await emit("one");
    // jsdom lays nothing out: give the box a size to scroll.
    Object.defineProperty(pre(), "scrollHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(pre(), "clientHeight", {
      value: 100,
      configurable: true,
    });
    await emit("two");
    expect(pre().scrollTop).toBe(400);

    pre().scrollTop = 0;
    pre().dispatchEvent(new Event("scroll"));
    await emit("three");
    expect(pre().scrollTop).toBe(0);
  });

  it("is selected by the keyboard, never a click, and wears the tint", async () => {
    await mount();
    const view = editor!.view;
    let at = -1;
    editor!.state.doc.descendants((node, pos) => {
      if (node.type.name === "processBlock") at = pos;
    });
    const tinted = () =>
      container!
        .querySelector(".node-processBlock")!
        .hasAttribute("data-widget-selected");

    // A click on it is the reader's: nothing selects the block.
    const node = editor!.state.doc.nodeAt(at)!;
    expect(
      view.someProp("handleClickOn", (handle) =>
        handle(view, at + 1, node, at, new MouseEvent("click"), true),
      ),
    ).toBe(true);
    expect(tinted()).toBe(false);

    // Picked by the keyboard, or inside a range: the tint.
    await act(async () => void editor!.commands.setNodeSelection(at));
    expect(tinted()).toBe(true);
    await act(async () => void editor!.commands.setTextSelection(1));
    expect(tinted()).toBe(false);
    await act(async () => void editor!.commands.selectAll());
    expect(tinted()).toBe(true);

    // Typing over it never replaces it.
    await act(async () => void editor!.commands.setNodeSelection(at));
    const typed = view.someProp("handleTextInput", (handle) =>
      handle(view, at, at + node.nodeSize, "x", () => view.state.tr),
    );
    expect(typed).toBe(true);
    expect(blockIds(editor!)).toEqual(["blob_proc_1a2b"]);
  });

  it("shows the whole command, and runs or stops on 1 while the block is selected", async () => {
    await mount();
    expect(container!.querySelector("code")?.textContent).toBe("npm run dev");
    const press = (key: string) =>
      editor!.view.someProp("handleKeyDown", (handle) =>
        handle(editor!.view, new KeyboardEvent("keydown", { key })),
      );

    // Not selected: the digit is the text's.
    expect(press("1")).toBeFalsy();
    expect(spawn).not.toHaveBeenCalled();

    let at = -1;
    editor!.state.doc.descendants((node, pos) => {
      if (node.type.name === "processBlock") at = pos;
    });
    await act(async () => void editor!.commands.setNodeSelection(at));
    expect(run()!.textContent).toBe("1");
    await act(async () => void press("1"));
    expect(spawn).toHaveBeenCalledTimes(1);

    // Running: `1` stops it, and the digit never replaces the block.
    await act(async () => void press("1"));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(editor!.state.doc.textContent).not.toContain("1");
  });
});
