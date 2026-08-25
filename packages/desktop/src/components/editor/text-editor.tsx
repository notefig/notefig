import { EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVertical } from "lucide-react";
import type { FileEntry } from "../../utils/fs";
import {
  getOrCreateEditor,
  isMarkdownInstance,
} from "@/components/editor/editor-store";
import { useEditorFileSync } from "./use-editor-file-sync";
import { useEditorFocusLifecycle } from "./use-editor-focus-lifecycle";
import { useEditorViewportMemory } from "./use-editor-viewport-memory";
import { useLinkPrompt } from "./use-link-prompt";
import { TiptapToolbar } from "./tiptap-toolbar";
import { LinkBubbleMenu } from "./tiptap-link-menu";
import { TableMenu } from "./tiptap-table-menu";
import { cn } from "@/lib/utils";
import { dropZoneProps, getProtocolContext } from "@/utils/drag-protocol";
import { isImageFile } from "@/utils/fs";
import { relativeTreePath } from "@/utils/path";
import "./tiptap.css";

interface TextEditorProps {
  file: FileEntry;
  basePath: string;
  isContentLoaded: boolean;
  /** Set when the content read failed — file.content is NOT the real content. */
  contentError?: string;
  /** Pre-parsed doc JSON from the conversion worker. Required to create an
   * editor; may be omitted only when the instance already exists. */
  initialDoc?: JSONContent;
}

export function TextEditor({
  file,
  basePath,
  isContentLoaded,
  contentError,
  initialDoc,
}: TextEditorProps) {
  const instance = getOrCreateEditor(file.path, {
    type: "markdown",
    content: initialDoc,
    basePath,
  });

  if (!isMarkdownInstance(instance)) {
    throw new Error("Failed to create markdown editor");
  }

  const editor = instance.editor;

  useEditorFileSync(editor, file, basePath, isContentLoaded, contentError);
  useEditorFocusLifecycle(editor, file.path);
  const scrollRef = useEditorViewportMemory(editor, file.path);
  const handleLinkToggle = useLinkPrompt(editor);

  // The contenteditable fills the wrapper's height (tiptap.css), but the
  // side gutters around the centered prose column and its padding are still
  // outside ProseMirror — clicking there should focus the editor at the
  // nearest position instead of doing nothing.
  const handleGutterMouseDown = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && !target.matches(".prose")) return;
    event.preventDefault();
    // Clamp into the contenteditable's rect so clicks on the padding band or
    // side gutters resolve to the nearest position; posAtCoords returns null
    // outside the rect, and the old focus("end") fallback yanked the viewport
    // to the document end.
    const rect = editor.view.dom.getBoundingClientRect();
    const pos = editor.view.posAtCoords({
      left: Math.min(Math.max(event.clientX, rect.left + 1), rect.right - 1),
      top: Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1),
    });
    if (!pos) return;
    // The clicked point is already on screen — never scroll.
    editor
      .chain()
      .focus(null, { scrollIntoView: false })
      .setTextSelection(pos.pos)
      .run();
  };

  // Drop zone: files open as tabs in this editor's window; image files
  // insert into the document at the drop point.
  const dropZone = dropZoneProps({
    accepts: ["file"],
    onDrop: (payload, info) => {
      if (payload.fileType !== "file") return;

      if (isImageFile(payload.path)) {
        const src = relativeTreePath(basePath, payload.path) || payload.path;
        const pos =
          editor.view.posAtCoords({
            left: info.position.x,
            top: info.position.y,
          })?.pos ?? editor.state.selection.from;
        editor.view.dispatch(
          editor.state.tr.insert(
            pos,
            editor.state.schema.nodes.image.create({ src }),
          ),
        );
        return;
      }

      getProtocolContext().openFile?.({
        tabId: payload.path,
        intent: "new-tab",
        targetWindowId:
          info.element
            .closest("[data-dockable-window-id]")
            ?.getAttribute("data-dockable-window-id") ?? undefined,
        moveIfOpen: true,
      });
    },
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full z-0">
      <TiptapToolbar editor={editor} onLinkToggle={handleLinkToggle} />
      <div
        className={cn(
          "flex-1 min-h-0 overflow-auto tiptap-editor-wrapper",
          "data-[mtr-drop-over=true]:shadow-[0_0_0_1px_hsl(var(--ring))_inset]",
          "data-[mtr-drop-over=true]:bg-[hsl(var(--ring)/0.06)]",
        )}
        onMouseDown={handleGutterMouseDown}
        {...dropZone}
        // This element is both the drop zone and the document's scroller,
        // and each wants a ref.
        ref={(element: HTMLDivElement | null) => {
          dropZone.ref(element);
          scrollRef.current = element;
        }}
      >
        <DragHandle editor={editor} nested>
          <GripVertical className="w-4 h-4 text-muted-foreground/40 hover:text-muted-foreground" />
        </DragHandle>
        <LinkBubbleMenu
          editor={editor}
          onEdit={handleLinkToggle}
          basePath={basePath}
          filePath={file.path}
        />
        <TableMenu editor={editor} />
        <EditorContent
          editor={editor}
          className="prose prose-sm dark:prose-invert max-w-2xl mx-auto p-4 outline-none"
        />
      </div>
    </div>
  );
}
