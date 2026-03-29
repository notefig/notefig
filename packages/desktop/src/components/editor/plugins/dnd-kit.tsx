"use client";

import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

import { DndPlugin } from "@platejs/dnd";

import { BlockDraggable } from "@/components/ui/block-draggable";

// Type for the dynamically added insert.media transform from PlaceholderPlugin
type EditorWithMediaTransforms = {
  tf: {
    insert?: {
      media?: (
        files: FileList | File[],
        options?: { at?: unknown; nextBlock?: boolean },
      ) => void;
    };
  };
};

export const DndKit = [
  DndPlugin.configure({
    options: {
      enableScroller: true,
      onDropFiles: ({ dragItem, editor, target }) => {
        const editorWithMedia = editor as unknown as EditorWithMediaTransforms;

        if (!editorWithMedia.tf.insert?.media) {
          console.error("[DndKit] editor.tf.insert.media is not available");
          return;
        }

        editorWithMedia.tf.insert.media(dragItem.files, {
          at: target,
          nextBlock: false,
        });
      },
    },
    render: {
      aboveNodes: BlockDraggable,
      aboveSlate: ({ children }) => (
        <DndProvider backend={HTML5Backend}>{children}</DndProvider>
      ),
    },
  }),
];
