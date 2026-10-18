/**
 * The feedback message, written like a document: the editor's own
 * markdown schema, so headings, lists, code and links work as they do in
 * a file (typed shortcuts or pasted markdown), read back as markdown on
 * every change. Pasted or dropped images go to `onImage`, which hands
 * back the URL they show by.
 */
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
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
  onImage,
  maxImages,
  onTooManyImages,
}: {
  /** The draft to resume; read once, when the editor mounts. */
  initialMarkdown: string;
  placeholder: string;
  label: string;
  readOnly: boolean;
  onChange: (markdown: string) => void;
  onImage: (image: File) => string;
  maxImages: number;
  onTooManyImages: () => void;
}) {
  // Handled even past the limit, so the browser doesn't insert the image
  // some other way.
  const insertImages = (view: EditorView, files: File[]): boolean => {
    if (files.length === 0) return false;
    const room = Math.max(0, maxImages - countImages(view.state.doc));
    const { tr, schema } = view.state;
    for (const file of files.slice(0, room)) {
      tr.replaceSelectionWith(schema.nodes.image.create({ src: onImage(file) }));
    }
    view.dispatch(tr);
    if (files.length > room) onTooManyImages();
    return true;
  };

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
      handlePaste: (view, event) =>
        insertImages(view, imageFiles(event.clipboardData?.files)),
      handleDrop: (view, event) => {
        const files = imageFiles(event.dataTransfer?.files);
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (files.length > 0 && at) {
          const { doc, tr } = view.state;
          view.dispatch(tr.setSelection(TextSelection.near(doc.resolve(at.pos))));
        }
        return insertImages(view, files);
      },
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
      className="feedback-editor max-h-[24rem] overflow-y-auto rounded-lg bg-card texture-surface"
    />
  );
}

function imageFiles(files: FileList | null | undefined): File[] {
  return [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
}

function countImages(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "image") count++;
  });
  return count;
}
