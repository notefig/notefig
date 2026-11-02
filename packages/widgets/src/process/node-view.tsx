/**
 * Renderer half of the process block (schema + markdown in node.ts): the
 * command, whole, over its process's stdout, and a play button once the stream is
 * gone. The state is the process blocks service's (./process-blocks.ts),
 * handed in with the document's other widget services.
 *
 * It wears the prompt widget's frame — settled, or raised while its
 * process runs — and its play button is the diff card's kind of control: an
 * icon with a tooltip, and `1` while the block is selected.
 */
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Play, SquareTerminal } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import type { WidgetRendererOptions } from "../define-widget";
import { ProcessNodeBase } from "./node";
import { inertProcessBlocks } from "./process-blocks";

/** What the block reads of the document's widget options. */
type ProcessNodeOptions = Pick<WidgetRendererOptions, "basePath" | "processes">;

function ProcessNodeView({ node, extension, selected }: NodeViewProps) {
  const { basePath, processes } = extension.options as ProcessNodeOptions;
  const blobId = node.attrs.blobId as string;
  const command = node.attrs.command as string;
  const block = useSyncExternalStore(
    (onChange) => processes.subscribe(blobId, onChange),
    () => processes.get(blobId),
  );

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
          {command}
        </code>
        {!block.running && (
          <RunButton
            selected={selected}
            onRun={() => processes.run(blobId, { command, cwd: basePath })}
          />
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

export const ProcessNode = ProcessNodeBase.extend<ProcessNodeOptions>({
  addOptions() {
    return { basePath: "", processes: inertProcessBlocks() };
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
        const { blobId, command } = selection.node.attrs;
        this.options.processes.run(blobId, {
          command,
          cwd: this.options.basePath,
        });
        return true;
      },
    };
  },
});
