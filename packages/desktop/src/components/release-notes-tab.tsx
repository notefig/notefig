import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { createSchemaExtensions } from "@/components/editor/editor-schema-kit";
import { getOrCreateEditor } from "@/components/editor/editor-store";
import { focusTab } from "@/tabs/tab-controllers";
import { RELEASE_NOTES_TAB_ID } from "@/entities/tabs";
import { latestReleaseMarkdown } from "@/utils/release-notes";
import "@/components/editor/tiptap.css";

/**
 * The bundled release notes rendered read-only through the same Tiptap
 * schema the editor uses (the Markdown extension parses the string
 * content). Only the newest version's document is shown — older bundled
 * notes stay on disk but don't render.
 *
 * Presentation only: no tab id, no focus registration, no store entry. That
 * wiring belongs to whoever is hosting the document, which is why it lives
 * in ReleaseNotesTab below and not here — the welcome screen's modal shows
 * the identical document with none of it.
 */
export function ReleaseNotesDocument({ className }: { className?: string }) {
  const { t } = useTranslation();
  const editor = useEditor({
    extensions: createSchemaExtensions(),
    content: latestReleaseMarkdown,
    editable: false,
  });

  if (!latestReleaseMarkdown) {
    return (
      <p
        className={
          className ??
          "prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 text-muted-foreground"
        }
      >
        {t("releaseNotesEmpty")}
      </p>
    );
  }

  return (
    <EditorContent
      editor={editor}
      className={
        className ??
        "prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 outline-none"
      }
    />
  );
}

/**
 * The release-notes tab. The wrapper/prose classes mirror text-editor.tsx
 * exactly, so the notes column has the same width and centering as an open
 * file. The outer `w-full` matters: without it the tab content shrinks
 * inside the Dockable window and `mx-auto` has nothing to center against.
 */
export function ReleaseNotesTab() {
  // Same wiring as the image viewer: register a container-focus instance so
  // the focus arbiter's tab-selected intents resolve here — focus landing on
  // the container is what keeps the dockable hotkeys (Ctrl+Tab, ⌘W, ⌘1-9)
  // alive, and gives the notes keyboard scrolling.
  useEffect(() => {
    getOrCreateEditor(RELEASE_NOTES_TAB_ID, { type: "release-notes" });
  }, []);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      focusTab(RELEASE_NOTES_TAB_ID);
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
        <ReleaseNotesDocument />
      </div>
    </div>
  );
}
