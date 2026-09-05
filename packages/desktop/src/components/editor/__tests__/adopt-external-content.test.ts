/**
 * Differential adoption (MET-174): external content enters the editor as a
 * minimal transaction, and prompt widgets survive rewrites that drop their
 * markers — the invariant the e2e repro (widget-agent-rewrite.spec.ts)
 * exercises through the real agent transport, asserted here at the helper
 * level against the app's real editor kit.
 *
 * Coverage tiers: the diff/re-assertion basics, then the design's real
 * promises (drafts, caret mapping, both fallback modes), then position and
 * edge fidelity for the re-insertion path.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes } from "@notefig/widgets";
import { adoptExternalContent } from "@/components/editor/adopt-external-content";

const WIDGET_HTML = (blobId: string | null, draft = "") => {
  const attrs = blobId
    ? ` data-blob-id="${blobId}" data-task-id="task_${blobId}"`
    : "";
  const child = draft ? `<div data-type="prompt-draft">${draft}</div>` : "";
  return `<div data-type="ai-prompt"${attrs}>${child}</div>`;
};

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
    ],
    content,
  });
}

/** Parse HTML through the same kit and hand back JSONContent, the shape
 *  prepareAdoption delivers. */
function docJSON(content: string): JSONContent {
  const scratch = makeEditor(content);
  const json = scratch.state.doc.toJSON() as JSONContent;
  scratch.destroy();
  return json;
}

type FoundWidget = {
  pos: number;
  /** Index among the document's top-level children (-1 when nested). */
  topIndex: number;
  attrs: Record<string, unknown>;
  draftText: string;
};

function findWidgets(editor: Editor): FoundWidget[] {
  const doc = editor.state.doc;
  const found: FoundWidget[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "aiPrompt") return true;
    const $pos = doc.resolve(pos);
    found.push({
      pos,
      topIndex: $pos.depth === 0 ? $pos.index(0) : -1,
      attrs: node.attrs,
      draftText: node.firstChild?.textContent ?? "",
    });
    return false;
  });
  return found;
}

/** Position just inside the first text node containing `needle`. */
function posOfText(editor: Editor, needle: string): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isText && node.text?.includes(needle)) {
      at = pos + (node.text.indexOf(needle) ?? 0) + 1;
      return false;
    }
    return true;
  });
  if (at < 0) throw new Error(`text "${needle}" not found`);
  return at;
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("adoptExternalContent — diffing basics", () => {
  it("adopts changed text as a diff, not a replace", () => {
    editor = makeEditor("<p>para one</p><p>para two</p><p>para three</p>");
    const result = adoptExternalContent(
      editor,
      docJSON("<p>para one</p><p>para 2</p><p>para three</p>"),
    );
    expect(result.mode).toBe("diffed");
    expect(result.reinsertedWidgets).toBe(0);
    expect(editor.state.doc.textContent).toContain("para 2");
    expect(editor.state.doc.textContent).not.toContain("para two");
  });

  it("re-asserts a bound widget whose marker the rewrite dropped", () => {
    editor = makeEditor(
      `<p>para one</p>${WIDGET_HTML("blob_x")}<p>para two</p>`,
    );
    expect(findWidgets(editor)).toHaveLength(1);
    const result = adoptExternalContent(
      editor,
      docJSON("<h1>Rewritten</h1><p>totally new body</p>"),
    );
    expect(result.mode).toBe("diffed");
    expect(result.reinsertedWidgets).toBe(1);
    expect(findWidgets(editor)).toHaveLength(1);
    expect(editor.state.doc.textContent).toContain("totally new body");
  });

  it("keeps a widget whose marker the incoming content preserved, without re-assertion", () => {
    editor = makeEditor(
      `<p>para one</p>${WIDGET_HTML("blob_kept")}<p>para two</p>`,
    );
    const result = adoptExternalContent(
      editor,
      docJSON(`<p>para 1</p>${WIDGET_HTML("blob_kept")}<p>para two</p>`),
    );
    expect(result.reinsertedWidgets).toBe(0);
    expect(findWidgets(editor)).toHaveLength(1);
    expect(editor.state.doc.textContent).toContain("para 1");
  });

  it("re-asserts an unbound (never-sent) widget across any adoption", () => {
    editor = makeEditor(`<p>para one</p>${WIDGET_HTML(null)}<p>para two</p>`);
    const result = adoptExternalContent(
      editor,
      docJSON("<p>para one</p><p>para two, edited elsewhere</p>"),
    );
    expect(result.reinsertedWidgets).toBe(1);
    expect(findWidgets(editor)).toHaveLength(1);
  });

  it("survives multiple widgets in one rewrite", () => {
    editor = makeEditor(
      `${WIDGET_HTML("blob_a")}<p>middle</p>${WIDGET_HTML("blob_b")}`,
    );
    const result = adoptExternalContent(editor, docJSON("<p>wiped</p>"));
    expect(result.reinsertedWidgets).toBe(2);
    expect(findWidgets(editor)).toHaveLength(2);
  });
});

