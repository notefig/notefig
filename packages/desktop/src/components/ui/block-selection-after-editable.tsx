"use client";

import * as React from "react";
import * as ReactDOM from "react-dom";

import {
  BlockSelectionPlugin,
  useSelectionArea,
} from "@platejs/selection/react";
import { KEYS, PathApi } from "platejs";
import { useEditorPlugin, useEditorRef, usePluginOption } from "platejs/react";
import { useHotkey } from "@tanstack/react-hotkeys";

export function BlockSelectionAfterEditable() {
  const editor = useEditorRef();
  const { api, getOption, setOption } = useEditorPlugin({
    key: KEYS.blockSelection,
  });
  const isSelectingSome = usePluginOption(
    BlockSelectionPlugin,
    "isSelectingSome",
  );
  const selectedIds = usePluginOption(BlockSelectionPlugin, "selectedIds");

  const removeSelectedBlocks = React.useCallback(
    (options: { selectPrevious?: boolean } = {}) => {
      const entries = [
        ...editor.api.nodes({
          at: [],
          match: (n: any) => !!n.id && selectedIds?.has(n.id),
        }),
      ];
      if (entries.length === 0) return null;

      const firstPath = entries[0][1];

      editor.tf.withoutNormalizing(() => {
        for (const [node, path] of [...entries].reverse()) {
          editor.tf.removeNodes({ at: path });
          api.blockSelection.delete((node as any).id);
        }

        if (editor.children.length === 0) {
          (editor as any).meta._forceFocus = true;
          editor.tf.focus();
          (editor as any).meta._forceFocus = false;
        } else if (options.selectPrevious) {
          const prevPath = PathApi.previous(firstPath);
          if (prevPath) {
            const prevEntry = editor.api.block({ at: prevPath });
            if (prevEntry)
              setOption("selectedIds", new Set([(prevEntry[0] as any).id]));
          }
        }
      });

      return firstPath;
    },
    [editor, api.blockSelection, selectedIds, setOption],
  );

  useSelectionArea();

  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isMounted, setIsMounted] = React.useState(false);
  const [portalContainer, setPortalContainer] =
    React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setIsMounted(true);
    setOption("shadowInputRef", inputRef);
    return () => {
      setIsMounted(false);
    };
  }, [setOption]);

  // Portal inside the editor tree (not document.body) so dockable hotkeys
  // scoped to dockableRef still receive events when this input has focus.
  React.useEffect(() => {
    const editorEl = editor.api.toDOMNode(editor);
    setPortalContainer(editorEl?.parentElement ?? editorEl ?? null);
  }, [editor, isSelectingSome]);

  React.useEffect(() => {
    if (!isSelectingSome) setOption("anchorId", null);
  }, [isSelectingSome, setOption]);

  React.useEffect(() => {
    if (isSelectingSome && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
    } else if (inputRef.current) {
      inputRef.current.blur();
    }
  }, [isSelectingSome]);

  // Hotkey options - only active when blocks are selected and scoped to the input
  const hotkeyOptions = React.useMemo(
    () => ({
      enabled: isSelectingSome,
      target: inputRef,
    }),
    [isSelectingSome],
  );

  // Navigation: Shift+Arrow to extend selection
  useHotkey(
    "Shift+ArrowUp",
    () => {
      api.blockSelection.shiftSelection("up");
    },
    hotkeyOptions,
  );

  useHotkey(
    "Shift+ArrowDown",
    () => {
      api.blockSelection.shiftSelection("down");
    },
    hotkeyOptions,
  );

  // Navigation: Arrow keys to move selection
  useHotkey(
    "ArrowUp",
    () => {
      api.blockSelection.moveSelection("up");
    },
    hotkeyOptions,
  );

  useHotkey(
    "ArrowDown",
    () => {
      api.blockSelection.moveSelection("down");
    },
    hotkeyOptions,
  );

  // ArrowRight: Deselect and place cursor at end of last selected block
  useHotkey(
    "ArrowRight",
    () => {
      const entries = api.blockSelection.getNodes();
      if (entries.length > 0) {
        const [, lastPath] = entries.at(-1)!;
        api.blockSelection.deselect();
        (editor as any).meta._forceFocus = true;
        editor.tf.focus({ at: lastPath, edge: "end" });
        (editor as any).meta._forceFocus = undefined;
      }
    },
    hotkeyOptions,
  );

  // ArrowLeft: Deselect and place cursor at start of first selected block
  useHotkey(
    "ArrowLeft",
    () => {
      const entries = api.blockSelection.getNodes();
      if (entries.length > 0) {
        const [, firstPath] = entries[0];
        api.blockSelection.deselect();
        (editor as any).meta._forceFocus = true;
        editor.tf.focus({ at: firstPath, edge: "start" });
        (editor as any).meta._forceFocus = undefined;
      }
    },
    hotkeyOptions,
  );

  // Escape: Deselect and place cursor at the very end of the document
  useHotkey(
    "Escape",
    () => {
      api.blockSelection.deselect();
      (editor as any).meta._forceFocus = true;
      editor.tf.focus({ edge: "end" });
      (editor as any).meta._forceFocus = undefined;
    },
    hotkeyOptions,
  );

  // Undo/Redo
  useHotkey(
    "Mod+Z",
    () => {
      editor.undo();
    },
    hotkeyOptions,
  );

  useHotkey(
    "Mod+Shift+Z",
    () => {
      editor.redo();
    },
    hotkeyOptions,
  );

  // Select all blocks
  useHotkey(
    "Mod+A",
    () => {
      api.blockSelection.selectAll();
    },
    hotkeyOptions,
  );

  // Duplicate blocks
  useHotkey(
    "Mod+D",
    () => {
      (editor as any)
        .getTransforms(BlockSelectionPlugin)
        .blockSelection.duplicate();
    },
    hotkeyOptions,
  );

  // Enter to focus into selected block
  useHotkey(
    "Enter",
    () => {
      const entry = editor.api.node({
        at: [],
        block: true,
        match: (n: any) => !!n.id && selectedIds?.has(n.id),
      });
      if (entry) {
        const [, path] = entry;
        (editor as any).meta._forceFocus = true;
        editor.tf.focus({ at: path, edge: "end" });
        (editor as any).meta._forceFocus = undefined;
      }
    },
    hotkeyOptions,
  );

  // Delete selected blocks
  const editableHotkeyOptions = React.useMemo(
    () => ({
      enabled: isSelectingSome && !editor.api.isReadOnly(),
      target: inputRef,
    }),
    [isSelectingSome, editor],
  );

  useHotkey(
    "Backspace",
    () => {
      removeSelectedBlocks({ selectPrevious: true });
    },
    editableHotkeyOptions,
  );

  useHotkey(
    "Delete",
    () => {
      removeSelectedBlocks({ selectPrevious: false });
    },
    editableHotkeyOptions,
  );

  /**
   * Handle copy using native ClipboardEvent API.
   * This is the key fix - we write directly to e.clipboardData instead of
   * using the deprecated document.execCommand("copy").
   */
  const handleCopy = React.useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();

      if (!getOption("isSelectingSome")) return;

      const currentSelectedIds =
        editor.getOptions(BlockSelectionPlugin).selectedIds;
      const selectedEntries = editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes({ collapseTableRows: true });

      if (selectedEntries.length === 0) return;

      const selectedFragment = selectedEntries.map(([node]: any) => node);
      const data = e.clipboardData;

      if (!data) return;

      let textPlain = "";
      const div = document.createElement("div");

      editor.tf.withoutNormalizing(() => {
        selectedEntries.forEach(([, path]: any) => {
          editor.tf.select({
            anchor: editor.api.start(path)!,
            focus: editor.api.end(path)!,
          });

          const isEmpty = editor.api.isEmpty(path);

          if (isEmpty) {
            const after = editor.api.after(editor.selection!);
            if (after) {
              editor.tf.select({
                anchor: editor.api.start(path)!,
                focus: after,
              });
            }
          }

          if (!isEmpty) {
            editor.tf.setFragmentData(data);
          }

          if (isEmpty) {
            textPlain += "\n";
          } else {
            textPlain += `${data.getData("text/plain")}\n`;
          }

          const divChild = document.createElement("div");
          if (isEmpty) {
            divChild.innerHTML = "<p></p>";
          } else {
            divChild.innerHTML = data.getData("text/html");
          }
          div.append(divChild);
        });

        editor.tf.deselect();
        editor.setOption(
          BlockSelectionPlugin,
          "selectedIds",
          currentSelectedIds,
        );
      });

      // Set the final clipboard data
      data.setData("text/plain", textPlain);
      data.setData("text/html", div.innerHTML);

      const selectedFragmentStr = JSON.stringify(selectedFragment);
      const encodedFragment = window.btoa(
        encodeURIComponent(selectedFragmentStr),
      );
      data.setData("application/x-slate-fragment", encodedFragment);
    },
    [editor, getOption],
  );

  const handleCut = React.useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();

      if (getOption("isSelectingSome")) {
        // First copy the content
        handleCopy(e);

        // Then delete if not readonly
        if (!editor.api.isReadOnly()) {
          removeSelectedBlocks();
        }
      }
    },
    [editor, getOption, handleCopy, removeSelectedBlocks],
  );

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();

      if (!editor.api.isReadOnly()) {
        const entries = api.blockSelection.getNodes();

        if (entries.length > 0) {
          const [node, path] = entries.at(-1)!;

          if (!editor.api.isEmpty(node)) {
            const at = PathApi.next(path);
            editor.tf.insertNodes((editor as any).api.create.block({}, at), {
              at,
              select: true,
            });
          }

          editor.tf.insertData(e.nativeEvent.clipboardData!);

          // Select inserted blocks
          const ids = new Set<string>();
          editor.operations.forEach((op: any) => {
            if (
              op.type === "insert_node" &&
              op.node.id &&
              editor.api.isBlock(op.node)
            ) {
              ids.add(op.node.id);
            }
          });
          setOption("selectedIds", ids);
        }
      }
    },
    [editor, api.blockSelection, setOption],
  );

  if (!isMounted || !portalContainer || typeof window === "undefined") {
    return null;
  }

  return ReactDOM.createPortal(
    <input
      ref={inputRef}
      className="slate-shadow-input"
      style={{
        left: "-300px",
        opacity: 0,
        position: "fixed",
        top: "-300px",
        zIndex: 999,
      }}
      onCopy={handleCopy}
      onCut={handleCut}
      onPaste={handlePaste}
    />,
    portalContainer,
  );
}
