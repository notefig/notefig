/**
 * Finding code blocks in a document, and whether an edit touched one: what
 * the highlighter, the language picker and diff blocks share to skip their
 * walk on an edit away from every code block. Kept apart from the
 * highlighter so the other two don't load `@pierre/diffs` with it.
 */
import type { Transaction } from "@tiptap/pm/state";
import { StepMap } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";

/** Walk `doc`'s code blocks, never into the text of any other block. */
export function eachCodeBlock(
  doc: PMNode,
  visit: (node: PMNode, pos: number) => void,
): void {
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") visit(node, pos);
    else return !node.isTextblock;
    return false;
  });
}

/** Whether `doc` has a code block anywhere in [from, to]. */
function codeBetween(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === "codeBlock") found = true;
    return !found && !node.isTextblock;
  });
  return found;
}

/** Each transaction's answer: every code-block plugin asks about the same one. */
const touched = new WeakMap<Transaction, boolean>();

/**
 * Whether any step of `tr` changed a code block, made one or unmade one:
 * each changed range is checked in the document before its step and after
 * the whole transaction. A step that changes nothing's position (an attr
 * or mark step: a block's language, say) can't be placed, so it counts.
 */
export function touchesCode(tr: Transaction): boolean {
  let answer = touched.get(tr);
  if (answer === undefined) {
    answer = tr.mapping.maps.some((stepMap, index) => {
      if (stepMap === StepMap.empty) return true;
      const after = tr.mapping.slice(index + 1);
      let hit = false;
      stepMap.forEach((oldFrom, oldTo, newFrom, newTo) => {
        hit ||=
          codeBetween(tr.docs[index], oldFrom, oldTo) ||
          codeBetween(tr.doc, after.map(newFrom, -1), after.map(newTo, 1));
      });
      return hit;
    });
    touched.set(tr, answer);
  }
  return answer;
}
