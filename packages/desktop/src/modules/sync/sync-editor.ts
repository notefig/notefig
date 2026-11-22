/**
 * The shared level in the editor (MET-272, MET-273): while someone else
 * syncs the branch, each of the workspace's open markdown editors carries
 * two plugins. Solo, none does.
 *
 * - Carets: the others' carets drawn, each with a small name tag on hover,
 *   and this device's reported. A caret
 *   move only arms a timer, so nothing runs per keystroke. A caret is a
 *   unit of the document and a character in it (`SyncCursor`), so it lands
 *   in the same paragraph on a device whose text above differs.
 * - Claims (`sync-claims.ts`): an edit claims the units it touches, or is
 *   refused before it changes anything when another device holds one (or
 *   this one holds its four). A unit someone else holds is a shade paler,
 *   with a faint line in their colour in the editor's start gutter (clear
 *   of bullets, checkboxes and the drag handle) and a not-allowed
 *   cursor; their name shows on hover. A caret in a unit someone else
 *   just took moves to just after it. Your own claims show nothing.
 *
 * - Work in progress (`sync-wip.ts`): a unit someone else holds shows what
 *   they've typed in it, drawn over this copy's text, and a unit they've
 *   just made shows under the one before it, their caret in it. Drawn,
 *   never written: the doc, its saves and its undo keep this copy's text
 *   until the branch brings theirs.
 *
 * Writes that aren't the user's typing pass: sync's and agents' adopted
 * writes (agents' are gated where they're made), and changes kept out of
 * undo (a widget's state).
 */
import type { Editor } from "@tiptap/core";
import { DOMSerializer, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ADOPTION_TRANSACTION_META } from "@/components/editor/adopt-external-content";
import type { EditorsApi } from "@/modules/editors";
import type { ClaimHolder, Claims } from "./sync-claims";
import { isShared, type SyncCursor, type SyncPeer, type SyncState } from "./sync-machine";
import { cursorAt, docUnits, indexOf, keyedUnits, unitsIn, type DocUnit, type UnitIndex } from "./sync-units";
import type { Wip, WipUnit } from "./sync-wip";

const REPORT_MS = 300;
const carets = new PluginKey<DecorationSet>("syncCarets");
const held = new PluginKey<DecorationSet>("syncClaims");
const typing = new PluginKey<DecorationSet>("syncWip");

type SetTimer = (run: () => void, ms: number) => () => void;

function caret(peer: SyncPeer): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-caret";
  el.dataset.syncPeer = peer.deviceId;
  // Their name, on hover, from the stylesheet: no text in the document's DOM.
  if (peer.name) el.dataset.name = peer.name;
  el.style.setProperty("--sync-peer", peer.colour ?? "currentColor");
  return el;
}

/** The carets of the peers in `path`. */
export function caretDecorations(doc: PMNode, path: string, peers: SyncPeer[], drawn: ReadonlySet<string> = new Set()): DecorationSet {
  const here = peers.filter((peer) => peer.cursor?.path === path && !drawn.has(peer.deviceId));
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

/** `json`, a node of another device's copy, as this editor draws it; its
 *  content alone for a unit drawn over one here. The holder's caret is in
 *  it at `caret`, a character into its text. */
function renderUnit(schema: Schema, json: WipUnit["node"], inner: boolean, caretAt: { peer: SyncPeer; offset: number } | null) {
  const wrap = document.createElement(inner ? "span" : "div");
  wrap.className = inner ? "sync-wip" : "sync-wip sync-wip-new";
  try {
    const node = schema.nodeFromJSON(json);
    const serializer = DOMSerializer.fromSchema(schema);
    wrap.append(inner ? serializer.serializeFragment(node.content) : serializer.serializeNode(node));
  } catch {
    // A node this editor can't hold: nothing drawn, its text stays.
    return wrap;
  }
  if (caretAt) placeCaret(wrap, caretAt.offset, caret(caretAt.peer));
  return wrap;
}

/** Put `mark` `offset` characters into `root`'s text, or at its end. */
function placeCaret(root: HTMLElement, offset: number, mark: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
    if (left <= text.length) {
      text.parentNode!.insertBefore(mark, text.splitText(left));
      return;
    }
    left -= text.length;
  }
  (root.querySelector("p, h1, h2, h3, h4, h5, h6, li") ?? root).append(mark);
}

