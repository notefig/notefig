import { useEditor, EditorContent } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { createSchemaExtensions } from "@/components/editor/editor-schema-kit";
import { releaseNotesMarkdown } from "@/utils/release-notes";
import "@/components/editor/tiptap.css";

/**
 * The "What's New" tab — renders the bundled release notes read-only through
 * the same Tiptap schema the editor uses (the Markdown extension parses the
 * string content). Each release document carries its own `# ` title, so the
 * tab renders the concatenated documents verbatim. The wrapper/prose classes
 * mirror text-editor.tsx exactly, so the notes column has the same width and
 * centering as an open file. The outer `w-full` matters: without it the tab
 * content shrinks inside the Dockable window and `mx-auto` has nothing to
 * center against.
 */
export function ReleaseNotesTab() {
  const { t } = useTranslation();
  const editor = useEditor({
    extensions: createSchemaExtensions(),
    content: releaseNotesMarkdown,
    editable: false,
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        {releaseNotesMarkdown ? (
          <EditorContent
            editor={editor}
            className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 outline-none"
          />
        ) : (
          <p className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 text-muted-foreground">
            {t("whatsNewEmpty")}
          </p>
        )}
      </div>
    </div>
  );
}
