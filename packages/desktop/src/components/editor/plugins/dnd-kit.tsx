"use client";

import { DndProvider } from "react-dnd";
import { TouchBackend } from "react-dnd-touch-backend";

import { DndPlugin } from "@platejs/dnd";
import { PlaceholderPlugin } from "@platejs/media/react";

import { BlockDraggable } from "@/components/ui/block-draggable";

// TouchBackend options to enable mouse events on desktop
// This provides better Safari compatibility than HTML5Backend
const touchBackendOptions = {
  enableMouseEvents: true,
  enableTouchEvents: true,
  delayTouchStart: 0,
  delayMouseStart: 0,
  touchSlop: 10,
  ignoreContextMenu: true,
};

export const DndKit = [
  DndPlugin.configure({
    options: {
      enableScroller: true,
      onDropFiles: ({ dragItem, editor, target }) => {
        editor
          .getTransforms(PlaceholderPlugin)
          .insert.media(dragItem.files, { at: target, nextBlock: false });
      },
    },
    render: {
      aboveNodes: BlockDraggable,
      aboveSlate: ({ children }) => (
        <DndProvider backend={TouchBackend} options={touchBackendOptions}>
          {children}
        </DndProvider>
      ),
    },
  }),
];
