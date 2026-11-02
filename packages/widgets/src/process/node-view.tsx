/**
 * Renderer half of the process block (schema + markdown in node.ts): the
 * command, its process's stdout, and Restart once the stream is gone. The
 * state is the process blocks service's (./process-blocks.ts), handed in
 * with the document's other widget services.
 */
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";
import { Button } from "@notefig/ui/button";
import type { WidgetRendererOptions } from "../define-widget";
import { ProcessNodeBase } from "./node";
import { inertProcessBlocks } from "./process-blocks";

/** What the block reads of the document's widget options. */
type ProcessNodeOptions = Pick<WidgetRendererOptions, "basePath" | "processes">;

function ProcessNodeView({ node, extension }: NodeViewProps) {
  const { basePath, processes } = extension.options as ProcessNodeOptions;
  const blobId = node.attrs.blobId as string;
  const command = node.attrs.command as string;
  const { t } = useTranslation();
  const block = useSyncExternalStore(
    (onChange) => processes.subscribe(blobId, onChange),
    () => processes.get(blobId),
  );

  return (
    <NodeViewWrapper
      data-type="process"
      contentEditable={false}
      className="not-prose my-1 rounded-md border bg-card text-sm"
    >
      <div className="flex items-center gap-2 px-3 py-1">
        <code className="flex-1 truncate">{command}</code>
        {!block.running && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => processes.run(blobId, { command, cwd: basePath })}
          >
            <RotateCw />
            {t("processBlockRestart")}
          </Button>
        )}
      </div>
      {block.lines.length > 0 && (
        <pre className="max-h-64 overflow-auto border-t px-3 py-2 text-xs">
          {block.lines.join("\n")}
        </pre>
      )}
    </NodeViewWrapper>
  );
}

export const ProcessNode = ProcessNodeBase.extend<ProcessNodeOptions>({
  addOptions() {
    return { basePath: "", processes: inertProcessBlocks() };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ProcessNodeView);
  },
});
