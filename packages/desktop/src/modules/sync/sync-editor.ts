/**
 * The shared level in the editor (MET-272, MET-273): while someone else
 * syncs the branch, each of the workspace's open markdown editors carries
 * two plugins. Solo, none does.
 *
 * - Carets: the others' carets drawn, and this device's reported. A caret
 *   move only arms a timer, so nothing runs per keystroke. A caret is a
 *   unit of the document and a character in it (`SyncCursor`), so it lands
 *   in the same paragraph on a device whose text above differs.
 * - Claims (`sync-claims.ts`): an edit claims the units it touches, or is
 *   refused before it changes anything when another device holds one (or
 *   this one holds its four). A unit someone else holds is a shade paler,
 *   with a faint line in their colour down its start and a not-allowed
 *   cursor; their name shows on hover, or in a tooltip that fades when a
 *   keystroke there is refused. A caret in a unit someone else just took
 *   moves to just after it. Your own claims show nothing.
 *
 * Writes that aren't the user's typing pass: sync's and agents' adopted
 * writes (agents' are gated where they're made), and changes kept out of
 * undo (a widget's state).
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ADOPTION_TRANSACTION_META } from "@/components/editor/adopt-external-content";
import type { EditorsApi } from "@/modules/editors";
import type { ClaimHolder, ClaimRefusal, Claims } from "./sync-claims";
import { MAX_CLAIMS } from "./sync-claims";
import { isShared, type SyncCursor, type SyncPeer, type SyncState } from "./sync-machine";
import { cursorAt, docUnits, indexOf, keyedUnits, unitsIn } from "./sync-units";

const REPORT_MS = 300;
const TIP_MS = 1_600;
const carets = new PluginKey<DecorationSet>("syncCarets");
const held = new PluginKey<DecorationSet>("syncClaims");

type SetTimer = (run: () => void, ms: number) => () => void;

function caret(peer: SyncPeer): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-caret";
  el.dataset.syncPeer = peer.deviceId;
  if (peer.name) el.title = peer.name;
  el.style.cssText = `border-left:2px solid ${peer.colour ?? "currentColor"};margin:0 -1px;`;
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

/** "Ada is editing this", or her agent. */
export function holderLabel({ peer, agent }: ClaimHolder): string {
  const name = peer.name ?? "Someone";
  return agent ? `${name}'s agent is editing this` : `${name} is editing this`;
}

function refusalLabel(refusal: ClaimRefusal): string {
  if (refusal.kind === "held") return holderLabel(refusal.holders[0]!);
  return `You can edit ${MAX_CLAIMS} places at a time while others are here`;
}

/** The units others hold in `doc`, drawn. */
export function heldDecorations(doc: PMNode, holders: Map<string, ClaimHolder>): DecorationSet {
  if (holders.size === 0) return DecorationSet.empty;
  const decorations = keyedUnits(doc).flatMap(({ from, to, key }) => {
    const holder = holders.get(key);
    if (!holder) return [];
    return [
      Decoration.node(from, to, {
        class: "sync-held",
        style: `--sync-holder:${holder.peer.colour ?? "currentColor"}`,
        title: holderLabel(holder),
        "data-sync-holder": holder.peer.deviceId,
      }),
    ];
  });
  return DecorationSet.create(doc, decorations);
}

/** The stretches of `tr.before` an edit changed, and where they went: a
 *  replace by its step map, a mark or attribute change by its range. */
function editedRanges(tr: Transaction): { before: [number, number]; after: [number, number] }[] {
  const ranges: { before: [number, number]; after: [number, number] }[] = [];
  tr.steps.forEach((step, i) => {
    const back = tr.mapping.slice(0, i).invert();
    const forward = tr.mapping.slice(i + 1);
    let found = false;
    step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
      found = true;
      ranges.push({
        before: [back.map(oldStart, -1), back.map(oldEnd, 1)],
        after: [forward.map(newStart, -1), forward.map(newEnd, 1)],
      });
    });
    if (found) return;
    const json = step.toJSON() as { from?: number; to?: number; pos?: number };
    const from = json.from ?? json.pos;
    if (from === undefined) return;
    const to = json.to ?? from + 1;
    ranges.push({ before: [back.map(from, -1), back.map(to, 1)], after: [forward.map(from, -1), forward.map(to, 1)] });
  });
  return ranges;
}

/** The units an edit touched, as they were and as they are. */
export function editOf(tr: Transaction) {
  const before: (string | null)[] = [];
  const after: (string | null)[] = [];
  const seen = new Set<number>();
  const seenAfter = new Set<number>();
  for (const range of editedRanges(tr)) {
    for (const unit of unitsIn(tr.before, ...range.before)) {
      if (!seen.has(unit.from)) seen.add(unit.from), before.push(unit.key);
    }
    for (const unit of unitsIn(tr.doc, ...range.after)) {
      if (!seenAfter.has(unit.from)) seenAfter.add(unit.from), after.push(unit.key);
    }
  }
  return { before, after };
}

/** The user's own edit: not an adopted write, not one kept out of undo. */
const isTyping = (tr: Transaction) =>
  tr.docChanged && tr.getMeta(ADOPTION_TRANSACTION_META) !== true && tr.getMeta("addToHistory") !== false;

