/**
 * How the document treats a prompt widget (MET-248) — four rules, each
 * read off the widget's capabilities (./machine.ts), never its state:
 *
 * 1. Field: the draft takes typing only when `fieldEditable`. Otherwise
 *    nothing types into it and the caret is never left there.
 * 2. Removal: an edit removes a widget only when it is `removable`. Any
 *    other edit — a range delete, Cmd-A, a cut, typing over, undo, a drag —
 *    still applies, and the widget is put back where it was.
 * 3. Selection: only the keyboard selects a widget (Backspace/Delete from
 *    the neighbouring line, arrows onto a read-only field), never a click.
 *    A selected widget shows a ring, a widget inside a text range a tint;
 *    both show a lock when it can't be removed. A delete on a selected
 *    widget that can't be removed is refused out loud.
 * 4. Escape: what `escape` says (the composer key map and the face's
 *    global hotkey own it).
 *
 * Plus paste: a pasted widget is always a fresh one — never a second
 * widget on another's session.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import { Fragment, Slice as PMSlice } from "@tiptap/pm/model";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { PROMPT_NODE_NAME } from "./node";
import { capabilitiesOf, type WidgetCapabilities } from "./machine";
import type { PromptWidgetsApi } from "./widgets-service";
import {
  newPromptBlobInstanceId,
  promptDraftRange,
  restoreDroppedWidgets,
  selectionDraft,
} from "./doc-helpers";

/** What `node` (a widget) allows now. An id-less widget has no state yet:
 *  it is a fresh composer. */
export function widgetCapabilities(
  prompts: PromptWidgetsApi,
  node: PMNode,
): WidgetCapabilities {
  const blobId = node.attrs.blobId as string | null;
  const state = blobId ? prompts.get(blobId).state : undefined;
  return capabilitiesOf(state ?? { name: "composing", confirmingTrust: false }, {
    summoned: Boolean(node.attrs.summoned),
  });
}

type SelectionState = { selected: string | null };

const interactionsKey = new PluginKey<SelectionState>("promptInteractions");

/** The widget the keyboard selected, if the selection still is it. */
function selectedWidget(
  state: EditorState,
): { node: PMNode; pos: number } | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  if (selection.node.type.name !== PROMPT_NODE_NAME) return null;
  const selected = interactionsKey.getState(state)?.selected ?? null;
  const blobId = selection.node.attrs.blobId as string | null;
  if (!blobId || blobId !== selected) return null;
  return { node: selection.node, pos: selection.from };
}

/** Select the widget at `pos` the way the keyboard does. */
function selectWidget(tr: Transaction, pos: number): Transaction {
  const node = tr.doc.nodeAt(pos);
  return tr
    .setSelection(NodeSelection.create(tr.doc, pos))
    .setMeta(interactionsKey, {
      selected: (node?.attrs.blobId as string | null) ?? null,
    });
}

/** Caret at the end of the widget's draft. */
function enterDraft(editor: Editor, blobId: string): boolean {
  const range = promptDraftRange(editor.state.doc, blobId);
  if (!range) return false;
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, range.to),
    ),
  );
  return true;
}

/**
 * Backspace with the caret at the start of the line right after a widget:
 * select the widget (an empty line goes, as it would have). Never lands the
 * caret inside the draft, and never deletes the widget in one press.
 */
export function backspaceIntoWidget(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty || selectionDraft(state)) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== 0) return false;
  const before = state.doc.resolve($from.before());
  const widget = before.nodeBefore;
  if (widget?.type.name !== PROMPT_NODE_NAME) return false;
  const widgetPos = before.pos - widget.nodeSize;
  const tr = state.tr;
  if ($from.parent.content.size === 0) tr.delete($from.before(), $from.after());
  editor.view.dispatch(selectWidget(tr, widgetPos));
  return true;
}

/** Delete with the caret at the end of the line right before a widget:
 *  select the widget. */
export function deleteIntoWidget(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty || selectionDraft(state)) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const after = state.doc.resolve($from.after());
  if (after.nodeAfter?.type.name !== PROMPT_NODE_NAME) return false;
  editor.view.dispatch(selectWidget(state.tr, after.pos));
  return true;
}

/**
 * Backspace or Delete on a selected widget: deleted when it is removable
 * (left to the default delete), otherwise refused — the key is consumed and
 * the widget says why.
 */
export function deleteSelectedWidget(
  editor: Editor,
  prompts: PromptWidgetsApi,
): boolean {
  const selected = selectedWidget(editor.state);
  if (!selected) return false;
  if (widgetCapabilities(prompts, selected.node).removable) return false;
  const blobId = selected.node.attrs.blobId as string;
  prompts.refuseRemoval(blobId);
  return true;
}

/** Enter on a selected widget: into its field when it takes typing. */
export function enterSelectedWidget(
  editor: Editor,
  prompts: PromptWidgetsApi,
): boolean {
  const selected = selectedWidget(editor.state);
  if (!selected) return false;
  if (widgetCapabilities(prompts, selected.node).fieldEditable) {
    enterDraft(editor, selected.node.attrs.blobId as string);
  }
  return true;
}

/** Cmd-A in a draft selects the draft first; a second press (the draft
 *  already selected) falls through to the whole document. */
