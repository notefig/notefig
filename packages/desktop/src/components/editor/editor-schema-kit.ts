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

import { Extension, Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
import {
  editorWidgets,
  registerContentlessNodeName,
  widgetSchemaNodes,
} from "@notefig/widgets";

// A document carrying only frontmatter is still an empty document, so the
// prompt widget's keeper must fire there (MET-137). The widget package knows
// its own contentless nodes; this one is ours to declare.
registerContentlessNodeName("frontmatter");

export { CodeBlockLowlight };

// The widget protocol owns this constant (widgets are why it exists);
// re-exported so editor-store.ts / use-editor-file-sync.ts keep importing
// the whole schema vocabulary from one place.
export { UI_ONLY_TRANSACTION_META } from "@notefig/widgets";

export const lowlight = createLowlight(common);

/**
 * The widget node names that may stand in for a list item's leading
 * paragraph, as an alternation for a content expression: `paragraph|aiPrompt`.
 * Composed from the widget definitions rather than written out, so adding a
 * summonable widget doesn't mean remembering to edit two content strings
 * here (see EditorWidgetDefinition.inlineHostable).
 */
const LEADING_BLOCK = [
  "paragraph",
  ...editorWidgets.filter((widget) => widget.inlineHostable).map((w) => w.name),
].join(" | ");

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
  // item's only paragraph with a summonable widget (MET-93). Static override
  // is safe because this app always configures `nested: false` (stock
  // content would be `paragraph+`).
  content: `(${LEADING_BLOCK}) paragraph*`,

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
                  String(
                    input.hasAttribute("checked") || input.checked === true,
                  ),
                );
                input.remove();
              }
            });
            // empty items the plugin's trailing-space requirement missed
            element
              .querySelectorAll("ul > li:not([data-type])")
              .forEach((item) => {
                const match = item.textContent?.trim().match(/^\[( |x|X)\]$/);
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
 * YAML frontmatter support (MET-137). The `---` fenced block at byte 0 is
 * document metadata, not markdown — without special handling markdown-it
 * parses it as a horizontal rule plus a setext heading of the raw YAML,
 * which the next save then destructively rewrites.
 *
 * Split of responsibilities:
 *  - splitFrontmatter: the one definition of "this file has frontmatter"
 *    (gray-matter convention: opening `---` at byte 0, closing `---` on its
 *    own line).
 *  - wrapParserWithFrontmatter: patches a tiptap-markdown parser so full-
 *    document parses emit a frontmatter node ahead of the parsed body.
 *    Inline parses (insertContentAt / the clipboard path) are left alone —
 *    pasted text must never grow a frontmatter node mid-document, and the
 *    doc's content expression (`frontmatter? block+`, DocWithFrontmatter
 *    below) would reject it anyway.
 *  - FrontmatterMarkdown applies the wrapper. It must be a subclass of the
 *    Markdown extension itself: Markdown runs at priority 50 (after every
 *    other hook) and parses the editor's initial content inside its own
 *    onBeforeCreate, immediately after constructing the parser — no other
 *    extension's hook can get between the two. The codec's fake editor
 *    invokes the same config.onBeforeCreate, so worker parses are wrapped
 *    identically by construction.
 *  - FrontmatterNodeBase.markdown.serialize re-emits the fences, so every
 *    serializer (worker codec and live getMarkdown()) round-trips it.
 *
 * The YAML text travels through the HTML hand-off URI-encoded in data-yaml:
 * it can contain any character, and encoding sidesteps entity-escaping
 * differences between the real DOM and the worker's linkedom shim.
 */
export function splitFrontmatter(markdown: string): {
  yaml: string | null;
  body: string;
} {
  const lines = markdown.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { yaml: null, body: markdown };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() !== "---") continue;
    let bodyStart = i + 1;
    // The conventional blank line after the closing fence belongs to the
    // fence (the serializer's closeBlock re-emits it), not to the body.
    if (lines[bodyStart] === "") bodyStart++;
    return {
      yaml: lines.slice(1, i).join("\n"),
      body: lines.slice(bodyStart).join("\n"),
    };
  }
  // Opening fence with no closing fence: a horizontal rule, not frontmatter.
  return { yaml: null, body: markdown };
}

