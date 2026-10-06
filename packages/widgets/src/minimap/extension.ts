/**
 * The minimap as a Tiptap extension: registering it IS the installation —
 * the rail's UI is a ProseMirror plugin view, mounted inside the editor's
 * own scroll container (see rail-view.ts). The extension is generic over
 * its sources: which elements appear, and what their dots say, is declared
 * by the elements (widget definitions' `minimap` slot), collected by the
 * package registry, and never known here.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { MinimapRailView } from "./rail-view";
import type { MinimapSource } from "./contract";

export interface WidgetMinimapOptions {
  sources: Record<string, MinimapSource>;
  /**
   * How a dot's click reveals its element, given the entry's id — the
   * host's reveal, so a minimap jump lands where every other jump does
   * (a prompt widget: its composer, focused). Without one, or for an
   * entry with no id, the rail scrolls the element into view itself.
   */
  reveal?: (id: string) => void;
}

const minimapPluginKey = new PluginKey("widgetMinimap");

export const WidgetMinimapExtension = Extension.create<WidgetMinimapOptions>({
  name: "widgetMinimap",

  addOptions() {
    return { sources: {}, reveal: undefined };
  },

  addProseMirrorPlugins() {
    const { sources, reveal } = this.options;
    if (Object.keys(sources).length === 0) return [];
    return [
      new Plugin({
        key: minimapPluginKey,
        view: (editorView) => {
          const rail = new MinimapRailView(editorView, sources, reveal);
          return { update: () => rail.update(), destroy: () => rail.destroy() };
        },
      }),
    ];
  },
});
