/**
 * The process block through the real markdown pipeline and node view: its
 * marker survives file → doc → file, and the block restarts its command
 * once the process's stream is gone.
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
  widgetRendererNodes,
  type ProcessBlocksApi,
  type SpawnProcess,
} from "@notefig/widgets";
import { editorExtensions } from "../tiptap-editor-kit";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MARKER = '<!-- notefig:process id="blob_1a2b" command="npm run dev" -->';
const SOURCE = `# Title\n\n${MARKER}\n\nAfter\n`;

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

describe("process marker round trip", () => {
  it("parses a marker into a block and writes it back unchanged", () => {
    const editor = new Editor({ extensions: extensions(), content: SOURCE });
    const blocks: Array<Record<string, unknown>> = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "processBlock") blocks.push(node.attrs);
    });
    expect(blocks).toEqual([{ blobId: "blob_1a2b", command: "npm run dev" }]);
    expect(markdownOf(editor)).toBe(SOURCE.trimEnd());
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
  const spawn = vi.fn<SpawnProcess>(() => ({
    start: () => Promise.resolve(),
    onLine: (listener) => (lines.push(listener), () => {}),
    onClose: (listener) => (exits.push(listener), () => {}),
  }));

  async function mount() {
    lines.length = 0;
    exits.length = 0;
    spawn.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Harness, { processes: createProcessBlocks({ spawn }) }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const restart = () =>
    container!.querySelector<HTMLButtonElement>(
      'button[aria-label="processBlockRestart"]',
    );

  it("restarts the command once its stream is gone", async () => {
    await mount();

    // Read from the file: no stream yet, nothing runs until asked.
    expect(spawn).not.toHaveBeenCalled();
    await act(async () => restart()!.click());
    expect(spawn).toHaveBeenCalledWith({
      procId: "blob_1a2b",
      command: "npm run dev",
      cwd: "/ws",
    });
    expect(restart()).toBeNull();

    await act(async () => lines[0]("ready on :3000"));
    expect(container!.querySelector("pre")?.textContent).toBe("ready on :3000");

    await act(async () => exits[0]());
    await act(async () => restart()!.click());
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("shows the whole command, and restarts on 1 while the block is selected", async () => {
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
    expect(restart()!.textContent).toBe("1");
    await act(async () => void press("1"));
    expect(spawn).toHaveBeenCalledTimes(1);

    // Running: taken, so it neither stacks a process nor replaces the block.
    expect(press("1")).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(editor!.state.doc.textContent).not.toContain("1");
  });
});