/** Where each peer's caret is drawn by the work in progress: their caret
 *  is in a unit of theirs drawn here. */
const wipCaret = (unit: WipUnit, peers: readonly SyncPeer[]) => {
  const peer = peers.find((p) => p.deviceId === unit.holder.peer.deviceId);
  return peer?.cursor && peer.cursor.unit === unit.at ? { peer, offset: peer.cursor.offset } : null;
};

/** What `wipDecorations` knows of this copy while it draws. */
interface Here {
  doc: PMNode;
  index: UnitIndex;
  byKey: Map<string, DocUnit & { key: string }>;
  /** Where a unit of theirs ends here, for one they made after it. */
  ends: Map<string, number>;
  /** Who holds each unit here, as claims settle it (`Claims.heldIn`). */
  held: ReadonlyMap<string, ClaimHolder>;
}

/** How one unit is drawn: its holder's caret in it, and the widget's key. */
interface Draw {
  caretAt: ReturnType<typeof wipCaret>;
  key: string;
}

/** A unit they hold that this copy has too: their text drawn over this
 *  copy's, which is hidden. */
function drawOver(here: Here, unit: WipUnit, mine: DocUnit & { key: string }, draw: Draw) {
  const node = here.doc.nodeAt(mine.from);
  // Theirs only while it's theirs here: a race this device won is its own.
  if (!node?.isTextblock || here.held.get(mine.key)?.peer.deviceId !== unit.holder.peer.deviceId) return [];
  here.ends.set(unit.key, mine.to);
  const hidden = mine.to - mine.from > 2 ? [Decoration.inline(mine.from + 1, mine.to - 1, { class: "sync-wip-hidden" })] : [];
  return [...hidden, Decoration.widget(mine.from + 1, (view) => renderUnit(view.state.schema, unit.node, true, draw.caretAt), { key: draw.key, side: -1 })];
}

/** A unit they made: under the one before it, if that's here. */
function drawNew(here: Here, unit: WipUnit, draw: Draw) {
  const after = unit.previous ? (here.ends.get(unit.previous) ?? here.byKey.get(here.index.resolve(unit.previous) ?? "")?.to) : undefined;
  if (after === undefined) return [];
  here.ends.set(unit.key, after);
  return [Decoration.widget(after, (view) => renderUnit(view.state.schema, unit.node, false, draw.caretAt), { key: draw.key, side: unit.at + 1 })];
}

/** Others' work in progress in `doc`: each unit they hold drawn over this
 *  copy's, its text hidden; each they made, under the unit before it. */
export function wipDecorations(
  doc: PMNode,
  units: WipUnit[],
  peers: readonly SyncPeer[],
  held: ReadonlyMap<string, ClaimHolder>,
): DecorationSet {
  if (units.length === 0) return DecorationSet.empty;
  const index = indexOf(doc);
  const here: Here = { doc, index, byKey: new Map(keyedUnits(doc).map((unit) => [unit.key, unit])), ends: new Map(), held };
  const decorations = [...units]
    .sort((a, b) => a.at - b.at)
    .flatMap((unit) => {
      const caretAt = wipCaret(unit, peers);
      const draw: Draw = { caretAt, key: `wip:${unit.holder.peer.deviceId}:${unit.key}:${JSON.stringify(unit.node).length}:${caretAt?.offset ?? ""}` };
      // This copy says it already: nothing to draw.
      const same = here.byKey.get(index.resolve(unit.key) ?? "");
      if (same) return here.ends.set(unit.key, same.to), [];
      const mine = unit.keys.map((key) => here.byKey.get(index.resolve(key) ?? "")).find((found) => found !== undefined);
      if (mine) return drawOver(here, unit, mine, draw);
      // Made by them, if its claim names nothing it said before; otherwise
      // this copy changed it too, and the merge settles it.
      return unit.keys.length === 1 ? drawNew(here, unit, draw) : [];
    });
  return DecorationSet.create(doc, decorations);
}

