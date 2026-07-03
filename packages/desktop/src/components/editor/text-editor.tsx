import { EditorContent } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVertical } from "lucide-react";
import type { FileEntry } from "../../utils/fs";
import {
  getOrCreateEditor,
  isMarkdownInstance,
} from "@/components/editor/editor-store";
import { useEditorFileSync } from "./use-editor-file-sync";
import { useEditorFocusLifecycle } from "./use-editor-focus-lifecycle";
import { useLinkPrompt } from "./use-link-prompt";
import { TiptapToolbar } from "./tiptap-toolbar";
import { LinkBubbleMenu } from "./tiptap-link-menu";
import { TableMenu } from "./tiptap-table-menu";
import "./tiptap.css";

interface TextEditorProps {
  file: FileEntry;
  basePath: string;
  isContentLoaded: boolean;
}

export function TextEditor({
  file,
  basePath,
  isContentLoaded,
}: TextEditorProps) {
  const instance = getOrCreateEditor(file.path, {
    type: "markdown",
    content: file.content ?? "",
    basePath,
  });

  if (!isMarkdownInstance(instance)) {
    throw new Error("Failed to create markdown editor");
  }

  const editor = instance.editor;

  useEditorFileSync(editor, file, basePath, isContentLoaded);
  useEditorFocusLifecycle(editor, file.path);
  const handleLinkToggle = useLinkPrompt(editor);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full z-0">
      <TiptapToolbar editor={editor} onLinkToggle={handleLinkToggle} />
      <div className="flex-1 min-h-0 overflow-auto tiptap-editor-wrapper">
        <DragHandle editor={editor} nested>
          <GripVertical className="w-4 h-4 text-muted-foreground/40 hover:text-muted-foreground" />
        </DragHandle>
        <LinkBubbleMenu
          editor={editor}
          onEdit={handleLinkToggle}
          basePath={basePath}
          filePath={file.path}
        />
        <TableMenu editor={editor} />
        <EditorContent
          editor={editor}
          className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 outline-none"
        />
      </div>
    </div>
  );
}