describe("adoptExternalContent — drafts, caret, fallbacks", () => {
  it("carries a typed draft when the incoming content keeps the marker", () => {
    editor = makeEditor(
      `<p>intro</p>${WIDGET_HTML("blob_d", "half typed prompt")}<p>outro</p>`,
    );
    const result = adoptExternalContent(
      editor,
      // The marker parses to a widget with an EMPTY draft — the file never
      // holds draft text; carryDraftsForward must re-seat it.
      docJSON(`<p>intro, edited</p>${WIDGET_HTML("blob_d")}<p>outro</p>`),
    );
    expect(result.mode).toBe("diffed");
    const [widget] = findWidgets(editor);
    expect(widget.draftText).toBe("half typed prompt");
    expect(editor.state.doc.textContent).toContain("intro, edited");
  });

  it("re-asserts a dropped widget with its typed draft intact", () => {
    editor = makeEditor(
      `<p>intro</p>${WIDGET_HTML("blob_d2", "do not lose me")}<p>outro</p>`,
    );
    const result = adoptExternalContent(
      editor,
      docJSON("<h1>Sweeping rewrite</h1><p>no markers anywhere</p>"),
    );
    expect(result.reinsertedWidgets).toBe(1);
    const [widget] = findWidgets(editor);
    expect(widget.draftText).toBe("do not lose me");
  });

  it("keeps the caret on the same word when the edit lands elsewhere", () => {
    editor = makeEditor("<p>alpha</p><p>bravo</p><p>charlie delta</p>");
    editor.commands.setTextSelection(posOfText(editor, "delta"));
    const result = adoptExternalContent(
      editor,
      docJSON(
        "<p>alpha grew considerably longer</p><p>bravo</p><p>charlie delta</p>",
      ),
    );
    expect(result.mode).toBe("diffed");
    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe("charlie delta");
    expect(editor.state.doc.textContent).toContain("grew considerably");
  });

  it("falls back to replace for content the schema rejects, without throwing", () => {
    editor = makeEditor("<p>stable</p>");
    // promptDraft is only admitted inside a widget; a top-level one parses
    // via nodeFromJSON but fails check() — the diff must not be attempted.
    const invalid: JSONContent = {
      type: "doc",
      content: [{ type: "promptDraft" }],
    };
    const result = adoptExternalContent(editor, invalid);
    expect(result.mode).toBe("replaced");
  });

  it("re-asserts dropped widgets in the oversized-document fallback", () => {
    editor = makeEditor(
      `<p>aa</p>${WIDGET_HTML("blob_fb", "fallback draft")}<p>cc</p>`,
    );
    let target = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "fallback draft") target = pos + 8;
      return true;
    });
    editor.commands.setTextSelection(target);
    const result = adoptExternalContent(
      editor,
      docJSON("<h1>No markers</h1><p>rewritten</p>"),
      { maxDiffNodeSize: 1 },
    );
    expect(result.mode).toBe("replaced");
    expect(result.reinsertedWidgets).toBe(1);
    const [widget] = findWidgets(editor);
    expect(widget.draftText).toBe("fallback draft");
    expect(widget.attrs.blobId).toBe("blob_fb");
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe("promptDraft");
    expect($from.parentOffset).toBe(8);
  });

  it("carries drafts through the oversized-document fallback", () => {
    editor = makeEditor(
      `<p>intro</p>${WIDGET_HTML("blob_big", "survives the fallback")}`,
    );
    const result = adoptExternalContent(
      editor,
      docJSON(`<p>intro, edited</p>${WIDGET_HTML("blob_big")}`),
      { maxDiffNodeSize: 1 },
    );
    expect(result.mode).toBe("replaced");
    const [widget] = findWidgets(editor);
    expect(widget.draftText).toBe("survives the fallback");
    expect(editor.state.doc.textContent).toContain("intro, edited");
  });
});

