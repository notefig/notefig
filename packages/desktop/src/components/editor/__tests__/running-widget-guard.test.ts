/**
 * A prompt widget whose task is busy cannot be removed by an edit (MET-248);
 * once the task settles it is ordinary content, and adoption — which
 * re-asserts widgets itself — is never refused.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes } from "@notefig/widgets";
import { adoptExternalContent } from "@/components/editor/adopt-external-content";
import { runningWidgetGuard } from "@/components/editor/running-widget-guard";

const WIDGET = `<div data-type="ai-prompt" data-blob-id="b1" data-task-id="task_1"></div>`;
const DOC = `<p>before</p>${WIDGET}<p>after</p>`;

const busy = new Set<string>();
let editor: Editor | null = null;

afterEach(() => {
  busy.clear();
  editor?.destroy();
  editor = null;
});

function makeEditor(): Editor {
  editor = new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
      runningWidgetGuard((taskId) => busy.has(taskId)),
    ],
    content: DOC,
  });
  return editor;
}

function widgetCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") count++;
  });
  return count;
}

function deleteWidget(editor: Editor): void {
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "aiPrompt") return true;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    return false;
  });
}

describe("runningWidgetGuard", () => {
  it("refuses an edit that removes a busy task's widget", () => {
    busy.add("task_1");
    const editor = makeEditor();
    deleteWidget(editor);
    expect(widgetCount(editor)).toBe(1);
    expect(editor.state.doc.textContent).toContain("before");
  });

  it("allows edits that keep the widget", () => {
    busy.add("task_1");
    const editor = makeEditor();
    editor.commands.insertContentAt(1, "x");
    expect(editor.state.doc.textContent).toContain("xbefore");
  });

  it("lets the widget go once its task is no longer busy", () => {
    const editor = makeEditor();
    deleteWidget(editor);
    expect(widgetCount(editor)).toBe(0);
  });

  it("lets adoption through, which re-asserts the widget itself", () => {
    busy.add("task_1");
    const editor = makeEditor();
    const incoming = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "rewritten" }] },
      ],
    };
    for (const maxDiffNodeSize of [Infinity, 0]) {
      const result = adoptExternalContent(editor, incoming, {
        maxDiffNodeSize,
      });
      expect(result.reinsertedWidgets).toBe(1);
      expect(editor.state.doc.textContent).toContain("rewritten");
      expect(widgetCount(editor)).toBe(1);
    }
  });

  it("restores a busy widget into a cleared file without adding a composer", () => {
    busy.add("task_1");
    for (const maxDiffNodeSize of [Infinity, 0]) {
      const editor = makeEditor();
      adoptExternalContent(
        editor,
        { type: "doc", content: [{ type: "paragraph" }] },
        { maxDiffNodeSize },
      );
      expect(widgetCount(editor)).toBe(1);
      editor.destroy();
    }
  });
});
