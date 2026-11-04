/**
 * Renderer half of the process block (schema + markdown in node.ts): the
 * registered command, whole, over the tail of its process's output, with a
 * play button once the stream is gone and a stop button while it lasts. The state is the process blocks service's
 * (./process-blocks.ts), handed in with the document's other widget
 * services. A block whose id the app never minted is dropped here, the one
 * place every document passes through with the service in hand.
 *
 * It wears the prompt widget's frame — settled, or raised while its
 * process runs — and its control is the diff card's kind: an icon with a
 * tooltip, and `1` while the block is selected.
 *
 * To the selection it is what a prompt widget and a diff block are
 * (prompt/interactions.ts, diff-block/extension.ts): only the keyboard
 * selects it (an arrow onto it, Backspace or Delete beside it), never a
 * click, which is the reader's, to select the output; selected, or inside
 * a selection that takes it in, it wears the selection's tint
 * (tiptap.css), and typing never replaces it.
 */
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  Selection,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Slice } from "@tiptap/pm/model";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Play, Square, SquareTerminal } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import type { WidgetRendererOptions } from "../define-widget";
import { ProcessNodeBase } from "./node";
import { inertProcessBlocks, type ProcessBlocksApi } from "./process-blocks";

/** What the block reads of the document's widget options. */
type ProcessNodeOptions = Pick<WidgetRendererOptions, "processes">;

function ProcessNodeView({ node, extension, selected }: NodeViewProps) {
  const { processes } = extension.options as ProcessNodeOptions;
  const blobId = node.attrs.blobId as string;
  const block = useSyncExternalStore(
    (onChange) => processes.subscribe(blobId, onChange),
    () => processes.get(blobId),
  );
  // Unknown until the registry loads; a foreign id is about to be dropped.
  if (!block.command) return null;

  return (
    <NodeViewWrapper
      data-type="process"
      contentEditable={false}
      className={cn(
        "not-prose my-1 overflow-hidden rounded-lg border text-xs",
        block.running
          ? "border-border bg-card shadow-lg shadow-black/5 dark:shadow-black/40"
          : "border-border/60 bg-card/80",
      )}
    >
      {/* One line; the box below opens with the command whole, so what
          the play button runs is never cut off. */}
      <div className="flex items-center gap-1.5 border-b border-border/60 py-1 pl-2.5 pr-1 text-[0.6875rem] text-muted-foreground">
        <SquareTerminal className="size-3 shrink-0" />
        <code
          title={block.command}
          className="min-w-0 flex-1 select-text truncate text-foreground"
        >
          {block.command}
        </code>
        <ControlButton
          running={block.running}
          selected={selected}
          onPress={() =>
            block.running ? processes.stop(blobId) : processes.run(blobId)
          }
        />
      </div>
      <Tail
        command={block.command}
        lines={block.lines}
        dropped={block.dropped}
      />
    </NodeViewWrapper>
  );
}

/** The block's one control: run when its stream is gone, stop while it
 *  runs. */
function ControlButton({
  running,
  selected,
  onPress,
}: {
  running: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const label = t(running ? "processBlockStop" : "processBlockRun");
  const Icon = running ? Square : Play;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-keyshortcuts="1"
      className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
      onClick={onPress}
    >
      <Icon className="size-3" />
      {selected && <kbd className="font-sans text-[0.5625rem]">1</kbd>}
    </button>
  );
}

/** The output, opening with the command as a terminal echoes it, whole and
 *  wrapped, and following its newest line unless the user has scrolled up
 *  to read; what scrolled off the service's buffer is counted after the
 *  command. One height, empty or full, so the block never grows under the
 *  reader as lines come in. */
function Tail({
  command,
  lines,
  dropped,
}: {
  command: string;
  lines: readonly string[];
  dropped: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    // A new run starts empty, and is followed again: the box outlives the
    // run the reader scrolled up in.
    if (lines.length === 0) following.current = true;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="h-48 select-text overflow-auto px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground"
    >
      <div
        data-command
        className="whitespace-pre-wrap break-words text-foreground"
      >
        $ {command}
      </div>
      {dropped > 0 && (
        <div className="italic text-muted-foreground/60">
          {t("processBlockDropped", { count: dropped })}
        </div>
      )}
      <span data-output>{lines.join("\n")}</span>
    </pre>
  );
}

/**
 * Backspace at the start of the line right after a block, or Delete at the
 * end of the line right before one: the block, selected, as beside a
 * prompt widget or a diff block — never deleted in one press. An empty
 * line goes, as it would have.
 */
function selectBeside(editor: Editor, name: string, back: boolean) {
  const { state } = editor;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.depth === 0 || !$from.parent.isTextblock) return false;
  if ($from.parentOffset !== (back ? 0 : $from.parent.content.size))
    return false;
  const $edge = state.doc.resolve(back ? $from.before() : $from.after());
  const block = back ? $edge.nodeBefore : $edge.nodeAfter;
  if (block?.type.name !== name) return false;
  const tr = state.tr;
  if (back && $from.parent.content.size === 0)
    tr.delete($from.before(), $from.after());
  const at = back ? $edge.pos - block.nodeSize : $edge.pos;
  editor.view.dispatch(
    tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView(),
  );
  return true;
}

