import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import { FileSymlink } from "lucide-react";
import { ToolbarButton } from "@/components/ui/toolbar";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useWorkspaceGraphData } from "@/hooks/use-workspace-graph-data";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { getDirectoryPath } from "@/utils/fs";
import { relativeHrefFromDir } from "./tiptap-link-utils";
import {
  rankFileLinkCandidates,
  type FileLinkCandidate,
} from "./file-link-suggestions";

const preventFocusLoss = (e: React.MouseEvent) => e.preventDefault();

interface TiptapFileLinkButtonProps {
  editor: Editor;
  basePath: string;
  filePath: string;
}

export function TiptapFileLinkButton({
  editor,
  basePath,
  filePath,
}: TiptapFileLinkButtonProps) {
  const [open, setOpen] = useState(false);
  const { graphData, markdownPaths } = useWorkspaceGraphData(basePath);

  const candidates = useMemo(
    () => rankFileLinkCandidates(filePath, markdownPaths, graphData.links),
    [filePath, markdownPaths, graphData.links],
  );

  // Opening the popover moves DOM focus into its search input, which clears
  // ProseMirror's native selection highlight (only rendered while the editor
  // itself has focus) — redraw the target range as an explicit decoration
  // for as long as the popover is open, so the user doesn't lose sight of
  // what they're linking.
  const openPopover = () => {
    const { empty, from, to } = editor.state.selection;
    if (!empty) editor.commands.showLinkTargetHighlight({ from, to });
    setOpen(true);
  };

  const closePopover = () => {
    editor.commands.hideLinkTargetHighlight();
    setOpen(false);
  };

  const handleSelect = (candidate: FileLinkCandidate) => {
    const href = relativeHrefFromDir(
      getDirectoryPath(filePath),
      candidate.path,
    );

    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: "text",
          text: candidate.label,
          marks: [{ type: "link", attrs: { href } }],
        })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }

    // Picking a file is a single deliberate action, not continuous typing —
    // skip use-editor-file-sync.ts's keystroke-oriented 500ms autosave
    // debounce and persist now. The graph only refetches once the write
    // actually lands on disk, so waiting on that debounce is what made the
    // graph look unresponsive to links added this way.
    getDocumentSync(filePath).pushUpdate(() => editor.state.doc.toJSON());

    closePopover();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? openPopover() : closePopover())}
    >
      {/* Anchored to a plain span (not the ToolbarButton itself) so Radix's
       * asChild ref cloning lands on a real DOM node — ToolbarButton isn't a
       * forwardRef component. */}
      <PopoverAnchor asChild>
        <span>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => (open ? closePopover() : openPopover())}
            tooltip="Link to file"
            pressed={open}
          >
            <FileSymlink />
          </ToolbarButton>
        </span>
      </PopoverAnchor>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Find a file to link..." />
          <CommandList>
            <CommandEmpty>No files found.</CommandEmpty>
            {candidates.map((candidate) => (
              <CommandItem
                key={candidate.path}
                value={candidate.label}
                onSelect={() => handleSelect(candidate)}
              >
                <div className="flex flex-col overflow-hidden">
                  <span className="truncate">{candidate.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {candidate.path}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
