/**
 * Every widget this package ships, and the two collectors the host editor
 * consumes. An explicit array rather than a glob: unlike the blob types
 * (whose one-file protocol makes them genuinely open-ended), widgets are few
 * and their registration ORDER can influence schema construction, so it is
 * worth reading in one place.
 */
import type { EditorWidgetDefinition } from "./define-widget";
import { promptWidget } from "./prompt";

export const editorWidgets: EditorWidgetDefinition[] = [promptWidget];

/**
 * The worker-safe halves — schema + markdown spec only. This is what the
 * markdown conversion codec builds its schema from, and it must be
 * constructible without React, a live DOM, or a host.
 */
export function widgetSchemaNodes() {
  return editorWidgets.map((widget) => widget.base);
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
  return editorWidgets.map((widget) => widget.view.configure(options));
}
