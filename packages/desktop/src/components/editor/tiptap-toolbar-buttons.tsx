import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { ToolbarButton } from "@/components/ui/toolbar";

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
    selector: ({ editor }) => editor.isActive(format),
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
    selector: ({ editor }) => editor.isActive("heading", { level }),
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

type BlockButtonProps = {
  editor: Editor;
  format: string;
  tooltip: string;
  children: React.ReactNode;
};

export function TiptapBlockButton({
  editor,
  format,
  tooltip,
  children,
}: BlockButtonProps) {
  const isActive = useEditorState({
    editor,
    selector: ({ editor }) => editor.isActive(format),
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
    selector: ({ editor }) => editor.isActive("link"),
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
    selector: ({ editor }) => editor.isActive("table"),
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
