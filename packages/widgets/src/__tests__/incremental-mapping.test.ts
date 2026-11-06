import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { findWrapping, liftTarget } from "@tiptap/pm/transform";
import { codeLanguagePicker } from "../code-language";
import { codeDiff } from "../diff-block/extension";
import { deriveMinimapEntries, shiftMinimapEntries } from "../minimap/contract";
import { AiPromptNodeBase, PromptDraftNodeBase } from "../prompt/node";
import { promptMentionNode } from "../prompt/composer/mention-node";
import { promptMinimapSource } from "../prompt/minimap";
import { restoreKeptWidgetsTr } from "../prompt/interactions";
import { nodeIndexPlugin } from "../node-index";
import { testPrompts } from "../testing/test-prompts";
import type { PromptWidgetsApi } from "../prompt/widgets-service";

// The plugins that skip their document walk on an edit away from what they
// track (the language picker, diff blocks, the minimap, the kept-widget
// restore) against a full recompute, over random edits: typing, deletes
// across blocks, block type and attr changes, wrap/lift, pastes, marks,
// splits and undos. Any divergence is a mapping bug.

const schema = getSchema([
  StarterKit.configure({ codeBlock: false }),
  CodeBlock.extend({
    addAttributes() {
      return { ...this.parent?.(), diff: { default: false } };
    },
  }),
  AiPromptNodeBase,
  PromptDraftNodeBase,
  promptMentionNode(),
]);
const nodes = schema.nodes;
const sources = { aiPrompt: promptMinimapSource(testPrompts()) };
// Every widget is running, so the restore keeps all of them.
const running = {
  get: () => ({ state: { name: "working", turn: "running" } }),
} as unknown as PromptWidgetsApi;

const DIFF = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
let widgetId = 0;
const paragraph = (text: string) =>
  nodes.paragraph.create(null, text ? schema.text(text) : null);
const code = (text: string, language: string | null, diff = false) =>
  nodes.codeBlock.create({ language, diff }, text ? schema.text(text) : null);
const widget = (draft = "") =>
  nodes.aiPrompt.create(
    { blobId: `b${widgetId++}` },
    nodes.promptDraft.create(null, draft ? schema.text(draft) : null),
  );

const startDoc = () =>
  nodes.doc.create(null, [
    paragraph("hello"),
    code("x = 1", "js"),
    paragraph("mid"),
    code(DIFF, "diff", true),
    widget("d"),
    nodes.blockquote.create(null, [paragraph("q"), code("y", "py")]),
    paragraph("end"),
  ]);

/** A seeded generator, so a failure replays. */
function random(seed: number) {
  return (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
}

function textPositions(doc: PMNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    for (let i = 0; i <= node.content.size; i++) positions.push(pos + 1 + i);
  });
  return positions;
}

function topLevelBoundaries(doc: PMNode): number[] {
  const positions = [0];
  doc.forEach((child, offset) => positions.push(offset + child.nodeSize));
  return positions;
}

function codeBlockStarts(doc: PMNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === nodes.codeBlock) positions.push(pos);
  });
  return positions;
}

/** What an edit draws on: the state's doc and positions, and the dice. */
interface EditContext {
  doc: PMNode;
  tr: Transaction;
  history: Transaction[];
  text: number[];
  pick<T>(items: T[]): T;
  coin(): boolean;
}

/** Two positions drawn from `a` and `b`, in order. */
const span = (c: EditContext, a: number[], b: number[]) => {
  const [x, y] = [c.pick(a), c.pick(b)];
  return [Math.min(x, y), Math.max(x, y)] as const;
};