export function wrapParserWithFrontmatter(storage: {
  parser: { parse(content: string, options?: { inline?: boolean }): unknown };
}): void {
  const inner = storage.parser.parse.bind(storage.parser);
  storage.parser.parse = (content, options) => {
    if (options?.inline || typeof content !== "string") {
      return inner(content, options);
    }
    const { yaml, body } = splitFrontmatter(content);
    if (yaml === null) return inner(content, options);
    const html = inner(body, options);
    return (
      `<div data-type="frontmatter" data-yaml="${encodeURIComponent(yaml)}"></div>` +
      (typeof html === "string" ? html : "")
    );
  };
}

interface FrontmatterMarkdownEditor {
  options: { content: unknown; initialContent?: unknown };
  storage: {
    markdown?: {
      parser: {
        parse(content: unknown, options?: { inline?: boolean }): unknown;
      };
    };
  };
}

const baseMarkdownOnBeforeCreate = (
  Markdown.config as unknown as {
    onBeforeCreate: (this: { editor: unknown; options: unknown }) => void;
  }
).onBeforeCreate;

export const FrontmatterMarkdown = Markdown.extend({
  onBeforeCreate() {
    const editor = this.editor as unknown as FrontmatterMarkdownEditor;
    // The base hook builds parser+serializer and immediately parses the
    // initial content — replay it against empty content, install the
    // frontmatter wrapper, then parse the real initial content through the
    // wrapped parser. (Explicit base call, not this.parent: the codec's
    // fake editor invokes this hook outside tiptap's extension plumbing,
    // where parent() doesn't exist.)
    const initialContent = editor.options.content;
    editor.options.content = "";
    baseMarkdownOnBeforeCreate.call(this);
    const storage = editor.storage.markdown!;
    wrapParserWithFrontmatter(storage);
    editor.options.initialContent = initialContent;
    editor.options.content = storage.parser.parse(initialContent);
  },
});

export const FrontmatterNodeBase = Node.create({
  name: "frontmatter",
  // Deliberately not in the "block" group: the only place the schema admits
  // it is the doc's own content expression (DocWithFrontmatter), which pins
  // it to position 0 — ProseMirror itself then forbids moving it, creating
  // a second one, or typing above it.
  atom: true,
  // Not selectable: the document opens with its selection at doc start,
  // which would otherwise resolve to a NodeSelection on this atom — the
  // browser paints the whole panel as selected and the first keystroke
  // would REPLACE the frontmatter with the typed text.
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      // The raw YAML between the fences, without them and without a
      // trailing newline. Byte-preserved: the panel UI edits it through the
      // yaml library's document API so comments, key order, and unknown
      // keys survive untouched.
      yaml: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="frontmatter"]',
        getAttrs: (element) => ({
          yaml: decodeURIComponent(element.getAttribute("data-yaml") ?? ""),
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "div",
      {
        "data-type": "frontmatter",
        "data-yaml": encodeURIComponent(node.attrs.yaml as string),
      },
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            closeBlock: (node: unknown) => void;
          },
          node: { attrs: { yaml: string } },
        ) {
          // An empty node contributes nothing (like aiPrompt): deleting
          // the last property must remove the fences from the file, not
          // leave "---\n---" behind. Corollary: bare "---\n---" fences
          // normalize away on the first save.
          const yaml = node.attrs.yaml;
          if (!yaml) return;
          state.write(`---\n${yaml}\n---`);
          state.closeBlock(node);
        },
      },
    };
  },
});

/**
 * Top node admitting an optional frontmatter block at position 0 and
 * nothing else frontmatter-shaped anywhere else. Replaces StarterKit's
 * stock Document (content: "block+").
 */
export const DocWithFrontmatter = Node.create({
  name: "doc",
  topNode: true,
  content: "frontmatter? block+",
});

/**
 * ListItem whose content admits summonable widgets in place of the leading
 * paragraph. The stock `paragraph block*` expression forbids replacing an
 * item's only paragraph with the widget, which is exactly what the "/"
 * summon does inside a list (MET-93). Markdown output is unaffected: the
 * widget serializes to nothing, so a widget-only item round-trips the same
 * as an empty one.
 */
export const PromptHostListItem = ListItem.extend({
  content: `(${LEADING_BLOCK}) block*`,
});