/** Show `text` just above the start of the unit at `pos`, fading on its
 *  own. */
function showTip(view: EditorView, pos: number, text: string, setTimer: SetTimer) {
  const at = view.coordsAtPos(Math.min(pos, view.state.doc.content.size));
  const tip = document.createElement("div");
  tip.className = "sync-held-tip";
  tip.setAttribute("role", "status");
  tip.textContent = text;
  tip.style.left = `${at.left}px`;
  tip.style.top = `${at.top - 6}px`;
  document.body.querySelector(".sync-held-tip")?.remove();
  document.body.append(tip);
  setTimer(() => tip.remove(), TIP_MS);
}

/** Where a caret goes when someone takes the unit it's in: the first
 *  place to type after the unit; at the end of the doc, a new paragraph. */
function moveOut(view: EditorView, unit: { from: number; to: number }) {
  const { state } = view;
  const next = Selection.findFrom(state.doc.resolve(Math.min(unit.to, state.doc.content.size)), 1, true);
  const tr = state.tr.setMeta("addToHistory", false);
  if (next && next.from >= unit.to) tr.setSelection(next);
  else {
    const end = state.doc.content.size;
    tr.insert(end, state.schema.nodes.paragraph!.create());
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
  }
  view.dispatch(tr.scrollIntoView());
}

interface ClaimView {
  path: string;
  claims: Claims;
  setTimer: SetTimer;
}

function claimsPlugin({ path, claims, setTimer }: ClaimView) {
  let view: EditorView | null = null;
  return new Plugin<DecorationSet>({
    key: held,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) =>
        // Others' claims changed, or their text arrived: drawn again.
        tr.getMeta(held) || (tr.docChanged && !isTyping(tr))
          ? heldDecorations(tr.doc, claims.heldIn(path, indexOf(tr.doc)))
          : value.map(tr.mapping, tr.doc),
    },
    props: {
      decorations: (state) => held.getState(state),
    },
    filterTransaction(tr) {
      if (!isTyping(tr)) return true;
      const refusal = claims.take(path, editOf(tr), false, indexOf(tr.before));
      if (!refusal) return true;
      const [first] = editedRanges(tr);
      const [unit] = first ? unitsIn(tr.before, ...first.before) : [];
      if (view) showTip(view, unit ? unit.from + 1 : tr.selection.head, refusalLabel(refusal), setTimer);
      return false;
    },
    view(editorView) {
      view = editorView;
      return {
        update(current, previous) {
          const decorations = held.getState(current.state);
          if (decorations === held.getState(previous) || !current.hasFocus()) return;
          // Someone took the unit this caret is in: on to just after it.
          const head = current.state.selection.head;
          const [taken] = decorations?.find(head, head) ?? [];
          if (taken) setTimer(() => moveOut(current, taken), 0);
        },
        destroy: () => {
          view = null;
        },
      };
    },
  });
}

function caretPlugin(path: string, report: (view: EditorView) => void, leave: () => void, setTimer: SetTimer) {
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
      // Someone just came, or this tab came forward: show where this is.
      arm();
      view.dom.addEventListener("focus", arm);
      view.dom.addEventListener("blur", leave);
      return {
        update(_, previous) {
          if (!view.state.selection.eq(previous.selection) || view.state.doc !== previous.doc) arm();
        },
        destroy: () => {
          cancel?.();
          view.dom.removeEventListener("focus", arm);
          view.dom.removeEventListener("blur", leave);
        },
      };
    },
  });
}

export interface SyncEditors {
  /** Put the plugins on the workspace's editors while shared, take them
   *  off solo, and redraw the others' carets and claims. */
  reconcile(state: SyncState): void;
  stop(): void;
}

export function createSyncEditors(deps: {
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  /** A file's `/`-separated path in the workspace; null outside it. */
  tree(path: string): string | null;
  onCursor(cursor: SyncCursor): void;
  claims: Claims;
  setTimer: SetTimer;
}): SyncEditors {
  const attached = new Map<string, { editor: Editor; shown: string }>();

  const detach = (path: string) => {
    const editor = attached.get(path)?.editor;
    attached.delete(path);
    if (!editor || editor.isDestroyed) return;
    editor.unregisterPlugin(carets);
    editor.unregisterPlugin(held);
  };

  const attach = (path: string, editor: Editor) => {
    const report = (view: EditorView) => {
      const { doc, selection } = view.state;
      deps.onCursor({ path, ...cursorAt(doc, selection.head) });
      const [unit] = unitsIn(doc, selection.head, selection.head);
      deps.claims.setCaret({ path, key: unit?.key ?? null });
    };
    const leave = () => deps.claims.setCaret(null);
    editor.registerPlugin(caretPlugin(path, report, leave, deps.setTimer));
    editor.registerPlugin(claimsPlugin({ path, claims: deps.claims, setTimer: deps.setTimer }));
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
          attach(path, editor);
          attached.set(path, (entry = { editor, shown: "" }));
        }
        if (entry.shown === peers) continue;
        entry.shown = peers;
        editor.view.dispatch(editor.state.tr.setMeta(carets, state.peers).setMeta(held, true).setMeta("addToHistory", false));
      }
    },
    stop() {
      for (const path of [...attached.keys()]) detach(path);
    },
  };
}
