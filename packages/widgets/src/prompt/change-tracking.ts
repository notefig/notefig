/**
 * The editor half of prompt change tracking: records the spans a round's
 * transactions touched and keeps them pointing at the same content as the
 * document moves on — the way a comment anchor follows its text.
 *
 * - A transaction carrying PROMPT_CHANGE_META is a round's edit: every
 *   range its steps touched becomes a change of that round.
 * - Every other document change only maps what is recorded. A span whose
 *   content is deleted or overwritten collapses and is dropped — once the
 *   text is gone there is nothing left to review.
 * - Changes are text: a span is narrowed to the text it covers in each
 *   block, so rewriting a paragraph the round added clears it.
 * - Prompt widgets themselves never count. A rewrite that drops a widget's
 *   marker gets the widget re-inserted in the same transaction (the app's
 *   adoption guarantee); that round trip is not a change to the document.
 *
 * The plugin state is the truth while the editor lives; the view mirrors it
 * into ./change-store.ts and reloads from there when the store changes
 * underneath it (a widget binding a new turn discards its changes).
 */
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Mapping } from "@tiptap/pm/transform";
import { AddMarkStep, RemoveMarkStep } from "@tiptap/pm/transform";
import { UI_ONLY_TRANSACTION_META } from "../define-widget";
import { PROMPT_NODE_NAME } from "./node";
import {
  PROMPT_CHANGE_META,
  getDocumentPromptChanges,
  setDocumentPromptChanges,
  subscribePromptChanges,
  type PromptChange,
  type PromptChangeAttribution,
} from "./change-store";

export const promptChangesKey = new PluginKey<readonly PromptChange[]>(
  "promptChanges",
);

const RELOAD_META = "reload";

/** The changes the editor state currently holds (empty without the plugin). */
export function promptChangesOf(state: EditorState): readonly PromptChange[] {
  return promptChangesKey.getState(state) ?? [];
}

type Span = { from: number; to: number };

/** Every span the transaction's steps touched, in final-document positions. */
export function touchedSpans(tr: Transaction): Span[] {
  const spans: Span[] = [];
  tr.steps.forEach((step, index) => {
    const later = tr.mapping.slice(index + 1);
    let mapped = false;
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      mapped = true;
      spans.push({ from: later.map(newStart, -1), to: later.map(newEnd, 1) });
    });
    // Mark steps replace nothing, so their map is empty — the span is on
    // the step itself.
    if (
      !mapped &&
      (step instanceof AddMarkStep || step instanceof RemoveMarkStep)
    ) {
      spans.push({ from: later.map(step.from, 1), to: later.map(step.to, -1) });
    }
  });
  return spans;
}

/** Sorted, with overlapping and touching spans joined. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** Cut every prompt widget's span out of `spans` (see the module docs). */
function withoutWidgets(spans: Span[], doc: PMNode): Span[] {
  const widgets: Span[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    widgets.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  let result = spans;
  for (const widget of widgets) {
    result = result.flatMap((span) => {
      if (span.to < widget.from || span.from > widget.to) return [span];
      const pieces: Span[] = [];
      if (span.from < widget.from) pieces.push({ from: span.from, to: widget.from });
      if (span.to > widget.to) pieces.push({ from: widget.to, to: span.to });
      return pieces;
    });
  }
  return result;
}

/**
 * Narrow spans to the text they cover, one span per textblock. A round that
 * inserts a paragraph touched the paragraph node too, but what there is to
 * review is its text: kept at node level, the span would outlive the user
 * rewriting every word of it. A span with no text in it (an image, an
 * emptied block) is kept as a point — something changed there.
 */
function toTextSpans(spans: Span[], doc: PMNode): Span[] {
  return spans.flatMap((span) => {
    if (span.from === span.to) return [span];
    const pieces: Span[] = [];
    doc.nodesBetween(span.from, span.to, (node, pos) => {
      if (!node.isTextblock) return true;
      const from = Math.max(span.from, pos + 1);
      const to = Math.min(span.to, pos + 1 + node.content.size);
      if (to > from) pieces.push({ from, to });
      return false;
    });
    return pieces.length > 0 ? pieces : [{ from: span.from, to: span.from }];
  });
}

/**
 * Move a change through a transaction. A replaced edge moves past the
 * replacement rather than taking it in — ProseMirror maps a position at
 * the start of a replaced range to its start whatever the bias, which would
 * hand the user's rewrite to the round. Fully replaced, the change is gone.
 */
function mapChange(change: PromptChange, mapping: Mapping): PromptChange | null {
  let { from, to } = change;
  for (const map of mapping.maps) {
    if (from === to) {
      const point = map.mapResult(from, 1);
      if (point.deleted) return null;
      from = to = point.pos;
      continue;
    }
    // Inclusive of neither edge: typing next to a change is not part of it.
    let nextFrom = map.map(from, 1);
    let nextTo = map.map(to, -1);
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (oldStart <= from && oldEnd > from) nextFrom = Math.max(nextFrom, newEnd);
      if (oldStart < to && oldEnd >= to) nextTo = Math.min(nextTo, newStart);
    });
    if (nextTo <= nextFrom) return null;
    from = nextFrom;
    to = nextTo;
  }
  return { ...change, from, to };
}

