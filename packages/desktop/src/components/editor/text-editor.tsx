import { useCallback, useRef, useEffect } from "react";
import { EditorContent } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVertical } from "lucide-react";
import "./tiptap.css";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Separator } from "@/components/ui/separator";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  StrikethroughIcon,
  TableIcon,
  UnderlineIcon,
  LinkIcon,
} from "lucide-react";
import type { FileEntry } from "../../utils/fs";
import { writeFileContent } from "@/utils/collections";
import { calculateContentHash } from "@/utils/hash";
import {
  getOrCreateEditor,
  requestEditorFocus,
  saveSelection,
  getSavedSelection,
  isMarkdownInstance,
} from "@/components/editor/editor-store";

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
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnownHashRef = useRef<string>(file.contentHash || "");
  const suppressSaveRef = useRef(false);

  const instance = getOrCreateEditor(file.path, {
    type: "markdown",
    content: file.content ?? "",
  });

  if (!isMarkdownInstance(instance)) {
    throw new Error("Failed to create markdown editor");
  }

  const editor = instance.editor;

  const preventFocusLoss = useCallback(
    (e: React.MouseEvent) => e.preventDefault(),
    [],
  );

  useEffect(() => {
    if (!editor || !file.contentHash) return;

    if (file.contentHash === lastKnownHashRef.current) return;

    console.log(
      `[text-editor] External change detected for ${file.path}, updating editor`,
    );

    suppressSaveRef.current = true;
    editor.commands.setContent(file.content, { emitUpdate: false });
    suppressSaveRef.current = false;
    lastKnownHashRef.current = file.contentHash;
  }, [editor, file.contentHash, file.content, file.path]);

  useEffect(() => {
    const handleUpdate = () => {
      if (suppressSaveRef.current) return;
      if (!isContentLoaded) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        const markdown = (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

        const hash = calculateContentHash(markdown);
        lastKnownHashRef.current = hash;

        writeFileContent(basePath, file.path, markdown);
      }, 500);
    };

    editor.on("update", handleUpdate);

    return () => {
      editor.off("update", handleUpdate);
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [editor, file.path, basePath, isContentLoaded]);

  useEffect(() => {
    if (!editor) return;

    const saved = getSavedSelection(file.path);
    if (saved) {
      editor.commands.setTextSelection(saved);
    }

    requestEditorFocus(file.path, {
      when: "next-frame",
      reason: "text-editor-mount",
    });

    return () => {
      const { from, to } = editor.state.selection;
      if (from !== to || editor.isFocused) {
        saveSelection(file.path, from, to);
      }
    };
  }, [editor, file.path]);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full z-0">
      <FixedToolbar>
        <ScrollArea className="flex justify-start shrink-0 gap-1">
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            tooltip="Heading 1"
          >
            <Heading1Icon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            tooltip="Heading 2"
          >
            <Heading2Icon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            tooltip="Heading 3"
          >
            <Heading3Icon />
          </ToolbarButton>

          <Separator orientation="vertical" className="h-6" />

          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleBold().run()}
            tooltip="Bold"
          >
            <BoldIcon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            tooltip="Italic"
          >
            <ItalicIcon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            tooltip="Underline"
          >
            <UnderlineIcon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            tooltip="Strikethrough"
          >
            <StrikethroughIcon />
          </ToolbarButton>

          <Separator orientation="vertical" className="h-6" />

          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            tooltip="Bullet List"
          >
            <ListIcon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            tooltip="Numbered List"
          >
            <ListOrderedIcon />
          </ToolbarButton>

          <Separator orientation="vertical" className="h-6" />

          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            tooltip="Blockquote"
          >
            <QuoteIcon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            tooltip="Code Block"
          >
            <CodeIcon />
          </ToolbarButton>
          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
            tooltip="Insert Table"
          >
            <TableIcon />
          </ToolbarButton>

          <Separator orientation="vertical" className="h-6" />

          <ToolbarButton
            onMouseDown={preventFocusLoss}
            onClick={() => {
              const previousUrl = editor.getAttributes("link").href;
              if (previousUrl) {
                editor.chain().focus().unsetLink().run();
              } else {
                const url = window.prompt("Enter URL");
                if (url) {
                  editor.chain().focus().setLink({ href: url }).run();
                }
              }
            }}
            tooltip="Link"
          >
            <LinkIcon />
          </ToolbarButton>
        </ScrollArea>
      </FixedToolbar>
      <div className="flex-1 min-h-0 overflow-auto tiptap-editor-wrapper">
        <DragHandle editor={editor} nested>
          <GripVertical className="w-4 h-4 text-muted-foreground/40 hover:text-muted-foreground" />
        </DragHandle>
        <EditorContent
          editor={editor}
          className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 outline-none"
        />
      </div>
    </div>
  );
}
