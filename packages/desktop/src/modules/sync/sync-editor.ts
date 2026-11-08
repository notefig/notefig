/**
 * The shared level in the editor: a ProseMirror plugin on a sync
 * workspace's open markdown editors only while someone else is here.
 * It draws the others' carets and reports this device's, on a timer that a
 * keystroke only arms, so nothing runs per keystroke; a second plugin shows
 * what others hold (`sync-claims.ts`): a faint edge and initial, their
 * text in place of the unit's while they work on it, and held units
 * read-only. The doc is only looked at when a claim changes or a poll
 * finds it changed.
 *
 * Units here are the merge's (`sync-merge.ts`): a paragraph or heading, a
 * list item's paragraphs, a table row, a code block. Empty paragraphs have
 * no unit in the markdown, so none here.
 */
import type { Editor } from "@tiptap/core";
import MarkdownIt from "markdown-it";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ADOPTION_TRANSACTION_META } from "@/components/editor/adopt-external-content";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import type { EditorsApi } from "@/modules/editors";
import { path as pathutil } from "@/utils/path";
import { isShared, type SyncCursor, type SyncPeer, type SyncState } from "./sync-machine";
import { unitHunks, unitKeys, unitTexts, type PeerHold } from "./sync-claims";

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

// --- What others hold ------------------------------------------------------

interface HeldRange extends DocUnit {
  peer: SyncPeer;
}

interface HoldState {
  set: DecorationSet;
  ranges: HeldRange[];
}

const holdsKey = new PluginKey<HoldState>("syncHolds");
const EMPTY_HOLDS: HoldState = { set: DecorationSet.empty, ranges: [] };
const overlayMarkdown = new MarkdownIt({ html: false });

function overlay(text: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "sync-overlay";
  el.setAttribute("contenteditable", "false");
  el.style.setProperty("--sync-color", color);
  el.innerHTML = overlayMarkdown.render(text);
  return el;
}

/** The units `hold`'s device changed, shown as its text in place. */
function overlayDecorations(units: DocUnit[], texts: string[], keys: string[], hold: PeerHold): Decoration[] {
  if (hold.text === null) return [];
  return unitHunks(texts, unitTexts(hold.text))
    .filter((hunk) => keys.slice(hunk.from, hunk.from + hunk.removed).every((key) => hold.keys.has(key)))
    .flatMap((hunk) => {
      const out: Decoration[] = units
        .slice(hunk.from, hunk.from + hunk.removed)
        .map((unit) => Decoration.node(unit.from, unit.to, { class: "sync-overlaid" }));
      if (hunk.added.length === 0) return out;
      const pos = units[hunk.from]?.from ?? units[units.length - 1]?.to ?? 0;
      const body = hunk.added.join("\n\n");
      out.push(Decoration.widget(pos, () => overlay(body, hold.peer.color), { key: `${hold.peer.deviceId}:${body}`, side: -1, ignoreSelection: true }));
      return out;
    });
}

/** The decorations and read-only ranges for what others hold in `doc`. */
export function holdDecorations(doc: PMNode, markdown: string, holds: PeerHold[]): HoldState {
  const units = docUnits(doc);
  let texts = unitTexts(markdown);
  if (texts.length === units.length + 1 && texts[0].startsWith("---")) texts = texts.slice(1);
  if (texts.length !== units.length) return { set: DecorationSet.empty, ranges: [] };
  const keys = unitKeys(texts);
  const ranges: HeldRange[] = [];
  const decorations: Decoration[] = [];
  for (const hold of holds) {
    decorations.push(...overlayDecorations(units, texts, keys, hold));
    keys.forEach((key, i) => {
      if (!hold.keys.has(key)) return;
      ranges.push({ ...units[i], peer: hold.peer });
      decorations.push(
        Decoration.node(units[i].from, units[i].to, {
          class: "sync-held",
          title: hold.peer.name,
          "data-initial": hold.peer.name.charAt(0).toUpperCase(),
          style: `--sync-color:${hold.peer.color}`,
        }),
      );
    });
  }
  return { set: DecorationSet.create(doc, decorations), ranges };
}

/** Does `tr` change a held unit? A change inside one or across its edge;
 *  typing beside it is not. */
export function touchesHeld(tr: Transaction, ranges: HeldRange[]): boolean {
  return tr.steps.some((step, i) => {
    const back = tr.mapping.slice(0, i).invert();
    let hit = false;
    step.getMap().forEach((start, end) => {
      const a = back.map(start, -1);
      const b = back.map(end, 1);
      hit ||= ranges.some((r) => (a === b ? r.from < a && a < r.to : r.from < b && a < r.to));
    });
    return hit;
  });
}

