/**
 * Tiptap's React node view, for a face that never reads the `selected`
 * prop. Tiptap re-renders a node view whenever a selection starts or stops
 * covering it, to hand it `selected`; every such render is a React commit,
 * and React walks the whole editor's DOM before each commit (to save the
 * focused contenteditable's selection). Select-all over a long document
 * would commit once per node view, and the caret move after it once more.
 * Here selecting a node view only toggles `ProseMirror-selectednode` on its
 * DOM, as ProseMirror's own node views do.
 */
import {
  ReactNodeView,
  type ReactNodeViewProps,
  type ReactNodeViewRendererOptions,
} from "@tiptap/react";
import type { NodeViewRenderer } from "@tiptap/core";
import type { ComponentType } from "react";

class UnselectedReactNodeView extends ReactNodeView {
  override selectNode(): void {
    this.renderer.props.selected = true;
    this.renderer.element.classList.add("ProseMirror-selectednode");
  }

  override deselectNode(): void {
    this.renderer.props.selected = false;
    this.renderer.element.classList.remove("ProseMirror-selectednode");
  }
}

/** `ReactNodeViewRenderer`, minus the render on selection. Like it, no
 *  node view in an editor without `EditorContent` to render it. */
export function reactNodeView(
  component: ComponentType<ReactNodeViewProps>,
  options?: Partial<ReactNodeViewRendererOptions>,
): NodeViewRenderer {
  return (props) =>
    (props.editor as { contentComponent?: unknown }).contentComponent
      ? new UnselectedReactNodeView(component, props, options)
      : ({} as ReturnType<NodeViewRenderer>);
}