/**
 * Wrapper node types whose own dir="auto" governs both text flow and
 * layout that depends on `direction` — list markers (bullets/numbers) and
 * indentation for list items, cell text alignment for table cells. These
 * always own their own dir="auto" via the static attribute below.
 */
const DIRECTION_OWNING_WRAPPERS = new Set([
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "blockquote",
  "tableCell",
  "tableHeader",
]);

/**
 * Per-block RTL: gives text-bearing block nodes a real dir="auto"
 * attribute, so the browser resolves each block's own direction from its
 * first strong character (Farsi/Arabic vs. Latin). This has to be an actual
 * HTML attribute rather than the `unicode-bidi: plaintext` CSS trick — that
 * CSS-only approximation reorders inline text but never touches the box's
 * computed `direction`, so list markers (bullets/numbers), whose position
 * follows `direction`, stay pinned to the LTR side and can render off
 * (invisible) for RTL content. dir="auto" flips both correctly.
 *
 * Two mechanisms, split by a real HTML footgun:
 *
 * 1. DIRECTION_OWNING_WRAPPERS get a static dir="auto" attribute (always
 *    present, unconditional — the value is always "auto": parseHTML ignores
 *    whatever a pasted `dir` says and renderHTML always emits it, so this
 *    never becomes divergent persisted state).
 *
 * 2. paragraph/heading get dir="auto" via a decoration plugin instead of a
 *    static attribute, and only when their PARENT is not one of the wrappers
 *    above. Per the HTML dir=auto algorithm, an element's auto-direction
 *    scan skips the entire subtree of any descendant that itself carries a
 *    dir attribute. A listItem's only text is its leading paragraph — if
 *    that paragraph also carried its own dir="auto", the listItem's scan
 *    would find nothing to look at, fall back to its parent's direction
 *    (ltr), and the marker/indentation fix above would silently stop
 *    working — reproduced by hand: with both tagged, "1." stayed pinned
 *    left while the paragraph text inside correctly went rtl, i.e. exactly
 *    the "bullets align, text doesn't" symptom. Skipping the paragraph
 *    inside those wrappers lets it inherit the wrapper's own computed
 *    direction via normal CSS inheritance instead of racing it.
 */
export const AutoDirection = Extension.create({
  name: "autoDirection",
  addGlobalAttributes() {
    return [
      {
        types: [...DIRECTION_OWNING_WRAPPERS],
        attributes: {
          dir: {
            default: "auto",
            parseHTML: () => "auto",
            renderHTML: () => ({ dir: "auto" }),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos, parent) => {
              if (
                node.type.name !== "paragraph" &&
                node.type.name !== "heading"
              ) {
                return;
              }
              if (parent && DIRECTION_OWNING_WRAPPERS.has(parent.type.name)) {
                return;
              }
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, { dir: "auto" }),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/**
 * The schema-defining extension list, in the same order the editor has
 * always registered them (order can influence schema construction). The
 * image, codeBlock, widget and frontmatter extensions are injectable so the
 * renderer can substitute their node-view-bearing subclasses without
 * duplicating the list. Widgets arrive as a list rather than one named
 * argument per widget: their identities live in @notefig/widgets, and the
 * default is the worker-safe halves (rule 1 of the widget protocol) — which
 * is exactly what markdown-codec.ts wants when it calls this with no
 * arguments at all.
 */
export function createSchemaExtensions(
  image: typeof MarkdownImageBase = MarkdownImageBase,
  codeBlock: typeof CodeBlockLowlight = CodeBlockLowlight,
  widgets: Node[] = widgetSchemaNodes(),
  frontmatter: typeof FrontmatterNodeBase = FrontmatterNodeBase,
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
      // Replaced by DocWithFrontmatter (same node name, content expression
      // admitting an optional leading frontmatter node).
      document: false,
    }),
    DocWithFrontmatter,
    PromptHostListItem,
    AutoDirection,
    FrontmatterMarkdown.configure(markdownOptions),
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
    ...widgets,
    // After Markdown: its onBeforeCreate patches the parser tiptap-markdown
    // constructs in its own onBeforeCreate, and hooks run in list order.
    frontmatter,
  ];
}
