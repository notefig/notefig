"use client";

import { BlockSelectionPlugin } from "@platejs/selection/react";
import { getPluginTypes, KEYS } from "platejs";

import { BlockSelection } from "@/components/ui/block-selection";
import { BlockSelectionAfterEditable } from "@/components/ui/block-selection-after-editable";

export const BlockSelectionKit = [
  BlockSelectionPlugin.configure(({ editor }) => ({
    options: {
      enableContextMenu: true,
      isSelectable: (element) =>
        !getPluginTypes(editor, [KEYS.column, KEYS.codeLine, KEYS.td]).includes(
          element.type,
        ),
    },
    render: {
      // Custom afterEditable component that fixes clipboard operations.
      // The original uses deprecated document.execCommand("copy") which doesn't
      // work in Tauri. Our version uses the native ClipboardEvent API.
      afterEditable: BlockSelectionAfterEditable,
      belowRootNodes: (props) => {
        if (!props.attributes.className?.includes("slate-selectable"))
          return null;

        return <BlockSelection {...(props as any)} />;
      },
    },
  })),
];
