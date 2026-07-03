import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { ExternalLink, FileText, Link, Unlink } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { platformAdapter } from "@/adapters";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import { isExternalUrl, buildInternalCandidates } from "./tiptap-link-utils";

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

  const handleOpen = async () => {
    if (!href) return;

    if (isExternal) {
      platformAdapter.openExternal(href);
      return;
    }

    const fileDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
    const candidates = buildInternalCandidates(href, { fileDir, basePath });

    const results = await platformAdapter.exists(candidates);
    const target = candidates.find((candidate) =>
      results.some(
        (r) => r.path === candidate && r.exists && r.type !== "directory",
      ),
    );

    if (!target) {
      toast.error(`File not found: ${href}`);
      return;
    }
    if (!openFile({ tabId: target, intent: "new-tab" })) {
      toast.error(`"${href}" can't be opened in the editor`);
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
          title={isExternal ? `Open in browser — ${href}` : "Open in new tab"}
        >
          {/* Show the full href: stripping the scheme would disguise an
              external "https://notes.md" as an internal-looking filename. */}
          {isExternal ? (
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="max-w-[160px] truncate">{href}</span>
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
