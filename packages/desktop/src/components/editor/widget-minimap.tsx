/**
 * MET-172: a delicate map of the document's prompt widgets, rendered as a
 * vertical hairline rail along the editor's right edge. One dot per
 * widget, placed along the line proportionally to the widget's position
 * in the document; hovering the rail wakes the line and dots slightly,
 * hovering a dot swells it and reveals a sliver of the widget's title;
 * clicking jumps to the widget (reusing jumpToBlob's scroll-and-flash).
 *
 * Everything is derived: widget positions come from the live ProseMirror
 * doc on each doc-changing transaction, titles from the draft text in the
 * node or the blob store's last sent prompt. No persistent state, no
 * registry — the rail disappears with the last widget.
 */
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { PROMPT_NODE_NAME, getPromptBlob } from "@notefig/widgets";
import { jumpToBlob } from "./blobs/jump-to-blob";

export type WidgetMapEntry = {
  /** Unique per entry: blobId alone can recur (external edits can
   *  duplicate a marker), so the document position disambiguates. */
  key: string;
  blobId: string | null;
  /** 0..1 position of the widget within the document. */
  ratio: number;
  /** Short human handle: draft text, else last sent prompt, else generic. */
  title: string;
};

const TITLE_MAX_CHARS = 48;

/** Pure derivation, exported for tests. */
export function deriveWidgetMapEntries(doc: PMNode): WidgetMapEntry[] {
  const entries: WidgetMapEntry[] = [];
  const size = Math.max(doc.content.size, 1);
  doc.descendants((node, pos) => {
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    const blobId = (node.attrs.blobId as string | null) ?? null;
    const draftText = node.firstChild?.textContent.trim() ?? "";
    const title =
      draftText ||
      (blobId ? getPromptBlob(blobId).lastSentPrompt.trim() : "") ||
      "Prompt";
    entries.push({
      key: `${blobId ?? "pos"}-${pos}`,
      blobId,
      // Clamped in from the edges so the first/last dot never sits on the
      // rail's boundary.
      ratio: Math.min(Math.max(pos / size, 0.01), 0.99),
      title:
        title.length > TITLE_MAX_CHARS
          ? `${title.slice(0, TITLE_MAX_CHARS)}…`
          : title,
    });
    return false;
  });
  return entries;
}

function useWidgetMapEntries(editor: Editor): WidgetMapEntry[] {
  const [entries, setEntries] = useState<WidgetMapEntry[]>(() =>
    deriveWidgetMapEntries(editor.state.doc),
  );
  useEffect(() => {
    let last = JSON.stringify(deriveWidgetMapEntries(editor.state.doc));
    const refresh = () => {
      const next = deriveWidgetMapEntries(editor.state.doc);
      const serialized = JSON.stringify(next);
      if (serialized === last) return;
      last = serialized;
      setEntries(next);
    };
    refresh();
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      if (transaction.docChanged) refresh();
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);
  return entries;
}

export function WidgetMinimap({
  editor,
  filePath,
}: {
  editor: Editor;
  filePath: string;
}) {
  const entries = useWidgetMapEntries(editor);
  if (entries.length === 0) return null;

  return (
    <nav
      className="group/map absolute inset-y-6 right-1.5 z-10 w-3"
      aria-label="Prompt widgets in this document"
      data-widget-minimap
    >
      <div className="relative h-full">
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors duration-200 group-hover/map:bg-muted-foreground/40" />
        {entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-label={`Jump to prompt: ${entry.title}`}
            onClick={() => {
              if (entry.blobId) jumpToBlob(filePath, entry.blobId);
            }}
            // The visible dot is tiny; the padding is the hit target.
            className="group/dot absolute left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer p-1"
            style={{ top: `${entry.ratio * 100}%` }}
          >
            <span
              aria-hidden
              className="relative block h-1.5 w-1.5 transition-transform duration-150 group-hover/dot:scale-150"
            >
              {/* Opaque backing so the rail's line never shows through the
                  translucent dot. */}
              <span className="absolute inset-0 rounded-full bg-background" />
              <span className="absolute inset-0 rounded-full bg-muted-foreground/40 transition-colors duration-200 group-hover/map:bg-muted-foreground/60 group-hover/dot:bg-muted-foreground/90" />
            </span>
            <span className="pointer-events-none absolute right-full top-1/2 z-10 mr-1 hidden max-w-[14rem] -translate-y-1/2 truncate whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 text-[0.625rem] leading-tight text-muted-foreground shadow-sm group-hover/dot:block">
              {entry.title}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
