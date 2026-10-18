/**
 * The feedback message, written like a document: the editor's own
 * markdown schema, so headings, lists, code and links work as they do in
 * a file (typed shortcuts or pasted markdown), read back as markdown on
 * every change.
 */
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import { createSchemaExtensions } from "@/components/editor/editor-schema-kit";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import "@/components/editor/tiptap.css";

export function FeedbackMessageEditor({
  initialMarkdown,
  placeholder,
  label,
  readOnly,
  onChange,
}: {
  /** The draft to resume; read once, when the editor mounts. */
  initialMarkdown: string;
  placeholder: string;
  label: string;
  readOnly: boolean;
  onChange: (markdown: string) => void;
}) {
  const editor = useEditor({
    // The document schema as the release notes use it: the widgets'
    // worker-safe halves, which the schema's content rules name.
    extensions: [
      ...createSchemaExtensions(),
      Placeholder.configure({ placeholder }),
    ],
    content: initialMarkdown,
    autofocus: "end",
    editorProps: {
      attributes: {
        "aria-label": label,
        class:
          // Important: tiptap.css's unlayered `.ProseMirror` min-height
          // would otherwise win over the utility.
          "prose prose-sm dark:prose-invert max-w-none min-h-[11rem]! cursor-text outline-none",
      },
    },
    onUpdate: ({ editor }) => onChange(getEditorMarkdown(editor)),
  });

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  return (
    <EditorContent
      editor={editor}
      // The surface of a document's pane in the dock, so it reads as the
      // editor it is.
      className="feedback-editor max-h-[24rem] overflow-y-auto rounded-lg border border-border bg-card texture-surface p-4 focus-within:border-muted-foreground/40"
    />
  );
}
