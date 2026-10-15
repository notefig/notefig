/**
 * The "@" suggestion, one plugin for every surface that offers it — the chat
 * composer, a document's prompt drafts, page links in prose: what its menu
 * lists, how rows rank, what a pick inserts, and the WebKit caret fix. A
 * surface says only where "@" opens it, what it searches, and (a page link)
 * what a pick inserts instead of a chip.
 *
 * Directives (`@model:opus`) are registered with it as sources — a namespace
 * and what it offers now — by the app, which owns what they are and what they
 * do when a prompt is sent. Here a directive is only a mention whose id has
 * the `<namespace>:<value>` shape.
 */
import type { Editor, Range } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { SuggestionOptions } from "@tiptap/suggestion";
import type { MentionCandidate, PromptWidgetHost } from "../host";

/** One thing a directive namespace offers. */
export interface DirectiveCandidate {
  value: string;
  label: string;
  description?: string;
}

/** A directive namespace as registered with the suggestion: its name — the
 *  token's prefix — and what it offers now. */
export interface DirectiveSource {
  name: string;
  candidates(): DirectiveCandidate[];
}

/** A directive row: a namespace to type into (`value: null`), or one of
 *  its candidates. */
export type DirectiveRow = {
  namespace: string;
  value: string | null;
  label: string;
  description?: string;
};

export type MentionRow =
  | { kind: "file"; file: MentionCandidate }
  | { kind: "directive"; directive: DirectiveRow };

/** How many files the menu lists for a query; directives are capped apart,
 *  so a namespace's long list never hides the files. */
export const SUGGESTION_LIMIT = 8;
/** Directive rows for a query that names no namespace: enough to pick from
 *  while typing, few enough that the files stay in view. */
const UNSCOPED_DIRECTIVE_LIMIT = 5;

/** A row's stable key. */
export function mentionRowKey(row: MentionRow): string {
  return row.kind === "file"
    ? row.file.path
    : `${row.directive.namespace}:${row.directive.value ?? ""}`;
}

/** Whether a mention token has a directive's shape, `<namespace>:<value>`
 *  — a file path never starts like that. */
export function isDirectiveToken(token: string): boolean {
  return /^[a-z][a-z-]*:\S/.test(token);
}

/** The source and value `<namespace>:<value>` names, if one offers it now. */
export function findDirective(sources: DirectiveSource[], token: string) {
  const colon = token.indexOf(":");
  const source = sources.find(({ name }) => name === token.slice(0, colon));
  const value = token.slice(colon + 1);
  return source?.candidates().some((candidate) => candidate.value === value)
    ? { source, value }
    : null;
}

/** Prefix matches first, then substring ones, on value or label. */
function rank(candidates: DirectiveCandidate[], query: string): DirectiveCandidate[] {
  const needle = query.toLowerCase();
  const at = ({ value, label }: DirectiveCandidate) =>
    Math.min(
      ...[value, label].map((text) => {
        const index = text.toLowerCase().indexOf(needle);
        return index === -1 ? Infinity : index === 0 ? 0 : 1;
      }),
    );
  return candidates
    .map((candidate) => ({ candidate, at: at(candidate) }))
    .filter(({ at }) => at !== Infinity)
    .sort((a, b) => a.at - b.at)
    .map(({ candidate }) => candidate);
}

/**
 * The directive rows for what follows an "@", members first-class like
 * files: `<namespace>:<query>` lists that namespace's members it matches; a
 * query that starts a namespace's name lists its members (`@mo` — every
 * model); any other lists the members it matches (`@son` — Sonnet). A bare
 * "@" lists the namespaces, as a hint of what can follow.
 */
export function searchDirectives(sources: DirectiveSource[], query: string): DirectiveRow[] {
  const colon = query.indexOf(":");
  const scoped = colon > 0 ? sources.find(({ name }) => name === query.slice(0, colon)) : undefined;
  if (scoped) {
    return rank(scoped.candidates(), query.slice(colon + 1))
      .slice(0, SUGGESTION_LIMIT)
      .map((candidate) => ({ namespace: scoped.name, ...candidate }));
  }
  if (!query) return sources.map(({ name }) => ({ namespace: name, value: null, label: `${name}:` }));
  const named = query.toLowerCase();
  return sources
    .flatMap(({ name, candidates }) =>
      (name.startsWith(named) ? candidates() : rank(candidates(), query)).map((candidate) => ({
        namespace: name,
        ...candidate,
      })),
    )
    .slice(0, UNSCOPED_DIRECTIVE_LIMIT);
}

/** A surface's search over the host: its directives first, then files —
 *  or only files where a directive means nothing (a page link in prose). */
