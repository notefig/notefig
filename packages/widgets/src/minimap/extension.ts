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
import type { EditorView } from "@tiptap/pm/view";

export interface WidgetMinimapOptions {
  sources: Record<string, MinimapSource>;
  /**
   * What a dot's jump does once its element is scrolled into view, given
   * the entry's id — the registry's `revealWidget`, so a minimap jump ends
   * where every other reveal does (a prompt: its composer, focused).
   */
  reveal?: (view: EditorView, id: string) => void;
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
