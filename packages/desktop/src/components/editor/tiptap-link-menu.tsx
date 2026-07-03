import { BubbleMenu } from "@tiptap/react/menus";
import { ExternalLink, Link, Unlink } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { platformAdapter } from "@/adapters";
import { useNavigate } from "react-router";

const preventFocusLoss = (e: React.MouseEvent) => e.preventDefault();

interface LinkBubbleMenuProps {
  editor: Editor;
  onEdit: () => void;
  basePath: string;
}

function isExternalUrl(url: string): boolean {
  return /^(https?|mailto):/i.test(url);
}

export function LinkBubbleMenu({ editor, onEdit, basePath }: LinkBubbleMenuProps) {
  const navigate = useNavigate();
  const href = (editor.getAttributes("link").href as string) || "";

  const handleOpen = () => {
    if (!href) return;
    if (isExternalUrl(href)) {
      platformAdapter.openExternal(href);
    } else {
      // Internal workspace link — resolve relative paths against basePath
      const resolved = href.startsWith("/")
        ? href
        : `${basePath}/${href}`.replace(/\/+/g, "/");
      navigate(`/${encodeURIComponent(resolved)}`);
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
          title="Open link"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="max-w-[120px] truncate">
            {href.replace(/^https?:\/\//, "")}
          </span>
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
