/**
 * The shared level in the editor (MET-272, MET-273): while someone else
 * syncs the branch, each of the workspace's open markdown editors carries
 * three plugins. Solo, none does.
 *
 * - Where the others are: a block each, not a caret. Their text reaches
 *   this device a cycle or two late, so presence is the unit they're in,
 *   with their name beside it, and this device's unit is reported. A caret
 *   move only arms a timer, so nothing runs per keystroke.
 * - Claims (`sync-claims.ts`): an edit claims the units it touches, or is
 *   refused before it changes anything when another device holds one (or
 *   this one holds its four). A unit someone else holds is a shade paler,
 *   with a not-allowed cursor; their name shows on hover. A caret in a
 *   unit someone else just took moves to just after it. Your own claims
 *   show nothing.
 * - Work in progress (`sync-wip.ts`): a unit someone else holds shows what
 *   they've typed in it, drawn over this copy's text, and a unit they've
 *   just made shows under the one before it. What arrived since it was
 *   last drawn is washed in their colour, which fades. Drawn, never
 *   written: the doc, its saves and its undo keep this copy's text until
 *   the branch brings theirs.
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
const here = new PluginKey<DecorationSet>("syncPeers");
const held = new PluginKey<DecorationSet>("syncClaims");
const typing = new PluginKey<WipDraw>("syncWip");

type SetTimer = (run: () => void, ms: number) => () => void;

/** Who's in one block, as the block shows it: their names, and the first
 *  one's colour. */
function presentAttrs(peers: readonly SyncPeer[]) {
  const names = peers.map((peer) => peer.name ?? "Someone").join(", ");
  return { class: "sync-here", "data-sync-names": names, style: `--sync-peer:${peers[0]?.colour ?? "currentColor"}` };
}

/** Each peer in `path` on the block they're in, named; but for the ones
 *  `drawn` on what they're typing (`wipDecorations`). */
export function peerDecorations(doc: PMNode, path: string, peers: readonly SyncPeer[], drawn: ReadonlySet<string> = new Set()): DecorationSet {
  const units = docUnits(doc);
  const byUnit = new Map<number, SyncPeer[]>();
  for (const peer of peers) {
    if (peer.cursor?.path !== path || drawn.has(peer.deviceId) || units.length === 0) continue;
    const at = Math.min(peer.cursor.unit, units.length - 1);
    byUnit.set(at, [...(byUnit.get(at) ?? []), peer]);
  }
  if (byUnit.size === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    [...byUnit].map(([at, there]) => Decoration.node(units[at]!.from, units[at]!.to, presentAttrs(there))),
  );
}

/** What changed from `before` to `after`, as one stretch of `after`; null
 *  when nothing was added. */
export function arrived(before: string, after: string): [number, number] | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return after.length - end > start ? [start, after.length - end] : null;
}

/** Tint `[from, to)` of `root`'s text: what just arrived, washed in the
 *  holder's colour, which fades. */
function wash(root: HTMLElement, [from, to]: [number, number]) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text as Text);
  let at = 0;
  for (const text of texts) {
    const [start, end] = [Math.max(from - at, 0), Math.min(to - at, text.length)];
    at += text.length;
    if (start >= end) continue;
    const middle = text.splitText(start);
    middle.splitText(end - start);
    const tint = document.createElement("span");
    tint.className = "sync-wash";
    middle.replaceWith(tint);
    tint.append(middle);
  }
}

/** `json`, a node of another device's copy, as this editor draws it; its
 *  content alone for a unit drawn over one here. */
function renderUnit(schema: Schema, json: WipUnit["node"], draw: Draw) {
  const inner = draw.over;
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
  if (!inner) {
    wrap.style.setProperty("--sync-holder", draw.colour);
    // Named on the paragraph drawn, after its last word, as a block here is.
    const block = wrap.firstElementChild;
    if (draw.present && block instanceof HTMLElement) {
      const attrs = presentAttrs(draw.present);
      block.classList.add(attrs.class);
      block.dataset.syncNames = attrs["data-sync-names"];
      block.style.setProperty("--sync-peer", draw.present[0]?.colour ?? "currentColor");
    }
  }
  if (draw.arrived) wash(wrap, draw.arrived);
  return wrap;
}

/** The peers whose cursor is in a unit of theirs drawn here: their name
 *  goes on what they're typing. Its file too: a claim outlives the cursor
 *  leaving for another file, whose unit may have the same place. */
