import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { ExternalLink, FileText, Link, Unlink } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { platformAdapter } from "@/adapters";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import {
  isExternalUrl,
  buildInternalCandidates,
  decodeHrefForDisplay,
} from "./tiptap-link-utils";

const preventFocusLoss = (e: React.MouseEvent) => e.preventDefault();

interface LinkBubbleMenuProps {
  editor: Editor;
  onEdit: () => void;
  basePath: string;
  filePath: string;
}

export function LinkBubbleMenu({
  editor,
  onEdit,
  basePath,
  filePath,
}: LinkBubbleMenuProps) {
  const { openFile } = useWorkspaceTabs();
  // Subscribe to editor state — a plain getAttributes() read at render time
  // goes stale because nothing re-renders this component on selection change.
  const href = useEditorState({
    editor,
    selector: ({ editor }) =>
      (editor.getAttributes("link").href as string) || "",
  });
  const isExternal = isExternalUrl(href);
  // Internal hrefs are percent-encoded on disk (tiptap-link-utils.ts) so they
  // survive markdown's link-destination syntax; decode for display so the
  // user reads the real filename instead of "%20"/"%3C". External URLs are
  // shown as-is — their own encoding is meaningful, not an artifact.
  const displayHref = isExternal ? href : decodeHrefForDisplay(href);

  const handleOpen = async () => {
    if (!href) return;

    if (isExternal) {
      platformAdapter.ui.openExternal(href);
      return;
    }

    const fileDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
    const candidates = buildInternalCandidates(href, { fileDir, basePath });

    const results = await platformAdapter.fs.exists(candidates);
    const target = candidates.find((candidate) =>
      results.some(
        (r) => r.path === candidate && r.exists && r.type !== "directory",
      ),
    );

    if (!target) {
      toast.error(`File not found: ${displayHref}`);
      return;
    }
    if (!openFile({ tabId: target, intent: "new-tab" })) {
      toast.error(`"${displayHref}" can't be opened in the editor`);
    }
  };

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor }) => editor.isActive("link")}
    >
      <div className="flex items-center gap-0.5 rounded-md border bg-background p-1 shadow-md">
        <button
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={handleOpen}
          onMouseDown={preventFocusLoss}
          title={
            isExternal ? `Open in browser — ${displayHref}` : "Open in new tab"
          }
        >
          {/* Show the full href: stripping the scheme would disguise an
              external "https://notes.md" as an internal-looking filename. */}
          {isExternal ? (
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="max-w-[10rem] truncate">{displayHref}</span>
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onEdit}
          onMouseDown={preventFocusLoss}
          title="Edit link"
        >
          <Link className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
          }}
          onMouseDown={preventFocusLoss}
          title="Remove link"
        >
          <Unlink className="h-3.5 w-3.5" />
        </button>
      </div>
    </BubbleMenu>
  );
}
