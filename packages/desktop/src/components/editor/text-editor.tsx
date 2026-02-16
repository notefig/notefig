import { useCallback, useRef, useEffect, useMemo } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import { Editor as SlateEditor } from "slate";
import { MarkdownPlugin } from "@platejs/markdown";
import { MarkdownEditorKit } from "@/components/editor/markdown-editor-kit";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { MarkToolbarButton } from "@/components/ui/mark-toolbar-button";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Separator } from "@/components/ui/separator";
import {
  Code2Icon,
  ListIcon,
  ListOrderedIcon,
  Link2Icon,
  StrikethroughIcon,
} from "lucide-react";
import { toggleList, ListStyleType } from "@platejs/list";
import type { FileEntry } from "../../utils/fs";
import { writeFileContent } from "@/utils/collections";

interface TextEditorProps {
  file: FileEntry;
  basePath: string;
  isActive?: boolean;
}

/**
 * Main TextEditor component
 * Receives file with content already loaded from workspace-level query
 */
export function TextEditor({ file, basePath, isActive }: TextEditorProps) {
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Memoize the initial editor value to avoid re-deserializing on every render
  // Only deserialize when the file path changes (new file loaded)
  const initialValue = useMemo(
    () => (editor: any) =>
      editor.getApi(MarkdownPlugin).markdown.deserialize(file.content),
    [file.path], // Only re-deserialize when file path changes, not content
  );

  const editor = usePlateEditor({
    plugins: MarkdownEditorKit,
    value: initialValue,
  });

  // Enable chunking for large documents (Slate performance optimization)
  // Splits the document into chunks of 1000 nodes to reduce React re-rendering overhead
  // This is crucial for handling files with thousands of lines like "The Adventures of Pinocchio.md"
  useEffect(() => {
    if (editor) {
      // Type assertion needed as Plate types don't expose getChunkSize yet
      (editor as any).getChunkSize = (node: any) => {
        return SlateEditor.isEditor(node) ? 1000 : null;
      };
    }
  }, [editor]);

  const handleChange = useCallback(() => {
    if (!editor) return;

    // Cancel any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saves by 300ms
    saveTimeoutRef.current = setTimeout(() => {
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      // Normalize: remove HTML entity for space
      const normalizedMarkdown = markdown.replace(/&#x20;/g, "");

      writeFileContent(basePath, file.path, normalizedMarkdown);
    }, 500);
  }, [editor, file.path, basePath]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Restore focus when tab becomes active
  // This ensures the cursor position is preserved when switching between tabs
  useEffect(() => {
    if (isActive && editor) {
      // Use setTimeout to ensure DOM is ready (display: block has been applied)
      setTimeout(() => {
        editor.tf.focus();
      }, 0);
    }
  }, [isActive, editor]);

  return (
    <Plate editor={editor} onValueChange={handleChange}>
      <FixedToolbar className="justify-start rounded-t-lg gap-1 flex-wrap">
        <ToolbarButton
          onClick={() => editor.tf.h1.toggle()}
          tooltip="Heading 1"
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.tf.h2.toggle()}
          tooltip="Heading 2"
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.tf.h3.toggle()}
          tooltip="Heading 3"
        >
          H3
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <MarkToolbarButton nodeType="bold" tooltip="Bold (⌘+B)">
          <strong>B</strong>
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="italic" tooltip="Italic (⌘+I)">
          <em>I</em>
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="underline" tooltip="Underline (⌘+U)">
          <span className="underline">U</span>
        </MarkToolbarButton>
        <MarkToolbarButton
          nodeType="strikethrough"
          tooltip="Strikethrough (⌘+Shift+X)"
        >
          <StrikethroughIcon className="h-4 w-4" />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="code" tooltip="Inline Code (⌘+E)">
          <Code2Icon className="h-4 w-4" />
        </MarkToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <ToolbarButton
          onClick={() =>
            toggleList(editor, { listStyleType: ListStyleType.Disc })
          }
          tooltip="Bullet List"
        >
          <ListIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() =>
            toggleList(editor, { listStyleType: ListStyleType.Decimal })
          }
          tooltip="Numbered List"
        >
          <ListOrderedIcon className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <ToolbarButton
          onClick={() => editor.tf.blockquote.toggle()}
          tooltip="Blockquote"
        >
          Quote
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.tf.codeBlock.toggle()}
          tooltip="Code Block (⌘+Alt+8)"
        >
          {"</>"}
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <ToolbarButton
          onClick={() => editor.tf.link.toggle()}
          tooltip="Toggle Link"
        >
          <Link2Icon className="h-4 w-4" />
        </ToolbarButton>
      </FixedToolbar>
      <EditorContainer>
        <Editor placeholder="Type your amazing content here..." />
      </EditorContainer>
    </Plate>
  );
}