export function selectAllInDraft(editor: Editor): boolean {
  const draft = selectionDraft(editor.state);
  if (!draft) return false;
  const { from, to } = editor.state.selection;
  if (from === draft.from && to === draft.to) return false;
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, draft.from, draft.to),
    ),
  );
  return true;
}

/**
 * Where an arrow key lands next to a widget whose field doesn't take
 * typing: the widget, selected, instead of its draft. Null when the field
 * is editable (the caller enters it as before).
 */
export function arrowOntoReadOnlyWidget(
  state: EditorState,
  prompts: PromptWidgetsApi,
  widgetPos: number,
): Transaction | null {
  const node = state.doc.nodeAt(widgetPos);
  if (!node || node.type.name !== PROMPT_NODE_NAME) return null;
  if (widgetCapabilities(prompts, node).fieldEditable) return null;
  return selectWidget(state.tr, widgetPos);
}

/**
 * Put back every widget the edit removed that can't be removed now: the
 * rest of the edit stands. Runs ahead of the empty-document keeper, so a
 * document cleared around a working widget gets that widget back, not a
 * fresh composer beside it.
 */
export function restoreKeptWidgetsTr(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  prompts: PromptWidgetsApi,
): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged)) return null;
  const mapping = new Mapping();
  for (const tr of transactions) mapping.appendMapping(tr.mapping);
  const tr = newState.tr;
  const restored = restoreDroppedWidgets(
    oldState.doc,
    tr,
    (pos) => mapping.map(pos, -1),
    { keep: (node) => !widgetCapabilities(prompts, node).removable },
  );
  return restored > 0 ? tr : null;
}

/** A pasted widget as a fresh composer: a new identity, no session. */
function freshWidgets(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === PROMPT_NODE_NAME) {
      nodes.push(
        node.type.create(
          { ...node.attrs, blobId: newPromptBlobInstanceId(), taskId: null },
          node.content,
          node.marks,
        ),
      );
    } else {
      nodes.push(node.copy(freshWidgets(node.content)));
    }
  });
  return Fragment.from(nodes);
}

function rangeCovers(state: EditorState, from: number, to: number): boolean {
  const { selection } = state;
  if (selection.empty || selection instanceof NodeSelection) return false;
  if (selection instanceof AllSelection) return true;
  return selection.from <= from && selection.to >= to;
}

/** The ring, the tint, and the refusal — as attributes on each widget's
 *  node view; the CSS (tiptap.css) and the face draw them. */
function widgetDecorations(state: EditorState): DecorationSet {
  const selected = selectedWidget(state);
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    const end = pos + node.nodeSize;
    if (selected?.pos === pos) {
      decorations.push(
        Decoration.node(pos, end, { "data-widget-selected": "" }),
      );
    } else if (rangeCovers(state, pos, end)) {
      decorations.push(
        Decoration.node(pos, end, { "data-widget-in-range": "" }),
      );
    }
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

/** The widget rules that ride the editor's plugins rather than its key
 *  map: the selection state and its look, clicks, typing, and paste. */
export function promptInteractionsPlugin(prompts: PromptWidgetsApi): Plugin {
  return new Plugin<SelectionState>({
    key: interactionsKey,
    state: {
      init: () => ({ selected: null }),
      apply(tr, value, _old, newState) {
        const meta = tr.getMeta(interactionsKey) as SelectionState | undefined;
        if (meta) return meta;
        if (!value.selected) return value;
        // Kept only while the selection still is that widget.
        const { selection } = newState;
        return selection instanceof NodeSelection &&
          selection.node.attrs.blobId === value.selected
          ? value
          : { selected: null };
      },
    },
    props: {
      decorations: widgetDecorations,
      // A click on the card never selects it: not a Cmd/Ctrl-click, not a
      // triple-click. Clicks inside the draft place a caret as ever.
      handleClickOn: (_view, _pos, node, _nodePos, _event, direct) =>
        direct && node.type.name === PROMPT_NODE_NAME,
      handleTripleClickOn: (_view, _pos, node, _nodePos, _event, direct) =>
        direct && node.type.name === PROMPT_NODE_NAME,
      handleTextInput(view, _from, _to, text) {
        // A read-only field takes no typing (the belt — the caret isn't
        // left there).
        const draft = selectionDraft(view.state);
        if (draft) {
          const { state } = prompts.get(draft.blobId);
          return !capabilitiesOf(state, { summoned: false }).fieldEditable;
        }
        // Typing on a selected widget goes into its field — never replaces
        // the widget, which is what ProseMirror would do to a selected node.
        const selected = selectedWidget(view.state);
        if (!selected) return false;
        if (!widgetCapabilities(prompts, selected.node).fieldEditable) return true;
        const range = promptDraftRange(
          view.state.doc,
          selected.node.attrs.blobId as string,
        );
        if (!range) return true;
        const tr = view.state.tr.insertText(text, range.to);
        tr.setSelection(TextSelection.create(tr.doc, range.to + text.length));
        view.dispatch(tr);
        return true;
      },
      transformPasted: (slice: Slice) =>
        new PMSlice(freshWidgets(slice.content), slice.openStart, slice.openEnd),
    },
  });
}
