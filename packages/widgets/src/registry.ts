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
 * The document minimap, configured with every widget that declared a
 * `minimap` slot. The rail mounts itself inside the editor (plugin view),
 * so adding this to an editor's extensions is the whole installation.
 * `reveal` is the host's jump to an entry by id (see WidgetMinimapOptions).
 */
export function widgetMinimapExtension(
  options: { reveal?: (id: string) => void } = {},
) {
  const sources: Record<string, MinimapSource> = {};
  for (const widget of editorWidgets) {
    if (widget.minimap) sources[widget.name] = widget.minimap;
  }
  return WidgetMinimapExtension.configure({ sources, reveal: options.reveal });
}
