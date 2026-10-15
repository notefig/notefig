/**
 * What the "@" menu offers and what picking a row inserts — shared by the
 * chat composer and the document's drafts, so the two can't drift. A row is
 * a workspace file or a directive (`@model:opus`): which directives exist is
 * the host's, the widget only knows the `<namespace>:<value>` shape, and a
 * directive chip is an ordinary mention whose id has that shape.
 */
import type { Editor, Range } from "@tiptap/core";
import type { DirectiveOption, MentionCandidate, PromptWidgetHost } from "../host";

/** How many files the menu lists for a query; directives are capped
 *  apart, so a namespace's long list never hides the files. */
export const SUGGESTION_LIMIT = 8;
/** Directive rows for a query that names no namespace: enough to pick
 *  from while typing, few enough that the files stay in view. */
const UNSCOPED_DIRECTIVE_LIMIT = 5;

export type MentionRow =
  | { kind: "file"; file: MentionCandidate }
  | { kind: "directive"; directive: DirectiveOption };

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

/** Directives first — the namespaces a query starts, or one namespace's
 *  values — then files. Only files where a directive means nothing (a page
 *  link in the document's prose). */
export function searchMentionRows(
  host: PromptWidgetHost,
  {
    directives: withDirectives = true,
    ...args
  }: { workspacePath: string; taskId: string | null; query: string; directives?: boolean },
): MentionRow[] {
  const { workspacePath, query } = args;
  const directives = withDirectives
    ? host.searchDirectives({
        ...args,
        limit: query.includes(":") ? SUGGESTION_LIMIT : UNSCOPED_DIRECTIVE_LIMIT,
      })
    : [];
  const files = host.searchWorkspaceFiles(workspacePath, query, SUGGESTION_LIMIT);
  return [
    ...directives.map((directive) => ({ kind: "directive" as const, directive })),
    ...files.map((file) => ({ kind: "file" as const, file })),
  ];
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
