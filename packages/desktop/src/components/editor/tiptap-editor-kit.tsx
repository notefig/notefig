import StarterKit from "@tiptap/starter-kit";
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
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

/**
 * tiptap-markdown only maintains its `tight` list attribute on bulletList and
 * orderedList, so taskList always serializes loose (blank lines between
 * items). Mirror the same attribute semantics here so task lists round-trip.
 */
const MarkdownTaskList = TaskList.extend({
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
const MarkdownTaskItem = TaskItem.extend({
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
                item.setAttribute("data-checked", String(input.checked));
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
 */
const MarkdownImage = Image.extend({
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
          const src = node.attrs.src.replace(/[()]/g, "\\$&");
          const title = node.attrs.title
            ? ` "${node.attrs.title.replace(/"/g, '\\"')}"`
            : "";
          state.write(`![${alt}](${src}${title})`);
          state.closeBlock(node);
        },
      },
    };
  },
});

export const editorExtensions = [
  StarterKit.configure({
    codeBlock: false,
    // dropcursor gives drag-drop a visible insertion indicator; gapcursor
    // makes positions before/after tables and block images reachable.
    // StarterKit bundles link and underline in Tiptap v3; disable them so the
    // standalone configured instances below are the only registrations.
    link: false,
    underline: false,
  }),
  // html must stay on: underline/highlight/sub/sup have no markdown syntax
  // and serialize as inline HTML tags (which is also what the previous
  // Plate editor wrote to disk). With html off they are silently dropped
  // from the file on save.
  Markdown.configure({
    html: true,
    tightLists: true,
    bulletListMarker: "-",
    linkify: false,
    breaks: false,
    transformPastedText: true,
    transformCopiedText: false,
  }),
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
  MarkdownTaskItem.configure({
    nested: false,
  }),
  // Without an image node in the schema, ProseMirror drops <img> during
  // parse and every image in the file is deleted by the next autosave.
  // Rendering local paths through Tauri's asset protocol is Phase 5; this
  // is about not destroying data.
  MarkdownImage.configure({
    allowBase64: true,
  }),
  Table.configure({
    resizable: true,
  }),
  TableRow,
  TableCell,
  TableHeader,
  CodeBlockLowlight.configure({
    lowlight,
  }),
  Placeholder.configure({
    placeholder: "Type something...",
  }),
  CharacterCount,
];