describe("adoptExternalContent — caret in a draft", () => {
  /** Caret after "typing " inside the widget's draft. */
  function setDraftCaret(ed: Editor): void {
    let target = -1;
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "typing here") target = pos + 7;
      return true;
    });
    ed.commands.setTextSelection(target);
  }
  function caretParent(ed: Editor): { parent: string; offset: number } {
    const { $from } = ed.state.selection;
    return { parent: $from.parent.type.name, offset: $from.parentOffset };
  }

  it("stays in the draft when the rewrite keeps the marker", () => {
    editor = makeEditor(
      `<p>aa</p>${WIDGET_HTML("blob_k", "typing here")}<p>cc</p>`,
    );
    setDraftCaret(editor);
    adoptExternalContent(
      editor,
      docJSON(`<p>rewritten above</p>${WIDGET_HTML("blob_k")}<p>rewritten below</p>`),
    );
    expect(caretParent(editor)).toEqual({ parent: "promptDraft", offset: 7 });
  });

  it("stays in the draft when the rewrite drops the marker (re-assertion)", () => {
    editor = makeEditor(
      `<p>aa</p>${WIDGET_HTML("blob_r", "typing here")}<p>cc</p>`,
    );
    setDraftCaret(editor);
    const result = adoptExternalContent(
      editor,
      docJSON("<h1>All new</h1><p>no markers</p>"),
    );
    expect(result.reinsertedWidgets).toBe(1);
    expect(caretParent(editor)).toEqual({ parent: "promptDraft", offset: 7 });
  });

  it("stays in an unbound widget's draft through a rewrite", () => {
    editor = makeEditor(
      `<p>aa</p>${WIDGET_HTML(null, "typing here")}<p>cc</p>`,
    );
    setDraftCaret(editor);
    adoptExternalContent(editor, docJSON("<p>aa</p><p>cc, edited</p>"));
    expect(caretParent(editor)).toEqual({ parent: "promptDraft", offset: 7 });
  });

  it("preserves a caret at a line boundary in the draft, on either side of the break", () => {
    // The "index 0 of line 2" position: before-br (end of line 1) and
    // after-br (start of line 2) are distinct positions one apart, and a
    // re-assertion must put the caret back on the same side of the break.
    for (const side of ["before", "after"] as const) {
      const ed = makeEditor(
        `<p>aa</p>${WIDGET_HTML("blob_br", "line one<br>line two")}<p>cc</p>`,
      );
      let breakPos = -1;
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name === "hardBreak") breakPos = pos;
        return true;
      });
      ed.commands.setTextSelection(side === "before" ? breakPos : breakPos + 1);
      const result = adoptExternalContent(ed, docJSON("<p>all rewritten</p>"));
      expect(result.reinsertedWidgets).toBe(1);
      const { $from } = ed.state.selection;
      expect($from.parent.type.name).toBe("promptDraft");
      expect($from.parentOffset).toBe(side === "before" ? 8 : 9);
      expect(
        (side === "before" ? $from.nodeAfter : $from.nodeBefore)?.type.name,
      ).toBe("hardBreak");
      ed.destroy();
    }
  });

  it("clamps the caret when the carried draft is shorter than the offset", () => {
    // Offset beyond the re-seated draft cannot resolve outside it.
    editor = makeEditor(`<p>aa</p>${WIDGET_HTML("blob_c2", "hi")}<p>cc</p>`);
    editor.commands.setTextSelection(
      ((): number => {
        let t = -1;
        editor!.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === "hi") t = pos + 2;
          return true;
        });
        return t;
      })(),
    );
    const result = adoptExternalContent(editor, docJSON("<p>wiped</p>"));
    expect(result.reinsertedWidgets).toBe(1);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe("promptDraft");
  });
});

