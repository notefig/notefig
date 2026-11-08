/**
 * The shared level in the editor: a ProseMirror plugin on a sync
 * workspace's open markdown editors only while someone else is here.
 * It draws the others' carets and reports this device's, on a timer that a
 * keystroke only arms, so nothing runs per keystroke.
 *
 * Units here are the merge's (`sync-merge.ts`): a paragraph or heading, a
 * list item's paragraphs, a table row, a code block. Empty paragraphs have
 * no unit in the markdown, so none here.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { EditorsApi } from "@/modules/editors";
import { path as pathutil } from "@/utils/path";
import { isShared, type SyncCursor, type SyncPeer, type SyncState } from "./sync-machine";

const CURSOR_THROTTLE_MS = 300;

export interface DocUnit {
  from: number;
  to: number;
}

/** The document's units in order. */
export function docUnits(doc: PMNode): DocUnit[] {
  const units: DocUnit[] = [];
  doc.descendants((node, pos) => {
    const whole = node.type.name === "tableRow" || node.type.spec.code === true;
    if (whole || node.isTextblock || (node.isAtom && node.isBlock)) {
      if (whole || !node.isTextblock || node.content.size > 0) units.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
  return units;
}

const caretsKey = new PluginKey<DecorationSet>("syncCarets");

function caret(peer: SyncPeer): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-caret";
  el.dataset.peer = peer.deviceId;
  el.title = peer.name;
  el.setAttribute("contenteditable", "false");
  el.style.cssText = `border-left:2px solid ${peer.color};margin-left:-1px;margin-right:-1px;pointer-events:auto;`;
  return el;
}

export function caretDecorations(doc: PMNode, path: string, peers: SyncPeer[]): DecorationSet {
  const here = peers.filter((peer) => peer.cursor?.path === path);
  if (here.length === 0) return DecorationSet.empty;
  const units = docUnits(doc);
  const decorations = here.flatMap((peer) => {
    const cursor = peer.cursor as SyncCursor;
    const unit = units[Math.min(cursor.unit, units.length - 1)];
    if (!unit) return [];
    const at = Math.min(unit.from + 1 + cursor.offset, unit.to - 1);
    return [Decoration.widget(at, () => caret(peer), { key: `${peer.deviceId}:${peer.name}`, side: 1, ignoreSelection: true })];
  });
  return DecorationSet.create(doc, decorations);
}

function createCaretPlugin(path: string, report: (view: EditorView) => void, setTimer: SetTimer) {
  return new Plugin<DecorationSet>({
    key: caretsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, value) {
        const peers = tr.getMeta(caretsKey) as SyncPeer[] | undefined;
        if (peers) return caretDecorations(tr.doc, path, peers);
        return tr.docChanged ? value.map(tr.mapping, tr.doc) : value;
      },
    },
    props: { decorations: (state) => caretsKey.getState(state) },
    view() {
      let cancel: (() => void) | null = null;
      return {
        update(view, previous) {
          if (cancel || (view.state.selection.eq(previous.selection) && view.state.doc === previous.doc)) return;
          cancel = setTimer(() => {
            cancel = null;
            if (view.hasFocus()) report(view);
          }, CURSOR_THROTTLE_MS);
        },
        destroy: () => cancel?.(),
      };
    },
  });
}

type SetTimer = (run: () => void, ms: number) => () => void;

interface Attached {
  editor: Editor;
  shown: string;
}

/** Keeps the plugin on the right editors, as the engine's poll sees them. */
export function createSyncEditors(deps: {
  root: string;
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  onCursor(cursor: SyncCursor | null): void;
  setTimer: SetTimer;
}) {
  const attached = new Map<string, Attached>();
  const relative = (path: string) => pathutil.relative(deps.root, path) ?? "";
  const treePath = (path: string) => pathutil.toTreePath(relative(path));

  const detach = (path: string) => {
    const entry = attached.get(path);
    attached.delete(path);
    if (entry && !entry.editor.isDestroyed) entry.editor.unregisterPlugin(caretsKey);
  };

  const report = (path: string, view: EditorView) => {
    const units = docUnits(view.state.doc);
    const head = view.state.selection.head;
    const unit = units.findIndex((candidate) => head >= candidate.from && head <= candidate.to);
    deps.onCursor({ path: treePath(path), unit: Math.max(unit, 0), offset: unit < 0 ? 0 : head - units[unit].from - 1 });
  };

  const inWorkspace = (path: string) => relative(path) !== "" && !relative(path).startsWith("..");

  return {
    /** Attach where wanted, detach where not, and redraw what changed. */
    reconcile(state: SyncState) {
      const wanted = new Map<string, Editor>();
      if (isShared(state)) {
        for (const path of deps.editors.paths()) {
          const editor = deps.editors.markdownEditor(path);
          if (editor && !editor.isDestroyed && inWorkspace(path)) wanted.set(path, editor);
        }
      }
      for (const [path, entry] of [...attached]) if (wanted.get(path) !== entry.editor) detach(path);
      const peers = JSON.stringify(state.peers);
      for (const [path, editor] of wanted) {
        if (!attached.has(path)) {
          editor.registerPlugin(createCaretPlugin(treePath(path), (view) => report(path, view), deps.setTimer));
          attached.set(path, { editor, shown: "[]" });
        }
        const entry = attached.get(path) as Attached;
        if (entry.shown === peers) continue;
        entry.shown = peers;
        editor.view.dispatch(editor.state.tr.setMeta(caretsKey, state.peers).setMeta("addToHistory", false));
      }
    },
    stop() {
      for (const path of [...attached.keys()]) detach(path);
    },
  };
}
