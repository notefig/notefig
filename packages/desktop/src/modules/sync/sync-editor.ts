/**
 * The shared level in the editor (MET-272): while someone else syncs the
 * branch, each of the workspace's open markdown editors carries a plugin
 * that draws the others' carets and reports this device's. Solo, none
 * does. A caret move only arms a timer, so nothing runs per keystroke.
 *
 * A caret is a unit of the document and a character in it (`SyncCursor`),
 * so it lands in the same paragraph on a device whose text above differs.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { EditorsApi } from "@/modules/editors";
import { isShared, type SyncCursor, type SyncPeer, type SyncState } from "./sync-machine";

const REPORT_MS = 300;
const carets = new PluginKey<DecorationSet>("syncCarets");

type SetTimer = (run: () => void, ms: number) => () => void;

interface Unit {
  from: number;
  to: number;
}

/** The document's units in order: each textblock with text, a table row
 *  or code block whole, a block atom. Empty paragraphs aren't in the
 *  markdown, so they aren't units. */
export function docUnits(doc: PMNode): Unit[] {
  const units: Unit[] = [];
  doc.descendants((node, pos) => {
    const whole = node.type.name === "tableRow" || node.type.spec.code === true;
    if (!whole && !node.isTextblock && !(node.isAtom && node.isBlock)) return true;
    if (whole || !node.isTextblock || node.content.size > 0) units.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  return units;
}

/** Where the selection's head is, as a unit and a character in it. */
export function cursorAt(doc: PMNode, head: number): Omit<SyncCursor, "path"> {
  const units = docUnits(doc);
  const found = units.findIndex(({ to }) => head <= to);
  const unit = found < 0 ? Math.max(units.length - 1, 0) : found;
  return { unit, offset: Math.max(0, head - (units[unit]?.from ?? 0) - 1) };
}

function caret(peer: SyncPeer): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-caret";
  el.dataset.syncPeer = peer.deviceId;
  if (peer.name) el.title = peer.name;
  el.style.cssText = `border-left:2px solid ${peer.colour};margin:0 -1px;`;
  return el;
}

/** The carets of the peers in `path`. */
export function caretDecorations(doc: PMNode, path: string, peers: SyncPeer[]): DecorationSet {
  const here = peers.filter((peer) => peer.cursor?.path === path);
  if (here.length === 0) return DecorationSet.empty;
  const units = docUnits(doc);
  return DecorationSet.create(
    doc,
    here.flatMap((peer) => {
      const { unit: index, offset } = peer.cursor!;
      const unit = units[Math.min(index, units.length - 1)];
      if (!unit) return [];
      const at = Math.max(unit.from, Math.min(unit.from + 1 + offset, unit.to - 1));
      return [Decoration.widget(at, () => caret(peer), { key: `${peer.deviceId}:${peer.name}:${peer.colour}`, side: 1 })];
    }),
  );
}

function caretPlugin(path: string, report: (view: EditorView) => void, setTimer: SetTimer) {
  return new Plugin<DecorationSet>({
    key: carets,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        const peers = tr.getMeta(carets) as SyncPeer[] | undefined;
        return peers ? caretDecorations(tr.doc, path, peers) : value.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => carets.getState(state) },
    view(view) {
      let cancel: (() => void) | null = null;
      const arm = () => {
        cancel ??= setTimer(() => {
          cancel = null;
          if (view.hasFocus()) report(view);
        }, REPORT_MS);
      };
      // Someone just came: show them where this device is.
      arm();
      return {
        update(_, previous) {
          if (!view.state.selection.eq(previous.selection) || view.state.doc !== previous.doc) arm();
        },
        destroy: () => cancel?.(),
      };
    },
  });
}

export interface SyncEditors {
  /** Put the plugin on the workspace's editors while shared, take it off
   *  solo, and redraw the others' carets. */
  reconcile(state: SyncState): void;
  stop(): void;
}

export function createSyncEditors(deps: {
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  /** A file's `/`-separated path in the workspace; null outside it. */
  tree(path: string): string | null;
  onCursor(cursor: SyncCursor): void;
  setTimer: SetTimer;
}): SyncEditors {
  const attached = new Map<string, { editor: Editor; shown: string }>();

  const detach = (path: string) => {
    const editor = attached.get(path)?.editor;
    attached.delete(path);
    if (editor && !editor.isDestroyed) editor.unregisterPlugin(carets);
  };

  return {
    reconcile(state) {
      if (!isShared(state) && attached.size === 0) return;
      const wanted = new Map<string, Editor>();
      for (const file of isShared(state) ? deps.editors.paths() : []) {
        const editor = deps.editors.markdownEditor(file);
        const path = deps.tree(file);
        if (editor && !editor.isDestroyed && path) wanted.set(path, editor);
      }
      for (const [path, { editor }] of [...attached]) if (wanted.get(path) !== editor) detach(path);
      const peers = JSON.stringify(state.peers);
      for (const [path, editor] of wanted) {
        let entry = attached.get(path);
        if (!entry) {
          const report = (view: EditorView) => deps.onCursor({ path, ...cursorAt(view.state.doc, view.state.selection.head) });
          editor.registerPlugin(caretPlugin(path, report, deps.setTimer));
          attached.set(path, (entry = { editor, shown: "" }));
        }
        if (entry.shown === peers) continue;
        entry.shown = peers;
        editor.view.dispatch(editor.state.tr.setMeta(carets, state.peers).setMeta("addToHistory", false));
      }
    },
    stop() {
      for (const path of [...attached.keys()]) detach(path);
    },
  };
}
