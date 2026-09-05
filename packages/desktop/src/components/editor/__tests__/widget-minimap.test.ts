/**
 * The minimap's derivation (MET-172): widget dots come straight from the
 * live doc — order, proportional position, and the title chain (draft text
 * → last sent prompt → generic).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes, updatePromptBlob } from "@notefig/widgets";
import { deriveWidgetMapEntries } from "@/components/editor/widget-minimap";

const WIDGET_HTML = (blobId: string, draft = "") =>
  `<div data-type="ai-prompt" data-blob-id="${blobId}" data-task-id="task_${blobId}">${
    draft ? `<div data-type="prompt-draft">${draft}</div>` : ""
  }</div>`;

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
    ],
    content,
  });
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("deriveWidgetMapEntries", () => {
  it("maps widgets in document order with proportional, clamped ratios", () => {
    const paras = (n: number) =>
      Array.from({ length: n }, (_, i) => `<p>para ${i}</p>`).join("");
    editor = makeEditor(
      `${WIDGET_HTML("blob_top")}${paras(20)}${WIDGET_HTML("blob_mid")}${paras(20)}${WIDGET_HTML("blob_end")}`,
    );
    const entries = deriveWidgetMapEntries(editor.state.doc);
    expect(entries.map((e) => e.blobId)).toEqual([
      "blob_top",
      "blob_mid",
      "blob_end",
    ]);
    expect(entries[0].ratio).toBeGreaterThanOrEqual(0.01);
    expect(entries[2].ratio).toBeLessThanOrEqual(0.99);
    expect(entries[0].ratio).toBeLessThan(entries[1].ratio);
    expect(entries[1].ratio).toBeLessThan(entries[2].ratio);
    expect(entries[1].ratio).toBeGreaterThan(0.3);
    expect(entries[1].ratio).toBeLessThan(0.7);
  });

  it("titles from draft text, then last sent prompt, then a generic label", () => {
    updatePromptBlob("blob_sent", { lastSentPrompt: "summarize the doc" });
    editor = makeEditor(
      `${WIDGET_HTML("blob_draft", "half typed")}<p>x</p>${WIDGET_HTML("blob_sent")}<p>y</p>${WIDGET_HTML("blob_blank")}`,
    );
    const titles = deriveWidgetMapEntries(editor.state.doc).map((e) => e.title);
    expect(titles).toEqual(["half typed", "summarize the doc", "Prompt"]);
  });

  it("truncates long titles with an ellipsis", () => {
    const long = "word ".repeat(30).trim();
    editor = makeEditor(WIDGET_HTML("blob_l", long));
    const [entry] = deriveWidgetMapEntries(editor.state.doc);
    expect(entry.title.length).toBeLessThanOrEqual(49);
    expect(entry.title.endsWith("…")).toBe(true);
  });

  it("gives duplicated markers (same blobId) distinct keys", () => {
    // External edits can copy-paste a marker; parsing doesn't dedupe.
    editor = makeEditor(
      `${WIDGET_HTML("blob_dup")}<p>between</p>${WIDGET_HTML("blob_dup")}`,
    );
    const entries = deriveWidgetMapEntries(editor.state.doc);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
  });

  it("returns nothing for a widget-less document", () => {
    editor = makeEditor("<p>just prose</p>");
    expect(deriveWidgetMapEntries(editor.state.doc)).toEqual([]);
  });
});
