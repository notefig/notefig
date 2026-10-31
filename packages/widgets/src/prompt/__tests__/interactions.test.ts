import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { restoreKeptWidgetsTr } from "../interactions";
import { PROMPT_NODE_NAME } from "../node";
import type { PromptWidgetsApi } from "../widgets-service";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    promptDraft: { content: "text*" },
    [PROMPT_NODE_NAME]: { group: "block", content: "promptDraft", attrs: { blobId: { default: null }, summoned: { default: false } } },
    text: {},
  },
});

/** Every widget's turn is running: none may be removed. */
const running = { get: () => ({ state: { name: "working", turn: "running" } }) } as unknown as PromptWidgetsApi;

const { paragraph, promptDraft } = schema.nodes;
const widget = schema.nodes[PROMPT_NODE_NAME].create({ blobId: "blob_1" }, promptDraft.create(null, schema.text("draft")));
const state = EditorState.create({
  doc: schema.nodes.doc.create(null, [
    paragraph.create(null, schema.text("before")),
    widget,
    paragraph.create(null, schema.text("after")),
  ]),
});
const widgetPos = state.doc.firstChild!.nodeSize;

const restore = (tr: ReturnType<EditorState["tr"]["delete"]>) =>
  restoreKeptWidgetsTr([tr], state, state.apply(tr), running);

describe("restoreKeptWidgetsTr", () => {
  it("leaves typing alone, in the text and in a draft", () => {
    expect(restore(state.tr.insertText("x", 3))).toBeNull();
    expect(restore(state.tr.delete(2, 3))).toBeNull();
    expect(restore(state.tr.delete(widgetPos + 3, widgetPos + 4))).toBeNull();
  });

  it("puts back a widget a range delete took", () => {
    const tr = state.tr.delete(2, state.doc.content.size - 2);
    const restored = restore(tr);
    expect(restored).not.toBeNull();
    let widgets = 0;
    restored!.doc.descendants((node) => {
      if (node.type.name === PROMPT_NODE_NAME) widgets++;
    });
    expect(widgets).toBe(1);
  });

  it("puts back a widget deleted on its own", () => {
    expect(restore(state.tr.delete(widgetPos, widgetPos + widget.nodeSize))).not.toBeNull();
  });
});
