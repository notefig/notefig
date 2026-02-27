import { useCallback, useRef, useEffect } from "react";
import { Plate } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
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
import { calculateContentHash } from "@/utils/hash";
import {
  getOrCreateEditor,
  saveSelection,
  getSavedSelection,
} from "@/components/editor/editor-store";

interface TextEditorProps {
  file: FileEntry;
  basePath: string;
}

/**
 * Main TextEditor component
 * Receives file with content already loaded from workspace-level query.
 *
 * The editor instance is created (or retrieved) from the module-level
 * editor-store, so undo history, scroll position, and internal Slate state
 * survive across Dockable tab switches that unmount/remount this component.
 */
export function TextEditor({ file, basePath }: TextEditorProps) {
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Single ref tracking the last contentHash we know about — whether from our own
  // save or from the initial load. When file.contentHash differs from this, it's
  // a genuinely external change that requires re-deserializing the editor content.
  const lastKnownHashRef = useRef<string>(file.contentHash || "");
  // Flag to suppress handleChange during programmatic setValue calls (external updates).
  // Without this, setValue triggers onValueChange which starts a debounced save of
  // content we just received from disk — creating a pointless write-back.
  const suppressSaveRef = useRef(false);

  // Get (or create on first mount) the persistent editor instance.
  // On first call for this file path, the content is deserialized into the editor.
  // On subsequent mounts (tab switch), the existing instance with its undo history
  // is returned — the `content` argument is ignored.
  const editor = getOrCreateEditor(file.path, file.content);

  // Plugin-specific transforms (h1, blockquote, link, etc.) are dynamically added
  // by plugins and not reflected in the base PlateEditor type. Use `tf` as `any`
  // for toolbar handlers that call these plugin transforms.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tf = editor.tf as any;

  // Detect external file changes and update editor content
  useEffect(() => {
    if (!editor || !file.contentHash) return;

    // Skip if contentHash matches what we already know about —
    // either from our own save or the last external update we processed
    if (file.contentHash === lastKnownHashRef.current) return;

    console.log(
      `[text-editor] External change detected for ${file.path}, updating editor`,
    );

    // Deserialize new content
    const newNodes = editor
      .getApi(MarkdownPlugin)
      .markdown.deserialize(file.content);

    // Suppress the onValueChange callback that setValue will trigger —
    // we don't want to write back content we just received from disk.
    suppressSaveRef.current = true;

    // Clear selection first to prevent stale path references, then replace
    // content through Slate's operation system (avoids direct mutation which
    // leaves selection pointing at nodes that no longer exist).
    editor.tf.deselect();
    editor.tf.setValue(newNodes);

    // Re-enable saves after the current React commit cycle completes
    // (onValueChange fires synchronously during setValue, so this is safe).
    suppressSaveRef.current = false;

    // Update ref to track this hash
    lastKnownHashRef.current = file.contentHash;
  }, [editor, file.contentHash, file.content, file.path]);

  const handleChange = useCallback(() => {
    if (!editor) return;

    // Don't save when the change came from programmatic setValue (external update)
    if (suppressSaveRef.current) return;

    // Cancel any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saves by 500ms
    saveTimeoutRef.current = setTimeout(() => {
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      // Normalize: remove HTML entity for space
      const normalizedMarkdown = markdown.replace(/&#x20;/g, "");

      // Pre-compute the hash so we can recognize our own write when it echoes back
      // through the collection update (contentHash change)
      const hash = calculateContentHash(normalizedMarkdown);
      lastKnownHashRef.current = hash;

      // Save directly - Rust will filter out self-writes from file watcher
      writeFileContent(basePath, file.path, normalizedMarkdown);
    }, 500);
  }, [editor, file.path, basePath]);

  // Cleanup pending saves on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Restore focus and selection when this editor mounts.
  //
  // Window.tsx only renders the selected tab's content, so this component
  // unmounts when switching away and remounts when switching back.
  // We save the selection on unmount and restore it here.
  //
  // Timing: useEffect fires after Editable's useLayoutEffect has set
  // EDITOR_TO_ELEMENT. A single rAF waits for browser paint and focus
  // events to settle. We blur first to clear stale IS_FOCUSED state
  // (the tab click may leave it truthy), then focus at the saved position.
  useEffect(() => {
    if (!editor) return;

    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;

      // Force-clear IS_FOCUSED so DOMEditor.focus() doesn't bail as no-op
      editor.tf.blur();

      const saved = getSavedSelection(file.path);
      if (saved) {
        editor.tf.focus({ at: saved });
      } else {
        editor.tf.focus();
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      // Save selection on unmount so it survives the remount cycle
      if (editor.selection) {
        saveSelection(file.path, editor.selection);
      }
    };
  }, [editor, file.path]);

  return (
    <Plate editor={editor} onValueChange={handleChange}>
      <div className="flex flex-col flex-1 min-h-0 w-full z-0">
        <FixedToolbar className="shrink-0 justify-start gap-1 flex-wrap">
          <ToolbarButton onClick={() => tf.h1.toggle()} tooltip="Heading 1">
            H1
          </ToolbarButton>
          <ToolbarButton onClick={() => tf.h2.toggle()} tooltip="Heading 2">
            H2
          </ToolbarButton>
          <ToolbarButton onClick={() => tf.h3.toggle()} tooltip="Heading 3">
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
            onClick={() => tf.blockquote.toggle()}
            tooltip="Blockquote"
          >
            Quote
          </ToolbarButton>
          <ToolbarButton
            onClick={() => tf.codeBlock.toggle()}
            tooltip="Code Block (⌘+Alt+8)"
          >
            {"</>"}
          </ToolbarButton>

          <Separator orientation="vertical" className="h-6" />

          <ToolbarButton onClick={() => tf.link.toggle()} tooltip="Toggle Link">
            <Link2Icon className="h-4 w-4" />
          </ToolbarButton>
        </FixedToolbar>
        <EditorContainer className="!h-auto min-h-0 flex-1">
          <Editor placeholder="Type your amazing content here..." />
        </EditorContainer>
      </div>
    </Plate>
  );
}
