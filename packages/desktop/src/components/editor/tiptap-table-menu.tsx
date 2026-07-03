import { BubbleMenu } from "@tiptap/react/menus";
import { Trash2 } from "lucide-react";
import type { Editor } from "@tiptap/core";

const preventFocusLoss = (e: React.MouseEvent) => e.preventDefault();

interface TableMenuProps {
  editor: Editor;
}

/* Inline SVG icons from Plate's table-node.tsx — mini table diagrams
   showing a grid cell with an insert/deletion indicator. */

const InsertRowIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="rotate-90"
  >
    <path d="M14.5 12.5h7" />
    <path d="M18 16V9" />
    <rect x="3" y="3" width="7" height="18" rx="1" />
  </svg>
);

const InsertColumnIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.5 12.5h7" />
    <path d="M18 16V9" />
    <rect x="3" y="3" width="7" height="18" rx="1" />
  </svg>
);

const DeleteRowIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="rotate-90"
  >
    <path d="M10.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5.5" />
    <path d="M14.5 18h7" />
    <path d="M15 3v7.5" />
    <path d="M9 3v18" />
  </svg>
);

const DeleteColumnIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5.5" />
    <path d="M14.5 18h7" />
    <path d="M15 3v7.5" />
    <path d="M9 3v18" />
  </svg>
);

export function TableMenu({ editor }: TableMenuProps) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      shouldShow={({ editor }) =>
        editor.isActive("table") && !editor.isActive("link")
      }
    >
      <div className="flex items-center gap-0.5 rounded-md border bg-background p-1 shadow-md">
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            editor.chain().focus().addRowAfter().run()
          }
          onMouseDown={preventFocusLoss}
          title="Insert row after"
        >
          <InsertRowIcon />
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            editor.chain().focus().addColumnAfter().run()
          }
          onMouseDown={preventFocusLoss}
          title="Insert column after"
        >
          <InsertColumnIcon />
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            editor.chain().focus().deleteRow().run()
          }
          onMouseDown={preventFocusLoss}
          title="Delete row"
        >
          <DeleteRowIcon />
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            editor.chain().focus().deleteColumn().run()
          }
          onMouseDown={preventFocusLoss}
          title="Delete column"
        >
          <DeleteColumnIcon />
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-destructive"
          onClick={() =>
            editor.chain().focus().deleteTable().run()
          }
          onMouseDown={preventFocusLoss}
          title="Delete table"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </BubbleMenu>
  );
}