const presentIn = (unit: WipUnit, peers: readonly SyncPeer[]) =>
  peers.filter((p) => p.deviceId === unit.holder.peer.deviceId && p.cursor?.path === unit.path && p.cursor.unit === unit.at);

/** What `wipDecorations` knows of this copy while it draws. */
interface Here {
  doc: PMNode;
  index: UnitIndex;
  byKey: Map<string, DocUnit & { key: string }>;
  /** Where a unit of theirs ends here, for one they made after it. */
  ends: Map<string, number>;
  /** Who holds each unit here, as claims settle it (`Claims.heldIn`). */
  held: ReadonlyMap<string, ClaimHolder>;
  /** What each unit drawn last time said, by `Draw.id`; and this time's. */
  shown: ReadonlyMap<string, string>;
  next: Map<string, string>;
  /** The peers named on what's drawn: their block isn't named again. */
  named: Set<string>;
}

/** The peers in `unit`, as they're named on it. */
function nameIn(here: Here, unit: WipUnit, peers: readonly SyncPeer[]) {
  const present = presentIn(unit, peers);
  for (const peer of present) here.named.add(peer.deviceId);
  return present;
}

/** How one unit is drawn. */
interface Draw {
  /** Drawn over a unit here, or as a unit they made. */
  over: boolean;
  /** The text just arrived, to wash. */
  arrived: [number, number] | null;
  /** Who's in it, named on it. */
  present: SyncPeer[] | null;
  colour: string;
  key: string;
}

/** How `unit` is drawn, given what was drawn of it before (or, the first
 *  time, `base`: what this copy says there). */
function drawOf(here: Here, unit: WipUnit, id: string, base: string, peers: readonly SyncPeer[], over: boolean): Draw {
  const text = here.doc.type.schema.nodeFromJSON(unit.node).textContent;
  here.next.set(id, text);
  const present = nameIn(here, unit, peers);
  return {
    over,
    arrived: arrived(here.shown.get(id) ?? base, text),
    present: present.length > 0 ? present : null,
    colour: unit.holder.peer.colour ?? "currentColor",
    key: `wip:${id}:${present.length}:${text}`,
  };
}

/** A unit they hold that this copy has too: their text drawn over this
 *  copy's, which is hidden. */
function drawOver(here: Here, unit: WipUnit, mine: DocUnit & { key: string }, peers: readonly SyncPeer[]) {
  const node = here.doc.nodeAt(mine.from);
  // Theirs only while it's theirs here: a race this device won is its own.
  if (!node?.isTextblock || here.held.get(mine.key)?.peer.deviceId !== unit.holder.peer.deviceId) return [];
  here.ends.set(unit.key, mine.to);
  const draw = drawOf(here, unit, `${unit.holder.peer.deviceId}:${mine.key}`, node.textContent, peers, true);
  const hidden = mine.to - mine.from > 2 ? [Decoration.inline(mine.from + 1, mine.to - 1, { class: "sync-wip-hidden" })] : [];
  const named = draw.present ? [Decoration.node(mine.from, mine.to, presentAttrs(draw.present))] : [];
  return [
    ...hidden,
    ...named,
    Decoration.widget(mine.from + 1, (view) => renderUnit(view.state.schema, unit.node, draw), { key: draw.key, side: -1 }),
  ];
}

/** A unit they made: under the one before it, if that's here. */
function drawNew(here: Here, unit: WipUnit, peers: readonly SyncPeer[]) {
  const after = unit.previous ? (here.ends.get(unit.previous) ?? here.byKey.get(here.index.resolve(unit.previous) ?? "")?.to) : undefined;
  if (after === undefined) return [];
  here.ends.set(unit.key, after);
  const draw = drawOf(here, unit, `${unit.holder.peer.deviceId}:new:${unit.at}`, "", peers, false);
  return [Decoration.widget(after, (view) => renderUnit(view.state.schema, unit.node, draw), { key: draw.key, side: unit.at + 1 })];
}

/** One draw of others' work in progress: its decorations, what each unit
 *  said (the next draw's `shown`), and the peers it named. */
export interface WipDraw {
  decorations: DecorationSet;
  shown: ReadonlyMap<string, string>;
  named: ReadonlySet<string>;
}

const NO_WIP: WipDraw = { decorations: DecorationSet.empty, shown: new Map(), named: new Set() };

/** Others' work in progress in `doc`: each unit they hold drawn over this
 *  copy's, its text hidden; each they made, under the unit before it. What
 *  arrived since it was last drawn (`shown`, by unit) is washed in the
 *  holder's colour. */