/** "Ada is editing this", or her agent. */
export function holderLabel({ peer, agent }: ClaimHolder): string {
  const name = peer.name ?? "Someone";
  return agent ? `${name}'s agent is editing this` : `${name} is editing this`;
}

/** The units others hold in `doc`, drawn; `indents` is how far each
 *  unit's start sits from the text's, as laid out, so its line can sit in
 *  the gutter whatever the unit is nested in. */
export function heldDecorations(
  doc: PMNode,
  holders: Map<string, ClaimHolder>,
  indents: ReadonlyMap<string, number> = new Map(),
): DecorationSet {
  if (holders.size === 0) return DecorationSet.empty;
  const decorations = keyedUnits(doc).flatMap(({ from, to, key }) => {
    const holder = holders.get(key);
    if (!holder) return [];
    const indent = indents.get(key);
    return [
      Decoration.node(
        from,
        to,
        {
          class: "sync-held",
          style: `--sync-holder:${holder.peer.colour ?? "currentColor"}${indent === undefined ? "" : `;--sync-indent:${indent}px`}`,
          title: holderLabel(holder),
          "data-sync-holder": holder.peer.deviceId,
        },
        { key },
      ),
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

/** How far each held unit's start sits from the text's, as laid out:
 *  the indent its lists and quotes give it. */
function indentsOf(view: EditorView, decorations: DecorationSet): Map<string, number> {
  const start = (view.dom.firstElementChild ?? view.dom).getBoundingClientRect().left;
  const indents = new Map<string, number>();
  for (const { from, spec } of decorations.find()) {
    const dom = view.nodeDOM(from);
    if (dom instanceof HTMLElement) indents.set(spec.key as string, Math.round(dom.getBoundingClientRect().left - start));
  }
  return indents;
}

const sameIndents = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([key, indent]) => b.get(key) === indent);

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
  // Measured after a redraw, never per keystroke: an indent changes only
  // with the units held, or their text arriving.
  let indents: ReadonlyMap<string, number> = new Map();
  let redrawn = false;
  return new Plugin<DecorationSet>({
    key: held,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        // Others' claims changed, or their text arrived: drawn again.
        if (!tr.getMeta(held) && !(tr.docChanged && !isTyping(tr))) return value.map(tr.mapping, tr.doc);
        redrawn = true;
        return heldDecorations(tr.doc, claims.heldIn(path, indexOf(tr.doc)), indents);
      },
    },
    props: {
      decorations: (state) => held.getState(state),
    },
    filterTransaction: (tr) => !isTyping(tr) || !claims.take(path, editOf(tr), false, indexOf(tr.before)),
    view() {
      return {
        update(current, previous) {
          const decorations = held.getState(current.state);
          if (!decorations || decorations === held.getState(previous)) return;
          if (current.hasFocus()) {
            // Someone took the unit this caret is in: on to just after it.
            const head = current.state.selection.head;
            const [taken] = decorations.find(head, head);
            if (taken) setTimer(() => moveOut(current, taken), 0);
          }
          if (!redrawn) return;
          redrawn = false;
          const measured = indentsOf(current, decorations);
          if (sameIndents(measured, indents)) return;
          indents = measured;
          setTimer(() => current.dispatch(current.state.tr.setMeta(held, true).setMeta("addToHistory", false)), 0);
        },
      };
    },
  });
}

/** What one editor draws of others' typing, and the peers it's drawn with. */
interface WipView {
  units(): WipUnit[];
  peers(): readonly SyncPeer[];
  /** Who holds each unit of `doc`. */
  held(doc: PMNode): ReadonlyMap<string, ClaimHolder>;
}

