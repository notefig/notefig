/**
 * Every widget this package ships, and the two collectors the host editor
 * consumes. An explicit array rather than a glob: unlike the blob types
 * (whose one-file protocol makes them genuinely open-ended), widgets are few
 * and their registration ORDER can influence schema construction, so it is
 * worth reading in one place.
 */
import type { EditorWidgetDefinition } from "./define-widget";
import { promptWidget } from "./prompt";
import { WidgetMinimapExtension } from "./minimap/extension";
import type { MinimapSource } from "./minimap/contract";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export const editorWidgets: EditorWidgetDefinition[] = [promptWidget];

/**
 * The worker-safe halves — schema + markdown spec only. This is what the
 * markdown conversion codec builds its schema from, and it must be
 * constructible without React, a live DOM, or a host.
 */
export function widgetSchemaNodes() {
  return editorWidgets.flatMap((widget) => [
    ...(widget.support?.bases ?? []),
    widget.base,
  ]);
}

/**
 * The renderer halves, scoped to one document. Every widget takes the same
 * two facts — which file it sits in and which workspace that file belongs to
 * — and nothing else; anything further reaches the app through the host,
 * from React context inside the node view.
 */
export function widgetRendererNodes(options: {
  filePath: string;
  basePath: string;
}) {
  return editorWidgets.flatMap((widget) => [
    ...(widget.support?.views(options) ?? []),
    widget.view.configure(options),
  ]);
}

/**
 * Finish revealing the widget instance at `pos`, already in view: run its
 * widget's `reveal` slot (the prompt focuses its composer). Every way to
 * reveal a widget ends here — the host's go-to-location and the minimap —
 * so what revealing means is declared once, by the widget. False when no
 * widget sits there or it has nothing more to do.
 */
export function revealWidget(view: EditorView, pos: number): boolean {
  const name = view.state.doc.nodeAt(pos)?.type.name;
  const widget = editorWidgets.find((candidate) => candidate.name === name);
  return widget?.reveal?.(view, pos) ?? false;
}

/** The position of the first widget instance carrying `id` (its `blobId`
 *  attribute — what `data-blob-id` and a go-to-location target name). */
export function findWidgetPos(doc: PMNode, id: string): number | null {
  const names = new Set(editorWidgets.map((widget) => widget.name));
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (names.has(node.type.name) && node.attrs.blobId === id) found = pos;
    return found === null;
  });
  return found;
}

/**
 * The document minimap, configured with every widget that declared a
 * `minimap` slot. The rail mounts itself inside the editor (plugin view),
 * so adding this to an editor's extensions is the whole installation. A
 * dot's jump ends in `revealWidget`, like every other reveal.
 */
export function widgetMinimapExtension() {
  const sources: Record<string, MinimapSource> = {};
  for (const widget of editorWidgets) {
    if (widget.minimap) sources[widget.name] = widget.minimap;
  }
  return WidgetMinimapExtension.configure({ sources, reveal: revealWidget });
}