/** The vertical arrows, as a direction through the document. */
const VERTICAL: Record<string, -1 | 1> = { ArrowUp: -1, ArrowDown: 1 };

/** Did any of these transactions bring in a block of this type? */
function insertsBlock(
  transactions: readonly { steps: readonly object[] }[],
  name: string,
) {
  return transactions.some((tr) =>
    tr.steps.some((step) => {
      let found = false;
      (step as { slice?: Slice }).slice?.content.descendants((node) => {
        found ||= node.type.name === name;
        return !found;
      });
      return found;
    }),
  );
}

/** The tint: on each block the selection takes in, or the block it is.
 *  An empty selection, every caret move, looks at nothing. */
function selectedDecorations(state: EditorState, name: string) {
  const { selection, doc } = state;
  if (selection.empty) return DecorationSet.empty;
  const taken: Decoration[] = [];
  const mark = (pos: number, size: number) =>
    taken.push(
      Decoration.node(pos, pos + size, { "data-widget-selected": "" }),
    );
  if (selection instanceof NodeSelection) {
    if (selection.node.type.name === name)
      mark(selection.from, selection.node.nodeSize);
  } else {
    const all = selection instanceof AllSelection;
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name !== name) return !node.isTextblock;
      if (all || (selection.from <= pos && selection.to >= pos + node.nodeSize))
        mark(pos, node.nodeSize);
      return false;
    });
  }
  return DecorationSet.create(doc, taken);
}

/** Take out every block whose id the app never minted. Out of history:
 *  undone, it would only be dropped again. */
function dropForeignTr(
  state: EditorState,
  name: string,
  processes: ProcessBlocksApi,
) {
  const tr = state.tr.setMeta("addToHistory", false);
  state.doc.descendants((node, pos) => {
    if (
      node.type.name === name &&
      processes.get(node.attrs.blobId).command === null
    ) {
      tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
    }
    return !node.isTextblock;
  });
  return tr.docChanged ? tr : null;
}

export const ProcessNode = ProcessNodeBase.extend<ProcessNodeOptions>({
  addOptions() {
    return { processes: inertProcessBlocks() };
  },

  addProseMirrorPlugins() {
    const { name } = this;
    const { processes } = this.options;
    // Whatever brought the block in (the file as it loaded, an agent's
    // write adopted, a paste), a foreign one goes, and the next save takes
    // it out of the file. Never before the registry has loaded: until then
    // no id is known to be foreign, and dropping on a guess would cut real
    // blocks out of the file. The view's pass is the one that runs then.
    return [
      new Plugin({
        appendTransaction: (transactions, _old, state) =>
          insertsBlock(transactions, name)
            ? dropForeignTr(state, name, processes)
            : null,
        props: {
          decorations: (state) => selectedDecorations(state, name),
          // A click on the block never selects it, as on a prompt widget.
          handleClickOn: (_view, _pos, node, _nodePos, _event, direct) =>
            direct && node.type.name === name,
          handleTripleClickOn: (_view, _pos, node, _nodePos, _event, direct) =>
            direct && node.type.name === name,
          // Up or Down off the selected block lands on what is next that
          // way. ProseMirror hands a move into text to the browser, which,
          // from a block drawn without a caret, goes the wrong way: Up came
          // back down below it.
          handleKeyDown: (view, event) => {
            const dir = VERTICAL[event.key];
            const { selection, doc } = view.state;
            if (
              !dir ||
              event.shiftKey ||
              !(selection instanceof NodeSelection) ||
              selection.node.type.name !== name
            )
              return false;
            const next = Selection.findFrom(
              doc.resolve(dir < 0 ? selection.from : selection.to),
              dir,
            );
            if (next)
              view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
            return true;
          },
          // Typed over, a selected block would be replaced by the text.
          handleTextInput: ({ state: { selection } }) =>
            selection instanceof NodeSelection &&
            selection.node.type.name === name,
        },
        view(view) {
          let live = true;
          processes.loaded().then(
            () => {
              const tr = live && dropForeignTr(view.state, name, processes);
              if (tr) view.dispatch(tr);
            },
            () => {},
          );
          return { destroy: () => void (live = false) };
        },
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ProcessNodeView);
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => selectBeside(editor, this.name, true),
      Delete: ({ editor }) => selectBeside(editor, this.name, false),
      // `1` on the selected block presses its control (run, or stop while
      // it runs), as a digit runs a diff card's control.
      "1": ({ editor }) => {
        const { selection } = editor.state;
        if (
          !(selection instanceof NodeSelection) ||
          selection.node.type.name !== this.name
        )
          return false;
        const { processes } = this.options;
        const { blobId } = selection.node.attrs;
        if (processes.get(blobId).running) processes.stop(blobId);
        else processes.run(blobId);
        return true;
      },
    };
  },
});