/** Each kind of edit; false when the one drawn can't apply here. */
const EDITS: ((c: EditContext) => boolean | void)[] = [
  (c) => void c.tr.insertText("ab", c.pick(c.text)),
  (c) => {
    const [from, to] = span(c, c.text, c.text);
    c.tr.setSelection(TextSelection.create(c.doc, from, to)).deleteSelection();
  },
  (c) => {
    const $at = c.doc.resolve(c.pick(c.text));
    c.tr.setBlockType($at.before(), $at.after(), nodes.codeBlock, { language: "rb" });
  },
  (c) => {
    const $at = c.doc.resolve(c.pick(c.text));
    c.tr.setBlockType($at.before(), $at.after(), nodes.paragraph);
  },
  (c) => {
    const starts = codeBlockStarts(c.doc);
    if (!starts.length) return false;
    const at = c.pick(starts);
    c.tr.setNodeMarkup(at, undefined, {
      ...c.doc.nodeAt(at)!.attrs,
      language: c.pick(["js", "diff", null]),
      diff: c.coin(),
    });
  },
  // An attr step: maps no position at all.
  (c) => {
    const starts = codeBlockStarts(c.doc);
    if (!starts.length) return false;
    c.tr.setNodeAttribute(c.pick(starts), "language", c.pick(["js", "diff", null]));
  },
  (c) => {
    const range = c.doc.resolve(c.pick(c.text)).blockRange();
    const wrapping = range && findWrapping(range, nodes.blockquote);
    if (!range || !wrapping) return false;
    c.tr.wrap(range, wrapping);
  },
  (c) => {
    const range = c.doc.resolve(c.pick(c.text)).blockRange();
    const target = range && liftTarget(range);
    if (!range || target == null) return false;
    c.tr.lift(range, target);
  },
  (c) =>
    void c.tr.insert(
      c.pick(topLevelBoundaries(c.doc)),
      c.pick([code(DIFF, "diff", true), code("z", "go"), paragraph("new"), widget()]),
    ),
  // A paste of whatever lies between two positions.
  (c) => {
    const [from, to] = span(c, c.text, c.text);
    const at = c.pick(c.text);
    c.tr.replace(at, at, c.doc.slice(from, to));
  },
  (c) => {
    const [from, to] = span(c, c.text, c.text);
    c.tr.addMark(from, to, schema.marks.bold.create());
  },
  // Undo the last edit, when it is still the last thing that happened.
  (c) => {
    const last = c.history.pop();
    if (!last || !last.doc.eq(c.doc)) return false;
    for (let i = last.steps.length - 1; i >= 0; i--) {
      c.tr.step(last.steps[i].invert(last.docs[i]));
    }
  },
  (c) => void c.tr.split(c.pick(c.text)),
  (c) => {
    const boundaries = topLevelBoundaries(c.doc);
    c.tr.delete(...span(c, boundaries, boundaries));
  },
  (c) => void c.tr.delete(...span(c, topLevelBoundaries(c.doc), c.text)),
];

/** A random edit of `state`'s doc, or null when the one drawn can't apply. */
function randomEdit(
  state: EditorState,
  history: Transaction[],
  rnd: (n: number) => number,
): Transaction | null {
  const pick = <T>(items: T[]) => items[rnd(items.length)];
  const context: EditContext = {
    doc: state.doc,
    tr: state.tr,
    history,
    text: textPositions(state.doc),
    pick,
    coin: () => rnd(2) === 0,
  };
  try {
    if (pick(EDITS)(context) === false) return null;
  } catch {
    return null; // an edit the schema refuses here
  }
  return context.tr.docChanged ? context.tr : null;
}

const widgetIds = (doc: PMNode) => {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type === nodes.aiPrompt) ids.push(node.attrs.blobId);
  });
  return ids;
};

const picker = codeLanguagePicker();
const diff = codeDiff({});
const index = nodeIndexPlugin(new Set([nodes.aiPrompt.name]));

/** Where each plugin's mapped state after `tr` differs from a fresh one. */
function divergences(before: EditorState, tr: Transaction, after: EditorState): string[] {
  const fresh = EditorState.create({ doc: after.doc, plugins: [index, picker, diff] });
  const found: string[] = [];

  const pickers = (s: EditorState) =>
    picker
      .getState(s)!
      .find()
      .map((d: { from: number; spec: { key?: string } }) => `${d.from}:${d.spec.key}`)
      .join(",");
  if (pickers(after) !== pickers(fresh)) found.push("picker");

  type Block = { from: number; to: number; node: PMNode };
  const blocks = (s: EditorState): readonly Block[] => diff.getState(s)!.blocks;
  const freshBlocks = blocks(fresh);
  const sameBlocks =
    blocks(after).length === freshBlocks.length &&
    blocks(after).every(
      (b, i) => b.from === freshBlocks[i].from && b.to === freshBlocks[i].to && b.node === freshBlocks[i].node,
    );
  if (!sameBlocks) found.push("diff blocks");

  const shifted = shiftMinimapEntries(before.doc, after.doc, deriveMinimapEntries(before.doc, sources), sources);
  if (shifted && JSON.stringify(shifted) !== JSON.stringify(deriveMinimapEntries(after.doc, sources))) {
    found.push("minimap");
  }

  const kept = new Set(widgetIds(after.doc));
  const dropped = widgetIds(before.doc).some((id) => !kept.has(id));
  if (dropped && !restoreKeptWidgetsTr([tr], before, after, running)) {
    found.push("kept-widget restore");
  }
  return found;
}

describe("incremental plugin state against a full recompute", () => {
  it("stays equal over random edits", () => {
    const failures: string[] = [];
    for (let run = 0; run < 120 && failures.length < 5; run++) {
      const rnd = random(run + 1);
      let state = EditorState.create({ doc: startDoc(), plugins: [index, picker, diff] });
      const history: Transaction[] = [];
      for (let step = 0; step < 25; step++) {
        const tr = randomEdit(state, history, rnd);
        if (!tr) continue;
        const before = state;
        state = state.apply(tr);
        history.push(tr);
        const steps = tr.steps.map((s) => s.constructor.name).join(", ");
        for (const what of divergences(before, tr, state)) {
          failures.push(`${what}: run ${run} step ${step} (${steps})`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
