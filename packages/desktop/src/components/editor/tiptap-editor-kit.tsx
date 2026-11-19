import { Extension, getTextSerializersFromSchema, type TextSerializer } from "@tiptap/core";
import type { CodeBlockOptions } from "@tiptap/extension-code-block";

/** Its diff blocks' paths are in `workspaceRoot`'s workspace. */
type MarkdownCodeBlockOptions = CodeBlockOptions & { workspaceRoot: string | null };
import { Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import { EditorImage } from "./editor-image-node";
import { FrontmatterNode } from "./frontmatter-node";
import { NodeIndex, widgetRendererNodes, PROMPT_DRAFT_NODE_NAME } from "@notefig/widgets";
// By path, not through the barrel: @pierre/diffs registers custom elements
// on import, and the barrel also loads in the markdown worker, which has none.
import { codeHighlight } from "@notefig/widgets/code-highlight";
import { reactNodeView } from "@notefig/widgets/react-node-view";
import { codeLanguagePicker } from "@notefig/widgets/code-language";
import { codeDiff } from "@notefig/widgets/diff-block/extension";
import {
  createSchemaExtensions,
  MarkdownImageBase,
  CodeBlock,
} from "./editor-schema-kit";

/**
 * Rendering uses a React node view that resolves local paths through
 * useImageUrl / the platform's fs.resolveAssetUrl (the same async mechanism
 * behind ImageViewer). The node attrs always store the canonical markdown
 * path — serialization is unaffected. filePath/workspaceRoot are passed
 * per-editor from editor-store.ts; relative srcs resolve against the doc's
 * own directory first, then the workspace root (Obsidian accepts both).
 */
export const MarkdownImage = MarkdownImageBase.extend({
  addNodeView() {
    return reactNodeView(EditorImage);
  },
});

/**
 * Code blocks, highlighted like the code viewer (`codeHighlight`), with a
 * language picker, and drawn as diffs when they hold one (`codeDiff`). The
 * schema, the `diff` attribute included, is the worker's (CodeBlock), so
 * this is presentation only.
 */
export const MarkdownCodeBlock = CodeBlock.extend<MarkdownCodeBlockOptions>({
  addOptions() {
    return { ...this.parent!(), workspaceRoot: null };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      codeHighlight(),
      codeLanguagePicker(),
      codeDiff({ workspacePath: this.options.workspaceRoot }),
    ];
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

/**
 * The browser's own undo (⌘Z the keymap left unhandled, Edit ▸ Undo) fires
 * `historyUndo`/`historyRedo` at the contenteditable it last saw edited, not
 * the focused one — which can be a kept, hidden tab's editor. Only the
 * focused editor answers it; above StarterKit's priority so this runs before
 * the history plugin's own handler.
 */
const NativeHistoryFocusGuard = Extension.create({
  name: "nativeHistoryFocusGuard",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (view, event) => {
              if (!event.inputType?.startsWith("history")) return false;
              if (view.hasFocus()) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});

/**
 * A transaction that changes nothing — no step, selection, stored marks,
 * scroll or meta — is dropped before it applies. Tiptap's `commands.x()`
 * dispatches even when x declines, and a Backspace runs four such handlers
 * (the list keymap, the mention, the core keymap, the widget's): each was a
 * whole view update, plugin views and editor-state subscribers included.
 */
const SkipEmptyTransactions = Extension.create({
  name: "skipEmptyTransactions",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (tr) =>
          tr.docChanged ||
          tr.selectionSet ||
          tr.storedMarksSet ||
          tr.scrolledIntoView ||
          !tr.isGeneric,
      }),
    ];
  },
});

/**
 * A copy's plain text keeps each link's target (MET-295), written as
 * `[text](url)`, so a paste that only takes plain text (a terminal, Claude
 * Code, a plain field) doesn't lose it. Everything else is tiptap's own
 * plain text (`getTextBetween`): no other markdown, no escapes. A link
 * whose text is its URL is written as the URL alone.
 */
const LinkKeepingCopy = Extension.create({
  name: "linkKeepingCopy",

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        props: {
          clipboardTextSerializer: () => {
            const { doc, selection } = editor.state;
            const serializers = getTextSerializersFromSchema(editor.schema);
            return [...selection.ranges]
              .sort((a, b) => a.$from.pos - b.$from.pos)
              .map(({ $from, $to }) => textWithLinks(doc, $from.pos, $to.pos, serializers))
              .join("\n\n");
          },
        },
      }),
    ];
  },
});

/** `getTextBetween`, with each run of linked text written as a link. */
function textWithLinks(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  serializers: Record<string, TextSerializer>,
): string {
  let text = "";
  let href: string | null = null;
  let label = 0;
  const closeLink = () => {
    if (href === null) return;
    const shown = text.slice(label);
    text = text.slice(0, label) + (shown === href ? href : `[${shown}](${href})`);
    href = null;
  };
  doc.nodesBetween(from, to, (node, pos, parent, index) => {
    const linked: unknown = node.isText ? node.marks.find((mark) => mark.type.name === "link")?.attrs.href : null;
    const next = typeof linked === "string" && linked ? linked : null;
    if (next !== href) {
      closeLink();
      if (next !== null) [href, label] = [next, text.length];
    }
    if (node.isBlock && pos > from) text += "\n\n";
    const serializer = serializers[node.type.name];
    if (serializer) {
      if (parent) text += serializer({ node, pos, parent, index, range: { from, to } });
      return false;
    }
    if (node.isText) text += node.text!.slice(Math.max(from, pos) - pos, to - pos);
    return true;
  });
  closeLink();
  return text;
}

export const editorExtensions = [
  ...createSchemaExtensions(
    MarkdownImage,
    MarkdownCodeBlock,
    // Unconfigured: schema-only instances never self-insert the empty-doc
    // keeper. editor-store.ts swaps these for per-document configured ones.
    widgetRendererNodes({ filePath: "", basePath: "" }),
    FrontmatterNode,
  ),
  Placeholder.configure({
    // A prompt widget's draft is a textblock of this document, so it would
    // otherwise inherit the document's own prompt. The widget paints its
    // own placeholder instead — it knows whether it is asking for the first
    // prompt or a follow-up reply, and this extension has one string for
    // the whole file.
    placeholder: ({ node }) =>
      node.type.name === PROMPT_DRAFT_NODE_NAME
        ? ""
        : "Type something, or press / for AI…",
  }),
  CharacterCount,
  // Where the widgets' and code blocks' nodes are, for their plugins.
  NodeIndex,
  NativeFormatIntercept,
  NativeHistoryFocusGuard,
  SkipEmptyTransactions,
  LinkKeepingCopy,
];
