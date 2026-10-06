/**
 * MCP resource backing for widget-initiated prompts (MET-68): the widget
 * prompt sends a bare `resource_link` (see widget-context-uri.ts for the
 * self-contained URI, encoded by agents.ts's `promptFromWidget`) instead of
 * stuffing surrounding-document context into the prompt text. The agent
 * reads it on demand via `resources/read` (mcp-server.ts), which calls
 * `buildWidgetContextPayload` here — everything is computed fresh at read
 * time from live state (selection, open files, document text) except the
 * position and the referenced selection's from/to, which are the raw
 * ProseMirror coordinates captured at send time and reused as-is (no fuzzy
 * re-anchoring — see document-outline.ts). The referenced TEXT itself is
 * not here: it leads the prompt as a markdown blockquote (agents.ts), and
 * `selectedRange` below shares its coordinate space with the
 * `document_read_range` tool so the agent can widen the window on demand.
 */
import { resolveExtensions, getSchemaByResolvedExtensions } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { createSchemaExtensions } from "@/components/editor/editor-schema-kit";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import {
  extractOutline,
  nearestPrecedingHeading,
  windowAroundPos,
} from "@/components/editor/document-outline";
import {
  getWorkspaceEditorContext,
  type EditorsApi,
} from "@/modules/editors";
import type { LayoutApi } from "@/modules/layout";
import type { DocumentsApi } from "@/modules/documents";
import { resolveWorkspacePath } from "@/utils/fs";
import type { WidgetContextRef } from "@notefig/agent";

// Same schema-construction pattern as markdown-codec.ts, for the fallback
// path when the document isn't open in a live editor (the widget's host
// document is open by construction, so this is a defensive rather than a
// common path — e.g. the user closed the tab before the agent read back).
const fallbackSchema = getSchemaByResolvedExtensions(
  resolveExtensions(createSchemaExtensions()),
);
const fallbackCodec = createMarkdownCodec();

async function parseDocFromDisk(
  documents: Pick<DocumentsApi, "read">,
  absolutePath: string,
): Promise<PMNode> {
  const markdown = await documents.read(absolutePath);
  return PMNode.fromJSON(fallbackSchema, fallbackCodec.parse(markdown));
}

/** The document as ProseMirror sees it — the live editor's doc when the
 *  file is open (unsaved edits included), parsed from disk otherwise.
 *  Shared with `document_read_range`: the tool must address the same
 *  coordinate space this resource's positions come from. */
export async function resolveDocument(
  {
    documents,
    editors,
  }: {
    documents: Pick<DocumentsApi, "read">;
    editors: Pick<EditorsApi, "markdownEditor">;
  },
  absolutePath: string,
): Promise<PMNode> {
  const liveEditor = editors.markdownEditor(absolutePath);
  return liveEditor
    ? liveEditor.state.doc
    : parseDocFromDisk(documents, absolutePath);
}

export interface WidgetContextPayload {
  documentTitle: string;
  documentPath: string;
  /** The document's full heading structure — a map of the doc without its
   *  body text, so the agent can tell whether the section it needs is the
   *  one in `surroundingText` or lives elsewhere, without a full read. */
  outline: Array<{ level: number; text: string }>;
  position: { headingText: string | null };
  surroundingText: string;
  selectedText: string | null;
  /** Capture-time ProseMirror range of the passage quoted at the top of
   *  the prompt (summon-over-selection). Same coordinate space as the
   *  `document_read_range` tool's from/to — hand these to it to read the
   *  current content there or a wider window. Never re-anchored. */
  selectedRange: { from: number; to: number } | null;
  otherOpenFiles: Array<{ path: string; active: boolean; dirty: boolean }>;
}

export async function buildWidgetContextPayload(
  {
    documents,
    editors,
    layout,
  }: {
    documents: Pick<DocumentsApi, "read">;
    editors: Pick<EditorsApi, "markdownEditor" | "selectedText" | "get">;
    layout: Pick<LayoutApi, "read">;
  },
  workspacePath: string,
  ref: WidgetContextRef,
): Promise<WidgetContextPayload> {
  const resolved = resolveWorkspacePath(workspacePath, ref.path);
  if (!resolved.ok) throw new Error(resolved.error);

  const doc = await resolveDocument({ documents, editors }, resolved.absolute);

  const outline = extractOutline(doc);
  const heading = nearestPrecedingHeading(doc, ref.pos);
  const surroundingText = windowAroundPos(doc, ref.pos);

  const selectedText = editors.selectedText(resolved.absolute) ?? null;
  const selectedRange = ref.selectedRange ?? null;

  const editorCtx = getWorkspaceEditorContext({ editors, layout }, workspacePath);
  const otherOpenFiles = editorCtx.openFiles
    .filter((f) => f.path !== resolved.absolute)
    .map((f) => ({ path: f.path, active: f.active, dirty: f.dirty }));

  const documentTitle =
    outline[0]?.text || resolved.relative.split("/").pop() || resolved.relative;

  return {
    documentTitle,
    documentPath: ref.path,
    outline: outline.map((h) => ({ level: h.level, text: h.text })),
    position: { headingText: heading?.text ?? null },
    surroundingText,
    selectedText,
    selectedRange,
    otherOpenFiles,
  };
}