function recordRound(
  changes: readonly PromptChange[],
  tr: Transaction,
  round: PromptChangeAttribution,
): PromptChange[] {
  const own = changes.filter((change) => change.blobId === round.blobId);
  const others = changes.filter((change) => change.blobId !== round.blobId);
  const spans = toTextSpans(
    withoutWidgets(mergeSpans([...own, ...touchedSpans(tr)]), tr.doc),
    tr.doc,
  );
  return [
    ...others,
    ...spans.map((span) => ({ ...round, from: span.from, to: span.to })),
  ];
}

/** Stored changes that still fit the document (a recreated editor). */
function fitToDoc(
  changes: readonly PromptChange[],
  doc: PMNode,
): readonly PromptChange[] {
  const size = doc.content.size;
  return changes.every((change) => change.to <= size)
    ? changes
    : changes.filter((change) => change.to <= size);
}

export function applyPromptChanges(
  changes: readonly PromptChange[],
  tr: Transaction,
): readonly PromptChange[] {
  let next = changes;
  if (tr.docChanged && next.length > 0) {
    const mapped = next
      .map((change) => mapChange(change, tr.mapping))
      .filter((change): change is PromptChange => change !== null);
    // Keep the identity when nothing moved (typing after the last change):
    // the view mirrors every new array into the store.
    const moved =
      mapped.length !== next.length ||
      mapped.some(
        (change, i) => change.from !== next[i].from || change.to !== next[i].to,
      );
    if (moved) next = mapped;
  }
  const round = tr.getMeta(PROMPT_CHANGE_META) as
    | PromptChangeAttribution
    | undefined;
  return round && tr.docChanged ? recordRound(next, tr, round) : next;
}

export function promptChangeTrackingPlugin(documentPath: string): Plugin {
  return new Plugin<readonly PromptChange[]>({
    key: promptChangesKey,
    state: {
      init: (_config, state) =>
        fitToDoc(getDocumentPromptChanges(documentPath), state.doc),
      apply(tr, changes, _oldState, newState) {
        if (tr.getMeta(promptChangesKey) === RELOAD_META) {
          return fitToDoc(getDocumentPromptChanges(documentPath), newState.doc);
        }
        return applyPromptChanges(changes, tr);
      },
    },
    view(view) {
      const unsubscribe = subscribePromptChanges(() => {
        const stored = getDocumentPromptChanges(documentPath);
        if (stored === promptChangesOf(view.state) || view.isDestroyed) return;
        view.dispatch(
          view.state.tr
            .setMeta(promptChangesKey, RELOAD_META)
            .setMeta(UI_ONLY_TRANSACTION_META, true)
            .setMeta("addToHistory", false),
        );
      });
      return {
        update(updated, previous) {
          const changes = promptChangesOf(updated.state);
          if (changes !== promptChangesOf(previous)) {
            setDocumentPromptChanges(documentPath, changes);
          }
        },
        destroy: unsubscribe,
      };
    },
  });
}
