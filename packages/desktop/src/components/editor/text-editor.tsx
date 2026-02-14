import { useCallback, useRef, useEffect } from "react";
import { Plate, usePlateEditor } from "platejs/react";
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
}

/**
 * Main TextEditor component
 * Receives file with content already loaded from workspace-level query
 */
export function TextEditor({ file, basePath }: TextEditorProps) {
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const editor = usePlateEditor({
    plugins: MarkdownEditorKit,
    value: (editor) =>
      editor.getApi(MarkdownPlugin).markdown.deserialize(file.content),
  });

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
