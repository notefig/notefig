import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { ToolbarButton } from "@notefig/ui/toolbar";
import { isActiveIn } from "./active-formats";

const preventFocusLoss = (e: React.MouseEvent) => e.preventDefault();

type MarkButtonProps = {
  editor: Editor;
  format: string;
  tooltip: string;
  children: React.ReactNode;
};

export function TiptapMarkButton({
  editor,
  format,
  tooltip,
  children,
}: MarkButtonProps) {
  const isActive = useEditorState({
    editor,
    selector: ({ editor }) => isActiveIn(editor.state, format),
  });

  return (
    <ToolbarButton
      onMouseDown={preventFocusLoss}
      onClick={() =>
        (editor.chain().focus() as any)[`toggle${capitalize(format)}`]().run()
      }
      tooltip={tooltip}
      pressed={isActive}
    >
      {children}
    </ToolbarButton>
  );
}

type HeadingButtonProps = {
  editor: Editor;
  level: 1 | 2 | 3;
  tooltip: string;
  children: React.ReactNode;
};

export function TiptapHeadingButton({
  editor,
  level,
  tooltip,
  children,
}: HeadingButtonProps) {
  const isActive = useEditorState({
    editor,
    selector: ({ editor }) => isActiveIn(editor.state, "heading", { level }),
  });

  return (
    <ToolbarButton
      onMouseDown={preventFocusLoss}
      onClick={() =>
        editor.chain().focus().toggleHeading({ level }).run()
      }
      tooltip={tooltip}
      pressed={isActive}
    >
      {children}
    </ToolbarButton>
  );
}

/** A block toggles as a mark does, by its `toggle<Format>` command. */
export const TiptapBlockButton = TiptapMarkButton;

type LinkButtonProps = {
  editor: Editor;
  onToggle: () => void;
  tooltip: string;
  children: React.ReactNode;
};

export function TiptapLinkButton({
  editor,
  onToggle,
  tooltip,
  children,
}: LinkButtonProps) {
  const isActive = useEditorState({
    editor,
    selector: ({ editor }) => isActiveIn(editor.state, "link"),
  });

  return (
    <ToolbarButton
      onMouseDown={preventFocusLoss}
      onClick={onToggle}
      tooltip={tooltip}
      pressed={isActive}
    >
      {children}
    </ToolbarButton>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type TableInsertButtonProps = {
  editor: Editor;
  tooltip: string;
  children: React.ReactNode;
};

export function TiptapTableInsertButton({
  editor,
  tooltip,
  children,
}: TableInsertButtonProps) {
  const isActive = useEditorState({
    editor,
    selector: ({ editor }) => isActiveIn(editor.state, "table"),
  });

  return (
    <ToolbarButton
      onMouseDown={preventFocusLoss}
      onClick={() =>
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run()
      }
      tooltip={tooltip}
      pressed={isActive}
    >
      {children}
    </ToolbarButton>
  );
}
