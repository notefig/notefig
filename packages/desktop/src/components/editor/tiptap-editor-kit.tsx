import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import { EditorImage } from "./editor-image-node";
import { BlobNodeView } from "./blobs/blob-node-view";
import { AiPromptNode } from "./ai-prompt-node";
import { FrontmatterNode } from "./frontmatter-node";
import {
  createSchemaExtensions,
  MarkdownImageBase,
  CodeBlockLowlight,
} from "./editor-schema-kit";

/**
 * Rendering uses a React node view that resolves local paths through
 * useImageUrl / platformAdapter.fs.resolveAssetUrl (the same async mechanism
 * behind ImageViewer). The node attrs always store the canonical markdown
 * path — serialization is unaffected. workspaceRoot is passed per-editor
 * from editor-store.ts so resolution works regardless of the doc's directory.
 */
export const MarkdownImage = MarkdownImageBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(EditorImage);
  },
});

/**
 * Renders every code block through BlobNodeView, which itself dispatches on
 * the `language` attr: metrists:* fences render as interactive blob widgets,
 * everything else falls back to the ordinary code block chrome. Schema is
 * unchanged (CodeBlockLowlight's own attrs/parsing), so this is presentation
 * only — the worker's markdown round-trip is unaffected.
 */
export const MarkdownCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(BlobNodeView);
  },
});

/**
 * The OS webview's native context menu (WKWebView's Font ▸ Bold/Italic/…)
 * drives editing through `beforeinput` events with `format*` inputTypes,
 * which ProseMirror ignores — native editing would then mutate the
 * contenteditable DOM underneath it. Map the marks we support to editor
 * commands and swallow the rest so unmapped items (justify, indent, text
 * direction, …) are no-ops instead of DOM corruption.
 */
const nativeFormatCommands: Record<string, "toggleBold" | "toggleItalic" | "toggleUnderline" | "toggleStrike"> = {
  formatBold: "toggleBold",
  formatItalic: "toggleItalic",
  formatUnderline: "toggleUnderline",
  formatStrikeThrough: "toggleStrike",
};

const NativeFormatIntercept = Extension.create({
  name: "nativeFormatIntercept",

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (view, event) => {
              if (!event.inputType?.startsWith("format")) return false;
              // Custom handlers fire even when the view isn't editable.
              if (!view.editable) return true;
              event.preventDefault();
              const command = nativeFormatCommands[event.inputType];
              if (command) {
                editor.chain().focus()[command]().run();
              }
              return true;
            },
          },
        },
      }),
    ];
  },
});

export const editorExtensions = [
  ...createSchemaExtensions(
    MarkdownImage,
    MarkdownCodeBlock,
    AiPromptNode,
    FrontmatterNode,
  ),
  Placeholder.configure({ placeholder: "Type something, or press / for AI…" }),
  CharacterCount,
  NativeFormatIntercept,
];