/** Others' work in progress in one editor (`wipDecorations`): redrawn when
 *  it changes, or a write that isn't typing changes what this copy says. */
function wipPlugin(wip: WipView) {
  return new Plugin<DecorationSet>({
    key: typing,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        if (!tr.getMeta(typing) && !(tr.docChanged && !isTyping(tr))) return value.map(tr.mapping, tr.doc);
        const units = wip.units();
        return units.length === 0 ? DecorationSet.empty : wipDecorations(tr.doc, units, wip.peers(), wip.held(tr.doc));
      },
    },
    props: { decorations: (state) => typing.getState(state) },
  });
}

function caretPlugin(
  path: string,
  report: (view: EditorView) => void,
  leave: () => void,
  setTimer: SetTimer,
  drawn: () => ReadonlySet<string>,
) {
  return new Plugin<DecorationSet>({
    key: carets,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        const peers = tr.getMeta(carets) as SyncPeer[] | undefined;
        return peers ? caretDecorations(tr.doc, path, peers, drawn()) : value.map(tr.mapping, tr.doc);
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
   *  off solo, and redraw the others' carets, claims and typing. */
  reconcile(state: SyncState): void;
  /** The files (`/`-separated) whose editors carry the plugins. */
  paths(): string[];
  stop(): void;
}

export function createSyncEditors(deps: {
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  /** A file's `/`-separated path in the workspace; null outside it. */
  tree(path: string): string | null;
  onCursor(cursor: SyncCursor): void;
  claims: Claims;
  /** Others' work in progress, read for the files open here. */
  wip: Pick<Wip, "in">;
  setTimer: SetTimer;
}): SyncEditors {
  const attached = new Map<string, { editor: Editor; shown: string; setPeers(peers: readonly SyncPeer[]): void }>();

  const detach = (path: string) => {
    const editor = attached.get(path)?.editor;
    attached.delete(path);
    if (!editor || editor.isDestroyed) return;
    editor.unregisterPlugin(carets);
    editor.unregisterPlugin(held);
    editor.unregisterPlugin(typing);
  };

  const attach = (path: string, editor: Editor) => {
    const report = (view: EditorView) => {
      const { doc, selection } = view.state;
      deps.onCursor({ path, ...cursorAt(doc, selection.head) });
      const [unit] = unitsIn(doc, selection.head, selection.head);
      deps.claims.setCaret({ path, key: unit?.key ?? null });
    };
    const leave = () => deps.claims.setCaret(null);
    let peers: readonly SyncPeer[] = [];
    const wip: WipView = {
      units: () => deps.wip.in(path),
      peers: () => peers,
      held: (doc) => deps.claims.heldIn(path, indexOf(doc)),
    };
    // A caret in a unit drawn from its holder's copy is drawn there.
    const drawn = () => new Set(wip.units().flatMap((unit) => (wipCaret(unit, peers) ? [unit.holder.peer.deviceId] : [])));
    editor.registerPlugin(caretPlugin(path, report, leave, deps.setTimer, drawn));
    editor.registerPlugin(claimsPlugin({ path, claims: deps.claims, setTimer: deps.setTimer }));
    editor.registerPlugin(wipPlugin(wip));
    return (next: readonly SyncPeer[]) => {
      peers = next;
    };
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
          attached.set(path, (entry = { editor, shown: "", setPeers: attach(path, editor) }));
        }
        const shown = `${peers}\u0000${JSON.stringify(deps.wip.in(path))}`;
        if (entry.shown === shown) continue;
        entry.shown = shown;
        entry.setPeers(state.peers);
        editor.view.dispatch(
          editor.state.tr
            .setMeta(typing, true)
            .setMeta(carets, state.peers)
            .setMeta(held, true)
            .setMeta("addToHistory", false),
        );
      }
    },
    paths: () => [...attached.keys()],
    stop() {
      for (const path of [...attached.keys()]) detach(path);
    },
  };
}