export function hostMentionSearch(
  host: PromptWidgetHost,
  {
    workspacePath,
    taskId,
    directives = true,
  }: { workspacePath: string; taskId: string | null; directives?: boolean },
) {
  return (query: string): MentionRow[] => [
    ...(directives ? searchDirectives(host.directives({ workspacePath, taskId }), query) : []).map(
      (directive) => ({ kind: "directive" as const, directive }),
    ),
    ...host
      .searchWorkspaceFiles(workspacePath, query, SUGGESTION_LIMIT)
      .map((file) => ({ kind: "file" as const, file })),
  ];
}

/** Whether a token is a chip: a workspace file, or a directive the
 *  prompt's session offers now. */
export function hostIsMention(
  host: PromptWidgetHost,
  { workspacePath, taskId }: { workspacePath: string; taskId: string | null },
) {
  return (token: string) =>
    host.isWorkspaceFile(workspacePath, token) ||
    !!findDirective(host.directives({ workspacePath, taskId }), token);
}

/**
 * Put a picked row in place of the typed "@query": a chip and a space for a
 * file or a directive's value; for a namespace, its `@<namespace>:` as text,
 * so the menu reopens on that namespace's values.
 */
export function insertMentionRow(editor: Editor, range: Range, row: MentionRow) {
  const chain = editor.chain().focus();
  if (row.kind === "directive" && row.directive.value === null) {
    chain.insertContentAt(range, `@${row.directive.namespace}:`).run();
    return;
  }
  const attrs =
    row.kind === "file"
      ? { id: row.file.relativePath, label: row.file.title }
      : {
          id: `${row.directive.namespace}:${row.directive.value}`,
          label: `${row.directive.namespace}: ${row.directive.label}`,
        };
  chain
    .insertContentAt(range, [
      { type: "mention", attrs },
      { type: "text", text: " " },
    ])
    .run();
}

/**
 * The suggestion's options for a surface: the "@" trigger pinned under its
 * query, its rows from `search`, a pick put in by `insert` (a chip, unless
 * the surface says otherwise), and its menu driven by `render`.
 */
export function mentionSuggestion({
  search,
  insert = insertMentionRow,
  render,
}: {
  search: (query: string) => MentionRow[] | Promise<MentionRow[]>;
  insert?: (editor: Editor, range: Range, row: MentionRow) => void;
  render: SuggestionOptions<MentionRow, MentionRow>["render"];
}) {
  return {
    char: "@",
    items: ({ query }: { query: string }) => search(query),
    command: ({ editor, range, props }: { editor: Editor; range: Range; props: MentionRow }) =>
      insert(editor, range, props),
    render,
    // Pinned directly under the "@" (the anchor is the suggestion
    // decoration, whose left edge is the trigger char). Fixed strategy
    // sidesteps offset-parent math inside the dock/editor stack.
    placement: "bottom-start" as const,
    offset: { mainAxis: 2, crossAxis: 0 },
    floatingUi: { strategy: "fixed" as const },
  };
}

/** The class @tiptap/suggestion gives the "@query" it highlights. */
const SUGGESTION_CLASS = "suggestion";

/**
 * WebKit — the desktop app's webview — doesn't repaint the caret when text
 * changes inside the "@query" a suggestion highlights. ProseMirror finds the
 * DOM selection already where it belongs and leaves it alone, so nothing
 * tells WebKit to redraw: the caret stays at its old spot, or vanishes,
 * until its next blink (up to ~0.5s per Backspace, measured frame by frame).
 * Setting the same selection again makes WebKit draw it where it is.
 */
export function suggestionCaretRepaint(): Plugin {
  return new Plugin({
    view: () => ({
      update(view, previous) {
        if (view.state.doc === previous.doc || !view.hasFocus()) return;
        // In the highlight or just past it (ProseMirror may put the caret
        // after the span): looked for there, not through the document.
        const { node } = view.domAtPos(view.state.selection.head);
        const element = node instanceof Element ? node : node.parentElement;
        const near =
          element?.closest(`.${SUGGESTION_CLASS}`) ||
          element?.querySelector(`:scope > .${SUGGESTION_CLASS}`);
        const selection = (view.root as Document).getSelection?.();
        if (!near || !selection?.isCollapsed || !selection.rangeCount) return;
        // After ProseMirror is done with this update's DOM and selection.
        queueMicrotask(() => {
          if (!selection.rangeCount) return;
          const range = selection.getRangeAt(0).cloneRange();
          selection.removeAllRanges();
          selection.addRange(range);
        });
      },
    }),
  });
}