function heldAtSelection(state: EditorState): HeldRange | undefined {
  const { from, to } = state.selection;
  return holdsKey.getState(state)?.ranges.find((r) => (from === to ? r.from < from && from < r.to : r.from < to && from < r.to));
}

function noteElement(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-held-note";
  el.setAttribute("contenteditable", "false");
  el.textContent = `${name} is editing this`;
  return el;
}

/** Say quietly who holds this, where the user tried to type. */
function holdNote(view: EditorView, range: HeldRange) {
  const value = holdsKey.getState(view.state) ?? EMPTY_HOLDS;
  const note = Decoration.widget(range.to - 1, () => noteElement(range.peer.name), { key: `note:${range.peer.deviceId}:${Date.now()}`, side: 1, ignoreSelection: true });
  const set = value.set.remove(value.set.find(undefined, undefined, (spec) => String(spec.key).startsWith("note:"))).add(view.state.doc, [note]);
  view.dispatch(view.state.tr.setMeta(holdsKey, { ...value, set }).setMeta("addToHistory", false));
}

function createHoldPlugin() {
  return new Plugin<HoldState>({
    key: holdsKey,
    state: {
      init: () => EMPTY_HOLDS,
      apply(tr, value) {
        const next = tr.getMeta(holdsKey) as HoldState | undefined;
        if (next) return next;
        if (!tr.docChanged) return value;
        return {
          set: value.set.map(tr.mapping, tr.doc),
          ranges: value.ranges
            .map((r) => ({ ...r, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }))
            .filter((r) => r.to > r.from),
        };
      },
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(ADOPTION_TRANSACTION_META)) return true;
      const ranges = holdsKey.getState(state)?.ranges ?? [];
      return ranges.length === 0 || !touchesHeld(tr, ranges);
    },
    props: {
      decorations: (state) => holdsKey.getState(state)?.set,
      handleDOMEvents: {
        beforeinput(view, event) {
          const held = heldAtSelection(view.state);
          if (!held) return false;
          event.preventDefault();
          holdNote(view, held);
          return true;
        },
      },
    },
  });
}

type SetTimer = (run: () => void, ms: number) => () => void;

interface Attached {
  editor: Editor;
  shown: string;
  /** What the holds decorations were built from. */
  held: string;
  heldDoc: PMNode | null;
}

/** Keeps the plugin on the right editors, as the engine's poll sees them. */
export function createSyncEditors(deps: {
  root: string;
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  /** What others hold in a document. */
  holds(path: string): Promise<PeerHold[]>;
  onCursor(cursor: SyncCursor | null): void;
  setTimer: SetTimer;
}) {
  const attached = new Map<string, Attached>();
  const relative = (path: string) => pathutil.relative(deps.root, path) ?? "";
  const treePath = (path: string) => pathutil.toTreePath(relative(path));

  const detach = (path: string) => {
    const entry = attached.get(path);
    attached.delete(path);
    if (entry && !entry.editor.isDestroyed) {
      entry.editor.unregisterPlugin(caretsKey);
      entry.editor.unregisterPlugin(holdsKey);
    }
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
    async reconcile(state: SyncState) {
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
          editor.registerPlugin(createHoldPlugin());
          attached.set(path, { editor, shown: "[]", held: "", heldDoc: null });
        }
        const entry = attached.get(path) as Attached;
        if (entry.shown !== peers) {
          entry.shown = peers;
          editor.view.dispatch(editor.state.tr.setMeta(caretsKey, state.peers).setMeta("addToHistory", false));
        }
        await this.redrawHolds(path, entry);
      }
    },
    async redrawHolds(path: string, entry: Attached) {
      const holds = await deps.holds(treePath(path));
      const key = JSON.stringify(holds.map(({ peer, keys, text }) => [peer.deviceId, [...keys], text]));
      if (entry.editor.isDestroyed) return;
      if (key === entry.held && (holds.length === 0 || entry.heldDoc === entry.editor.state.doc)) return;
      entry.held = key;
      entry.heldDoc = entry.editor.state.doc;
      const next = holdDecorations(entry.editor.state.doc, getEditorMarkdown(entry.editor), holds);
      entry.editor.view.dispatch(entry.editor.state.tr.setMeta(holdsKey, next).setMeta("addToHistory", false));
      entry.heldDoc = entry.editor.state.doc;
    },
    stop() {
      for (const path of [...attached.keys()]) detach(path);
    },
  };
}
