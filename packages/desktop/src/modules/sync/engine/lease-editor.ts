/**
 * Leased blocks in the editor (MET-273), next to presence's carets: a
 * ProseMirror plugin registered with the presence plugin on a sync
 * workspace's open markdown editors only at the shared level (the same
 * attach manager, `createPresenceEditors`). A regular or solo workspace
 * never loads or registers it.
 *
 * - Draws each lease from the document's channel (`leases`, latest value,
 *   block indexes already mapped onto this clone's head by the worker): a
 *   block another holder leases gets their colour, a "Name is editing"
 *   label (with the agent marker for an agent); a block this device holds
 *   a faint bar in its own colour. Blocks fade in and out as leases come
 *   and go.
 * - Makes blocks others lease read-only: `filterTransaction` refuses a
 *   transaction that changes one, or that inserts, deletes or splits
 *   blocks right next to one (the lease rule's neighbours, `withNeighbours`
 *   in `lease-rules.ts`). Adoptions (remote and agent content applied
 *   through the documents write path) pass: they were merged or gated
 *   already.
 *
 * Main-thread cost: the leased ranges are precomputed when the lease view
 * changes and mapped through each edit; a keystroke costs a position
 * lookup against those few ranges, nothing more.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ADOPTION_TRANSACTION_META } from "@/components/editor/adopt-external-content";
import type { SyncLeaseView } from "../document-channel";

/** A leased block's place in the editor's document. */
export interface LeaseRange {
  from: number;
  to: number;
  view: SyncLeaseView;
}

interface LeasePluginState {
  views: SyncLeaseView[];
  /** Blocks others lease (read-only here), mapped through edits. */
  readOnly: LeaseRange[];
  decorations: DecorationSet;
}

export const leasePluginKey = new PluginKey<LeasePluginState>("syncLeases");

const STYLE_ID = "notefig-sync-lease-styles";
const ROOT_CLASS = "notefig-sync-leases";

/** One small stylesheet, added when the first editor at the shared level
 *  gets the plugin: the fade as leases come and go, and the label. */
function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${ROOT_CLASS} > * { transition: background-color 240ms ease, box-shadow 240ms ease; }
.sync-lease-block { position: relative; box-shadow: inset 3px 0 0 var(--lease-color); background-color: var(--lease-tint); cursor: not-allowed; }
.sync-lease-mine { box-shadow: inset 2px 0 0 var(--lease-color); }
.sync-lease-label { position: absolute; top: 2px; right: 0; display: inline-flex; align-items: center; gap: 3px;
  padding: 0 5px; border-radius: 3px; font: 600 10px/15px var(--font-sans, system-ui); color: #fff;
  background: var(--lease-color); pointer-events: none; user-select: none; white-space: nowrap; z-index: 4;
  animation: notefig-lease-in 240ms ease; }
.sync-lease-label .sync-lease-agent { padding: 0 2px; border-radius: 2px; background: #fff; color: var(--lease-color);
  font-size: 8px; line-height: 11px; }
@keyframes notefig-lease-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
`;
  document.head.appendChild(style);
}

const tint = (color: string, alpha: number) =>
  `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** Where each leased block is in `doc` (one pass over the top level). */
export function leaseRanges(doc: PMNode, views: readonly SyncLeaseView[]): LeaseRange[] {
  const byIndex = new Map(views.map((view) => [view.blockIndex, view]));
  const out: LeaseRange[] = [];
  let pos = 0;
  doc.forEach((node, _offset, index) => {
    const view = byIndex.get(index);
    if (view) out.push({ from: pos, to: pos + node.nodeSize, view });
    pos += node.nodeSize;
  });
  return out;
}

function label(view: SyncLeaseView): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-lease-label";
  el.setAttribute("contenteditable", "false");
  el.dataset.leaseHolder = view.holderId;
  el.style.setProperty("--lease-color", view.color);
  if (view.kind === "agent") {
    const badge = document.createElement("span");
    badge.className = "sync-lease-agent";
    badge.textContent = "AI";
    el.appendChild(badge);
  }
  const who = view.kind === "agent" ? `${view.name} · ${view.harness ?? "agent"}` : view.name;
  el.appendChild(document.createTextNode(`${who} is editing`));
  return el;
}

const titleOf = (view: SyncLeaseView) =>
  view.kind === "agent"
    ? `${view.name}'s ${view.harness ?? "agent"} is editing this block`
    : `${view.name} is editing this block`;

/** The block's tint and bar: the holder's colour, faint when it's ours. */
function blockDecoration(range: LeaseRange): Decoration {
  const { view } = range;
  const color = view.mine ? tint(view.color, 0.45) : view.color;
  return Decoration.node(range.from, range.to, {
    class: view.mine ? "sync-lease-mine" : "sync-lease-block",
    "data-lease-holder": view.holderId,
    style: `--lease-color:${color};--lease-tint:${tint(view.color, 0.07)}`,
    ...(view.mine ? {} : { title: titleOf(view) }),
  });
}

