import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Underline from "@tiptap/extension-underline";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
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

export const editorExtensions = [
  StarterKit.configure({
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
  }),
  Markdown.configure({
    html: false,
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
  TaskList,
  TaskItem.configure({
    nested: true,
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