describe("adoptExternalContent — re-insertion fidelity", () => {
  it("re-inserts at the mapped position: still between its old neighbors", () => {
    editor = makeEditor(
      `<p>section a</p><p>section b</p>${WIDGET_HTML("blob_p")}<p>section c</p>`,
    );
    adoptExternalContent(
      editor,
      docJSON(
        "<p>section a</p><p>inserted one</p><p>inserted two</p><p>section b</p><p>section c</p>",
      ),
    );
    const [widget] = findWidgets(editor);
    const doc = editor.state.doc;
    const topTexts: string[] = [];
    doc.forEach((node) => topTexts.push(node.type.name === "aiPrompt" ? "@" : node.textContent));
    expect(widget.topIndex).toBeGreaterThan(topTexts.indexOf("section b"));
    expect(widget.topIndex).toBeLessThan(topTexts.indexOf("section c"));
  });

  it("keeps a document-leading widget at the top", () => {
    editor = makeEditor(`${WIDGET_HTML("blob_s")}<p>one</p><p>two</p>`);
    adoptExternalContent(editor, docJSON("<p>fully</p><p>rewritten</p>"));
    const [widget] = findWidgets(editor);
    expect(widget.topIndex).toBe(0);
  });

  it("clamps a document-trailing widget into a shrunken document", () => {
    editor = makeEditor(
      `<p>one</p><p>two</p><p>three</p>${WIDGET_HTML("blob_e")}`,
    );
    adoptExternalContent(editor, docJSON("<p>tiny</p>"));
    // Every old neighbor preceded the widget; in the shrunken doc it must
    // still follow the surviving content (exact index is the diff's shape —
    // the engine may leave a trailing empty paragraph after it).
    const [widget] = findWidgets(editor);
    const texts: string[] = [];
    editor.state.doc.forEach((node) => texts.push(node.textContent));
    expect(widget.topIndex).toBeGreaterThan(texts.indexOf("tiny"));
  });

  it("survives a rewrite to an empty document", () => {
    editor = makeEditor(`<p>content</p>${WIDGET_HTML("blob_v")}`);
    const result = adoptExternalContent(editor, docJSON("<p></p>"));
    expect(result.reinsertedWidgets).toBe(1);
    expect(findWidgets(editor)).toHaveLength(1);
  });

  it("finds a valid insertion point when the mapped position lands in nested content", () => {
    editor = makeEditor(
      `<p>alpha</p>${WIDGET_HTML("blob_n")}<p>beta</p>`,
    );
    const result = adoptExternalContent(
      editor,
      docJSON("<blockquote><p>alpha</p><p>beta</p></blockquote>"),
    );
    expect(result.reinsertedWidgets).toBe(1);
    expect(findWidgets(editor)).toHaveLength(1);
  });

  it("re-asserted widgets keep their full binding (blobId AND taskId)", () => {
    editor = makeEditor(`<p>x</p>${WIDGET_HTML("blob_id9")}<p>y</p>`);
    adoptExternalContent(editor, docJSON("<p>gone</p>"));
    const [widget] = findWidgets(editor);
    expect(widget.attrs.blobId).toBe("blob_id9");
    expect(widget.attrs.taskId).toBe("task_blob_id9");
  });
});
