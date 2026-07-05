import { EditorContent } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVertical } from "lucide-react";
import type { FileEntry } from "../../utils/fs";
import {
  getOrCreateEditor,
  isMarkdownInstance,
} from "@/components/editor/editor-store";
import { useEditorFileSync } from "./use-editor-file-sync";
import { useEditorFocusLifecycle } from "./use-editor-focus-lifecycle";
import { useLinkPrompt } from "./use-link-prompt";
import { TiptapToolbar } from "./tiptap-toolbar";
import { LinkBubbleMenu } from "./tiptap-link-menu";
import { TableMenu } from "./tiptap-table-menu";
import { cn } from "@/lib/utils";
import { dropZoneProps, getProtocolContext } from "@/utils/drag-protocol";
import { isImageFile } from "@/utils/fs";
import "./tiptap.css";

interface TextEditorProps {
  file: FileEntry;
  basePath: string;
  isContentLoaded: boolean;
  /** Set when the content read failed — file.content is NOT the real content. */
  contentError?: string;
}

export function TextEditor({
  file,
  basePath,
  isContentLoaded,
  contentError,
}: TextEditorProps) {
  const instance = getOrCreateEditor(file.path, {
    type: "markdown",
    content: file.content ?? "",
    basePath,
  });

  if (!isMarkdownInstance(instance)) {
    throw new Error("Failed to create markdown editor");
  }

  const editor = instance.editor;

  useEditorFileSync(editor, file, basePath, isContentLoaded, contentError);
  useEditorFocusLifecycle(editor, file.path);
  const handleLinkToggle = useLinkPrompt(editor);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full z-0">
      <TiptapToolbar editor={editor} onLinkToggle={handleLinkToggle} />
      <div
        // Dropping a file here opens it as a tab in THIS editor's window;
        // dropping an image file inserts it into the document at the drop
        // point. Pointer drags (file tree) dispatch through this zone;
        // native drags are additionally guarded by the protocol handler in
        // the ProseMirror handleDrop chain. Drop feedback mirrors the
        // dockable tab bar (inset ring shadow + tint).
        className={cn(
          "flex-1 min-h-0 overflow-auto tiptap-editor-wrapper",
          "data-[mtr-drop-over=true]:shadow-[0_0_0_1px_hsl(var(--ring))_inset]",
          "data-[mtr-drop-over=true]:bg-[hsl(var(--ring)/0.06)]",
        )}
        {...dropZoneProps({
          accepts: ["file"],
          onDrop: (payload, info) => {
            if (payload.fileType !== "file") return;

            if (isImageFile(payload.path)) {
              const src = payload.path.startsWith(basePath + "/")
                ? payload.path.slice(basePath.length + 1)
                : payload.path;
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
        })}
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
