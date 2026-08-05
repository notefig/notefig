import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { createSchemaExtensions } from "@/components/editor/editor-schema-kit";
import {
  getOrCreateEditor,
  focusEditor,
} from "@/components/editor/editor-store";
import { RELEASE_NOTES_TAB_ID } from "@/entities/tabs";
import { releaseNotesMarkdown } from "@/utils/release-notes";
import "@/components/editor/tiptap.css";

/**
 * The release-notes tab — renders the bundled release notes read-only through
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

  // Same wiring as the image viewer: register a container-focus instance so
  // the focus arbiter's tab-selected intents resolve here — focus landing on
  // the container is what keeps the dockable hotkeys (Ctrl+Tab, ⌘W, ⌘1-9)
  // alive, and gives the notes keyboard scrolling.
  useEffect(() => {
    getOrCreateEditor(RELEASE_NOTES_TAB_ID, { type: "release-notes" });
  }, []);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      focusEditor(RELEASE_NOTES_TAB_ID);
    });
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full h-full">
      <div
        data-editor-container={RELEASE_NOTES_TAB_ID}
        tabIndex={-1}
        className="flex-1 min-h-0 overflow-auto outline-none"
      >
        {releaseNotesMarkdown ? (
          <EditorContent
            editor={editor}
            className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 outline-none"
          />
        ) : (
          <p className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 text-muted-foreground">
            {t("releaseNotesEmpty")}
          </p>
        )}
      </div>
    </div>
  );
}
