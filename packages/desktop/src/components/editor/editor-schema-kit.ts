/**
 * Worker-safe editor kit: every extension that affects the document schema
 * or the markdown round-trip, and nothing that needs React or a live DOM.
 *
 * This module is imported both by the renderer editor (tiptap-editor-kit.tsx
 * adds node views and UI-only extensions on top) and by the markdown codec
 * that runs inside the conversion Web Worker. Keeping one source of truth
 * here is what guarantees the worker's schema — and therefore its parse and
 * serialize output — is identical to the editor's.
 */

import { Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ListItem } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import Underline from "@tiptap/extension-underline";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";

export { CodeBlockLowlight };

export const lowlight = createLowlight(common);

// html must stay on: underline/highlight/sub/sup have no markdown syntax
// and serialize as inline HTML tags (which is also what the previous
// Plate editor wrote to disk). With html off they are silently dropped
// from the file on save.
export const markdownOptions = {
  html: true,
  tightLists: true,
  bulletListMarker: "-",
  linkify: false,
  breaks: false,
  transformPastedText: true,
  transformCopiedText: false,
} as const;

/**
 * tiptap-markdown only maintains its `tight` list attribute on bulletList and
 * orderedList, so taskList always serializes loose (blank lines between
 * items). Mirror the same attribute semantics here so task lists round-trip.
 */
export const MarkdownTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        parseHTML: (element) =>
          element.getAttribute("data-tight") === "true" ||
          !element.querySelector("p"),
        renderHTML: (attributes) => ({
          "data-tight": attributes.tight ? "true" : null,
        }),
      },
    };
  },
});

/**
 * markdown-it-task-lists only recognizes "[ ] " / "[x] " with a trailing
 * space, so an empty task item ("- [ ]") re-parses as a plain bullet with
 * literal "[ ]" text and the checkbox is destroyed on the next save. Serialize
 * empty items without the dangling space and convert the ones the plugin
 * missed during parse.
 */
export const MarkdownTaskItem = TaskItem.extend({
  // Widened like PromptHostListItem below: the "/" summon may replace the
  // item's only paragraph with the aiPrompt widget (MET-93). Static override
  // is safe because this app always configures `nested: false` (stock
  // content would be `paragraph+`).
  content: "(paragraph | aiPrompt) paragraph*",

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            renderContent: (node: unknown) => void;
          },
          node: { attrs: { checked: boolean }; textContent: string },
        ) {
          const check = node.attrs.checked ? "[x]" : "[ ]";
          state.write(node.textContent ? `${check} ` : check);
          state.renderContent(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            // items matched by markdown-it-task-lists
            element.querySelectorAll(".task-list-item").forEach((item) => {
              const input = item.querySelector("input");
              item.setAttribute("data-type", "taskItem");
              if (input) {
                // Attribute, not the .checked property: for parser-generated
                // HTML they are equivalent in a real DOM, and the linkedom
                // shim in the conversion worker only implements the attribute.
                item.setAttribute(
                  "data-checked",
                  String(input.hasAttribute("checked") || input.checked === true),
                );
                input.remove();
              }
            });
            // empty items the plugin's trailing-space requirement missed
            element
              .querySelectorAll("ul > li:not([data-type])")
              .forEach((item) => {
                const match = item.textContent
                  ?.trim()
                  .match(/^\[( |x|X)\]$/);
                if (!match) return;
                item.setAttribute("data-type", "taskItem");
                item.setAttribute(
                  "data-checked",
                  String(match[1].toLowerCase() === "x"),
                );
                const textHolder = item.querySelector("p") ?? item;
                textHolder.textContent = "";
                item.parentElement?.setAttribute("data-type", "taskList");
              });
          },
        },
      },
    };
  },
});

/**
 * tiptap-markdown reuses prosemirror-markdown's image serializer, which is
 * written for schemas where image is an inline node. Tiptap's Image is a
 * block node, so without closeBlock the following block gets glued onto the
 * image line ("![x](y)After").
 *
 * This base carries only the schema + markdown spec; the renderer kit extends
 * it with the React node view (which is presentation-only and leaves the
 * schema, and therefore doc JSON compatibility, unchanged).
 */