function labelDecoration(doc: PMNode, range: LeaseRange): Decoration {
  const { view } = range;
  const at = doc.nodeAt(range.from)?.isLeaf ? range.from : range.from + 1;
  return Decoration.widget(at, () => label(view), {
    key: `lease:${view.holderId}:${view.name}:${view.color}:${view.kind}`,
    side: -1,
    ignoreSelection: true,
  });
}

/** The decorations for the leased blocks: one label per run of blocks the
 *  same holder (not this device) leases. */
export function leaseDecorations(doc: PMNode, ranges: readonly LeaseRange[]): DecorationSet {
  const decorations: Decoration[] = [];
  ranges.forEach((range, i) => {
    decorations.push(blockDecoration(range));
    const previous = ranges[i - 1];
    const continues = previous?.to === range.from && previous.view.holderId === range.view.holderId;
    if (!range.view.mine && !continues) decorations.push(labelDecoration(doc, range));
  });
  return DecorationSet.create(doc, decorations);
}

/** The top-level block span around `pos` (the position itself between
 *  blocks). */
function blockSpan(doc: PMNode, pos: number): [number, number] {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  return $pos.depth > 0 ? [$pos.before(1), $pos.after(1)] : [pos, pos];
}

/**
 * Whether `tr` changes a read-only block: a change inside one, or a
 * structural change (top-level blocks added or removed) touching one's
 * edge — the neighbours the lease rule asks for.
 */
export function touchesReadOnly(tr: Transaction, doc: PMNode, ranges: readonly LeaseRange[]): boolean {
  const structural = tr.doc.childCount !== doc.childCount;
  let hit = false;
  tr.steps.forEach((step, i) => {
    if (hit) return;
    const back = i === 0 ? null : tr.mapping.slice(0, i).invert();
    step.getMap().forEach((oldStart, oldEnd) => {
      if (hit) return;
      const a = back ? back.map(oldStart, -1) : oldStart;
      const b = back ? back.map(oldEnd, 1) : oldEnd;
      if (structural) {
        const lo = blockSpan(doc, a)[0];
        const hi = blockSpan(doc, b)[1];
        hit = ranges.some((r) => r.from <= hi && r.to >= lo);
      } else {
        hit = ranges.some((r) => (a === b ? r.from < a && a < r.to : r.from < b && r.to > a));
      }
    });
  });
  return hit;
}

/** The selection is inside (or across) a block others hold: typing there
 *  is stopped before the browser touches the DOM. */
function selectionInReadOnly(state: EditorState): boolean {
  const readOnly = leasePluginKey.getState(state)?.readOnly;
  if (!readOnly || readOnly.length === 0) return false;
  const { from, to } = state.selection;
  return readOnly.some((r) => (from === to ? r.from < from && from < r.to : r.from < to && r.to > from));
}

function mapRanges(ranges: readonly LeaseRange[], tr: Transaction): LeaseRange[] {
  return ranges
    .map((range) => ({ ...range, from: tr.mapping.map(range.from, 1), to: tr.mapping.map(range.to, -1) }))
    .filter((range) => range.to > range.from);
}

/** The plugin. */
export function createLeasePlugin(): Plugin<LeasePluginState> {
  ensureStyles();
  return new Plugin<LeasePluginState>({
    key: leasePluginKey,
    state: {
      init: () => ({ views: [], readOnly: [], decorations: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const next = tr.getMeta(leasePluginKey) as SyncLeaseView[] | undefined;
        if (next) {
          const ranges = leaseRanges(state.doc, next);
          return {
            views: next,
            readOnly: ranges.filter((range) => !range.view.mine),
            decorations: leaseDecorations(state.doc, ranges),
          };
        }
        if (!tr.docChanged) return value;
        return {
          views: value.views,
          readOnly: mapRanges(value.readOnly, tr),
          decorations: value.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    filterTransaction(tr, state: EditorState) {
      if (!tr.docChanged || tr.getMeta(ADOPTION_TRANSACTION_META)) return true;
      const readOnly = leasePluginKey.getState(state)?.readOnly;
      if (!readOnly || readOnly.length === 0) return true;
      return !touchesReadOnly(tr, state.doc, readOnly);
    },
    props: {
      decorations: (state) => leasePluginKey.getState(state)?.decorations,
      attributes: { class: ROOT_CLASS },
      // `filterTransaction` keeps the document right; these keep the
      // browser from drawing a refused keystroke into the page first.
      handleTextInput: (view) => selectionInReadOnly(view.state),
      handleDOMEvents: {
        beforeinput: (view, event) => {
          if (!selectionInReadOnly(view.state)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
}