export function wipDecorations(
  doc: PMNode,
  units: WipUnit[],
  peers: readonly SyncPeer[],
  held: ReadonlyMap<string, ClaimHolder>,
  shown: ReadonlyMap<string, string>,
): WipDraw {
  if (units.length === 0) return NO_WIP;
  const index = indexOf(doc);
  const byKey = new Map(keyedUnits(doc).map((unit) => [unit.key, unit]));
  const at: Here = { doc, index, byKey, ends: new Map(), held, shown, next: new Map(), named: new Set() };
  const decorations = [...units]
    .sort((a, b) => a.at - b.at)
    .flatMap((unit) => {
      // This copy says it already: nothing to draw but who's in it.
      const same = byKey.get(index.resolve(unit.key) ?? "");
      if (same) {
        at.ends.set(unit.key, same.to);
        const present = nameIn(at, unit, peers);
        return present.length > 0 ? [Decoration.node(same.from, same.to, presentAttrs(present))] : [];
      }
      const mine = unit.keys.map((key) => byKey.get(index.resolve(key) ?? "")).find((found) => found !== undefined);
      if (mine) return drawOver(at, unit, mine, peers);
      // Made by them, if its claim names nothing it said before; otherwise
      // this copy changed it too, and the merge settles it.
      return unit.keys.length === 1 ? drawNew(at, unit, peers) : [];
    });
  return { decorations: DecorationSet.create(doc, decorations), shown: at.next, named: at.named };
}

/** "Ada is editing this", or her agent. */
export function holderLabel({ peer, agent }: ClaimHolder): string {
  const name = peer.name ?? "Someone";
  return agent ? `${name}'s agent is editing this` : `${name} is editing this`;
}

/** The units others hold in `doc`, drawn: paler, in their colour. */
export function heldDecorations(doc: PMNode, holders: Map<string, ClaimHolder>): DecorationSet {
  if (holders.size === 0) return DecorationSet.empty;
  const decorations = keyedUnits(doc).flatMap(({ from, to, key }) => {
    const holder = holders.get(key);
    if (!holder) return [];
    return [
      Decoration.node(
        from,
        to,
        {
          class: "sync-held",
          style: `--sync-holder:${holder.peer.colour ?? "currentColor"}`,
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
  return new Plugin<DecorationSet>({
    key: held,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        // Others' claims changed, or their text arrived: drawn again.
        if (!tr.getMeta(held) && !(tr.docChanged && !isTyping(tr))) return value.map(tr.mapping, tr.doc);
        return heldDecorations(tr.doc, claims.heldIn(path, indexOf(tr.doc)));
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
          if (!decorations || decorations === held.getState(previous) || !current.hasFocus()) return;
          // Someone took the unit this caret is in: on to just after it.
          const head = current.state.selection.head;
          const [taken] = decorations.find(head, head);
          if (taken) setTimer(() => moveOut(current, taken), 0);
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
 *  it changes, or a write that isn't typing changes what this copy says.
 *  Registered before `peersPlugin`, which reads who it named. */
function wipPlugin(wip: WipView) {
  return new Plugin<WipDraw>({
    key: typing,
    state: {
      init: () => NO_WIP,
      apply: (tr, value) => {
        if (!tr.getMeta(typing) && !(tr.docChanged && !isTyping(tr))) {
          return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
        }
        // Washed: what's new since the last draw.
        return wipDecorations(tr.doc, wip.units(), wip.peers(), wip.held(tr.doc), value.shown);
      },
    },
    props: { decorations: (state) => typing.getState(state)?.decorations },
  });
}

/** Where the others are, a block each, named; and this device's block,
 *  reported. A caret move only arms a timer, so nothing runs per keystroke,
 *  and a move within one block changes nothing that's sent. */
function peersPlugin(path: string, report: (view: EditorView) => void, leave: () => void, setTimer: SetTimer) {
  return new Plugin<DecorationSet>({
    key: here,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value, _, state) => {
        const peers = tr.getMeta(here) as SyncPeer[] | undefined;
        // Who this transaction's draw named on what they're typing.
        return peers ? peerDecorations(tr.doc, path, peers, typing.getState(state)?.named) : value.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => here.getState(state) },
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
   *  off solo, and redraw where the others are, their claims and typing. */
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
    editor.unregisterPlugin(here);
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
    editor.registerPlugin(wipPlugin(wip));
    editor.registerPlugin(peersPlugin(path, report, leave, deps.setTimer));
    editor.registerPlugin(claimsPlugin({ path, claims: deps.claims, setTimer: deps.setTimer }));
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
            .setMeta(here, state.peers)
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
