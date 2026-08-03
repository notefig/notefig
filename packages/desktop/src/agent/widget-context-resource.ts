/**
 * MCP resource backing for widget-initiated prompts (MET-68): the widget
 * prompt sends a bare `resource_link` (see widget-context-uri.ts for the
 * self-contained URI, encoded by agents.ts's `promptFromWidget`) instead of
 * stuffing surrounding-document context into the prompt text. The agent
 * reads it on demand via `resources/read` (mcp-server.ts), which calls
 * `buildWidgetContextPayload` here — everything is computed fresh at read
 * time from live state (selection, open files, document text) except the
 * position, which is the raw ProseMirror pos captured at send time and
 * reused as-is (no fuzzy re-anchoring — see document-outline.ts).
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
  getMarkdownEditor,
  getSelectedText,
} from "@/components/editor/editor-store";
import { getWorkspaceEditorContext } from "@/entities/editors";
import { readWorkspaceTextFile } from "@/utils/file-sync";
import { resolveEditablePath } from "@/entities/files";
import type { WidgetContextRef } from "./widget-context-uri";

// Same schema-construction pattern as markdown-codec.ts, for the fallback
// path when the document isn't open in a live editor (the widget's host
// document is open by construction, so this is a defensive rather than a
// common path — e.g. the user closed the tab before the agent read back).
const fallbackSchema = getSchemaByResolvedExtensions(
  resolveExtensions(createSchemaExtensions()),
);
const fallbackCodec = createMarkdownCodec();

async function parseDocFromDisk(absolutePath: string): Promise<PMNode> {
  const markdown = await readWorkspaceTextFile(absolutePath);
  return PMNode.fromJSON(fallbackSchema, fallbackCodec.parse(markdown));
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
  otherOpenFiles: Array<{ path: string; active: boolean; dirty: boolean }>;
}

export async function buildWidgetContextPayload(
  workspacePath: string,
  ref: WidgetContextRef,
): Promise<WidgetContextPayload> {
  const resolved = resolveEditablePath(workspacePath, ref.path);
  if (!resolved.ok) throw new Error(resolved.error);

  const liveEditor = getMarkdownEditor(resolved.absolute);
  const doc = liveEditor
    ? liveEditor.state.doc
    : await parseDocFromDisk(resolved.absolute);

  const outline = extractOutline(doc);
  const heading = nearestPrecedingHeading(doc, ref.pos);
  const surroundingText = windowAroundPos(doc, ref.pos);

  const selectedText = getSelectedText(resolved.absolute) ?? null;

  const editorCtx = getWorkspaceEditorContext(workspacePath);
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
    otherOpenFiles,
  };
}
