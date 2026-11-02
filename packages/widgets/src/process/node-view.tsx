/**
 * Renderer half of the process block (schema + markdown in node.ts): the
 * registered command, whole, over its process's stdout, and a play button
 * once the stream is gone. The state is the process blocks service's
 * (./process-blocks.ts), handed in with the document's other widget
 * services. A block whose id the app never minted is dropped here, the one
 * place every document passes through with the service in hand.
 *
 * It wears the prompt widget's frame — settled, or raised while its
 * process runs — and its play button is the diff card's kind of control: an
 * icon with a tooltip, and `1` while the block is selected.
 */
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { NodeSelection, Plugin, type EditorState } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Play, SquareTerminal } from "lucide-react";
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
      {/* All of it, wrapped: what the play button runs is never cut off. */}
      <div
        className={cn(
          "flex items-start gap-1.5 py-1 pl-2.5 pr-1 text-[0.6875rem] text-muted-foreground",
          block.lines.length > 0 && "border-b border-border/60",
        )}
      >
        <SquareTerminal className="mt-0.5 size-3 shrink-0" />
        <code className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-foreground">
          {block.command}
        </code>
        {!block.running && (
          <RunButton selected={selected} onRun={() => processes.run(blobId)} />
        )}
      </div>
      {block.lines.length > 0 && (
        <pre className="max-h-48 select-text overflow-auto px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {block.lines.join("\n")}
        </pre>
      )}
    </NodeViewWrapper>
  );
}

function RunButton({
  selected,
  onRun,
}: {
  selected: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("processBlockRun")}
      aria-label={t("processBlockRun")}
      aria-keyshortcuts="1"
      className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
      onClick={onRun}
    >
      <Play className="size-3" />
      {selected && <kbd className="font-sans text-[0.5625rem]">1</kbd>}
    </button>
  );
}

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
      // `1` on the selected block runs it again, as a digit runs a diff
      // card's control. Taken even while it runs: typed through, the digit
      // would replace the block.
      "1": ({ editor }) => {
        const { selection } = editor.state;
        if (
          !(selection instanceof NodeSelection) ||
          selection.node.type.name !== this.name
        )
          return false;
        this.options.processes.run(selection.node.attrs.blobId);
        return true;
      },
    };
  },
});
