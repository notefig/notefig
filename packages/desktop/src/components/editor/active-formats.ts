/**
 * `editor.isActive`, for the many questions the toolbar and the bubble
 * menus ask of one selection. Tiptap answers each by walking the selected
 * range; they ask ~17 per transaction, which over a select-all of a long
 * document is ~10 ms a keystroke. Here a range is walked once per editor
 * state, and every question reads that walk — by Tiptap's own rules
 * (`isNodeActive`, `isMarkActive`), so the answers are the same.
 */
import {
  getSchemaTypeNameByName,
  isActive as tiptapIsActive,
  objectIncludes,
} from "@tiptap/core";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

type Attrs = Record<string, unknown>;

/** A node the walk met, and how much of the selection it spans. */
interface Span {
  node: PMNode;
  parent: PMNode | null;
  length: number;
}

/** What a range's walk met: the nodes isNodeActive counts, those
 *  isMarkActive does, and the answers given so far. */
interface Walk {
  blocks: Span[];
  inline: Span[];
  answers: Map<string, boolean>;
}

const walks = new WeakMap<EditorState, Walk>();

function walk(state: EditorState): Walk {
  let found = walks.get(state);
  if (found) return found;
  const { from, to } = state.selection;
  const blocks: Span[] = [];
  const inline: Span[] = [];
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    const length = Math.min(to, pos + node.nodeSize) - Math.max(from, pos);
    if (!node.isText) blocks.push({ node, parent, length });
    if (node.isText || node.marks.length) inline.push({ node, parent, length });
  });
  found = { blocks, inline, answers: new Map() };
  walks.set(state, found);
  return found;
}

/** isNodeActive over a range. */
function nodeActive(state: EditorState, name: string, attrs: Attrs): boolean {
  const { from, to } = state.selection;
  let covered = 0;
  for (const { node, length } of walk(state).blocks) {
    if (node.type.name !== name) continue;
    if (objectIncludes(node.attrs, attrs, { strict: false })) covered += length;
  }
  return covered >= to - from;
}

/** Whether isMarkActive's walk for `type` skips `node`: inside (or being)
 *  a textblock that doesn't allow the mark. */
function skipsFor(type: MarkType, { node, parent }: Span): boolean {
  if (node.inlineContent && !node.type.allowsMarkType(type)) return true;
  return Boolean(parent?.inlineContent && !parent.type.allowsMarkType(type));
}

/** isMarkActive over a range. */
function markActive(state: EditorState, name: string, attrs: Attrs): boolean {
  const type = state.schema.marks[name];
  let selected = 0;
  let matched = 0;
  let excluded = 0;
  for (const span of walk(state).inline) {
    if (skipsFor(type, span)) continue;
    const { node, length } = span;
    selected += length;
    for (const mark of node.marks) {
      if (mark.type.name === name) {
        if (objectIncludes(mark.attrs, attrs, { strict: false }))
          matched += length;
      } else if (mark.type.excludes(type)) excluded += length;
    }
  }
  if (selected === 0) return false;
  return (matched > 0 ? matched + excluded : matched) >= selected;
}

/** `editor.isActive(name, attrs)` for the editor whose state is `state`. */
export function isActiveIn(
  state: EditorState,
  name: string,
  attrs: Attrs = {},
): boolean {
  const { selection } = state;
  // A caret's answer needs no walk; several ranges (a cell selection) are
  // rare enough to ask Tiptap.
  if (selection.empty || selection.ranges.length !== 1)
    return tiptapIsActive(state, name, attrs);
  const { answers } = walk(state);
  const question = `${name} ${JSON.stringify(attrs)}`;
  let answer = answers.get(question);
  if (answer === undefined) {
    const kind = getSchemaTypeNameByName(name, state.schema);
    answer =
      kind === "node"
        ? nodeActive(state, name, attrs)
        : kind === "mark" && markActive(state, name, attrs);
    answers.set(question, answer);
  }
  return answer;
}