export const MarkdownImageBase = Image.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            esc: (s: string) => string;
            write: (s: string) => void;
            closeBlock: (node: unknown) => void;
          },
          node: {
            attrs: { src: string; alt?: string | null; title?: string | null };
          },
        ) {
          const alt = state.esc(node.attrs.alt || "");
          const src = node.attrs.src.replace(/[()]/g, String.raw`\$&`);
          const title = node.attrs.title
            ? ` "${node.attrs.title.replace(/"/g, String.raw`\"`)}"`
            : "";
          state.write(`![${alt}](${src}${title})`);
          state.closeBlock(node);
        },
      },
    };
  },
});

/**
 * Transactions that only touch UI-only nodes (today: the aiPrompt widget)
 * carry this meta so the autosave path can ignore them — they never change
 * the serialized markdown, and a save would only churn the file watcher.
 */
export const UI_ONLY_TRANSACTION_META = "uiOnlyNodeChange";

/**
 * The inline AI prompt widget's schema node — a block atom that is pure UI:
 * it serializes to NOTHING (the markdown storage below), so it can live in
 * the document flow without ever touching the file on disk. This base is
 * worker-safe (schema + serializer only); the renderer extends it with the
 * React node view and the empty-doc keeper in ai-prompt-node.tsx. Without
 * the explicit no-op serializer, tiptap-markdown's html fallback would
 * write the node's placeholder <div> into the file.
 */
export const AiPromptNodeBase = Node.create({
  name: "aiPrompt",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // True for instances summoned by typing "/" — gates the revert-to-"/"
      // contract (Esc / a second "/" turn the widget back into a literal
      // slash). Keeper-inserted nodes stay false. Never serialized.
      summoned: { default: false },
      // Per-instance identity: every widget keys its own state (draft,
      // bound turn) in prompt-blob-store by this id — a document can hold
      // several widgets, so the document path is not identity enough.
      // Minted at every creation site; null only for schema-default nodes,
      // which the node view repairs on mount. Never serialized.
      blobId: { default: null },
    };
  },

  parseHTML() {
    // Internal HTML round-trips only (clipboard); markdown never produces it.
    return [{ tag: 'div[data-type="ai-prompt"]' }];
  },

  renderHTML() {
    return ["div", { "data-type": "ai-prompt" }];
  },

  addStorage() {
    return {
      markdown: {
        serialize() {
          // UI-only: contributes nothing to the file.
        },
      },
    };
  },
});

/**
 * ListItem whose content admits the aiPrompt widget in place of the leading
 * paragraph. The stock `paragraph block*` expression forbids replacing an
 * item's only paragraph with the widget, which is exactly what the "/"
 * summon does inside a list (MET-93). Markdown output is unaffected: the
 * widget serializes to nothing, so a widget-only item round-trips the same
 * as an empty one.
 */
export const PromptHostListItem = ListItem.extend({
  content: "(paragraph | aiPrompt) block*",
});

/**
 * The schema-defining extension list, in the same order the editor has
 * always registered them (order can influence schema construction). The
 * image, codeBlock, and aiPrompt extensions are injectable so the renderer
 * can substitute their node-view-bearing subclasses without duplicating the
 * list.
 */
export function createSchemaExtensions(
  image: typeof MarkdownImageBase = MarkdownImageBase,
  codeBlock: typeof CodeBlockLowlight = CodeBlockLowlight,
  aiPrompt: typeof AiPromptNodeBase = AiPromptNodeBase,
) {
  return [
    StarterKit.configure({
      codeBlock: false,
      // StarterKit bundles link and underline in Tiptap v3; disable them so
      // the standalone configured instances below are the only registrations.
      link: false,
      underline: false,
      // Replaced by PromptHostListItem below (same node name, widened
      // content expression).
      listItem: false,
    }),
    PromptHostListItem,
    Markdown.configure(markdownOptions),
    Underline,
    Subscript,
    Superscript,
    Highlight,
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
    }),
    MarkdownTaskList,
    MarkdownTaskItem.configure({ nested: false }),
    image.configure({ allowBase64: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    codeBlock.configure({ lowlight }),
    aiPrompt,
  ];
}
