/**
 * Renderer side of the frontmatter node (schema base + markdown round-trip
 * live in editor-schema-kit.ts), MET-137.
 *
 * The node renders NOTHING in the document — frontmatter is completely
 * removed from the page and is only viewed/edited through the properties
 * popover anchored to the editor toolbar (frontmatter-popover.tsx). This
 * module owns the node extension (hidden view) and the yaml read/write
 * helpers the popover drives it with.
 *
 * Documents without frontmatter carry NO node: setFrontmatterYaml creates
 * it lazily on the first property commit. Deliberately not an on-create
 * keeper insert — an eager node at position 0 perturbs untouched documents
 * (it displaces the prompt widget as the first DOM block and its create-
 * time transaction can clobber restored scroll positions).
 */
import type { Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { FrontmatterNodeBase } from "./editor-schema-kit";

/** The document's frontmatter YAML, or null when the doc carries no
 * frontmatter node yet. Usable as a useEditorState selector body. */
export function getFrontmatterYaml(editor: Editor): string | null {
  const first = editor.state.doc.firstChild;
  return first?.type.name === FrontmatterNodeBase.name
    ? (first.attrs.yaml as string)
    : null;
}

/** Replace the frontmatter YAML, creating the node on first use — a normal
 * history transaction the autosave path picks up like typing. */
export function setFrontmatterYaml(editor: Editor, yaml: string): void {
  const { state } = editor;
  const first = state.doc.firstChild;
  if (first?.type.name === FrontmatterNodeBase.name) {
    editor.view.dispatch(state.tr.setNodeAttribute(0, "yaml", yaml));
    return;
  }
  const type = state.schema.nodes[FrontmatterNodeBase.name];
  if (!type) return;
  editor.view.dispatch(state.tr.insert(0, type.create({ yaml })));
}

function HiddenFrontmatterView() {
  return <NodeViewWrapper data-type="frontmatter" className="hidden" />;
}

export const FrontmatterNode = FrontmatterNodeBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(HiddenFrontmatterView);
  },
});
