import { useCallback, useRef, useEffect } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import type { Value } from "platejs";
import {
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
  BlockquotePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
} from "@platejs/basic-nodes/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { MarkToolbarButton } from "@/components/ui/mark-toolbar-button";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BlockquoteElement } from "@/components/ui/blockquote-node";
import { H1Element, H2Element, H3Element } from "@/components/ui/heading-node";
import { ToolbarButton } from "@/components/ui/toolbar"; // Generic toolbar button
import type { FileEntry } from "../../utils/fs";
import { getStore } from "../../utils/tinybase";
import { platformAdapter } from "@/adapters";

interface TextEditorProps {
  file: FileEntry;
}

export function TextEditor({ file }: TextEditorProps) {
  const store = getStore();
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const editor = usePlateEditor({
    plugins: [
      ...MarkdownKit,
      BoldPlugin,
      ItalicPlugin,
      UnderlinePlugin,
      H1Plugin.withComponent(H1Element),
      H2Plugin.withComponent(H2Element),
      H3Plugin.withComponent(H3Element),
      BlockquotePlugin.withComponent(BlockquoteElement),
    ],
    value: (editor) =>
      editor.getApi(MarkdownPlugin).markdown.deserialize(file.content || ""),
  });

  const handleChange = useCallback(() => {
    if (!editor) return;

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce save by 300ms
    saveTimeoutRef.current = setTimeout(() => {
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      const normalizedMarkdown = markdown.replace(/\&\#x20\;/, "");
      store.setCell("files", file.path, "content", normalizedMarkdown);
    }, 300);
  }, [editor, file.path, store]);

  // Listen for edit actions from Tauri menu (macOS Edit menu)
  useEffect(() => {
    if (!editor) return;

    const unlisten = platformAdapter.addEditActionListener?.(
      (action: string) => {
        switch (action) {
          case "select_all":
            // Use native browser select all command
            document.execCommand("selectAll");
            break;
          case "undo":
            document.execCommand("undo");
            break;
          case "redo":
            document.execCommand("redo");
            break;
          case "cut":
            document.execCommand("cut");
            break;
          case "copy":
            document.execCommand("copy");
            break;
          case "paste":
            document.execCommand("paste");
            break;
        }
      },
    );

    return unlisten;
  }, [editor]);

  return (
    <Plate editor={editor} onValueChange={handleChange}>
      <FixedToolbar className="justify-start rounded-t-lg">
        <ToolbarButton onClick={() => editor.tf.h1.toggle()}>H1</ToolbarButton>
        <ToolbarButton onClick={() => editor.tf.h2.toggle()}>H2</ToolbarButton>
        <ToolbarButton onClick={() => editor.tf.h3.toggle()}>H3</ToolbarButton>
        <ToolbarButton onClick={() => editor.tf.blockquote.toggle()}>
          Quote
        </ToolbarButton>
        <MarkToolbarButton nodeType="bold" tooltip="Bold (⌘+B)">
          B
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="italic" tooltip="Italic (⌘+I)">
          I
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="underline" tooltip="Underline (⌘+U)">
          U
        </MarkToolbarButton>
      </FixedToolbar>
      <EditorContainer>
        <Editor placeholder="Type your amazing content here..." />
      </EditorContainer>
    </Plate>
  );
}
