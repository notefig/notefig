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
import { useEffect, useId, useState } from "react";
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
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const gooId = useId();
  if (entries.length === 0) return null;

  return (
    <nav
      className="group/map absolute right-4 top-6 z-10 h-28 max-h-[50%] w-3"
      aria-label="Prompt widgets in this document"
      data-widget-minimap
    >
      {/* The visual layer: line and dots drawn together under a gooey
          filter (blur + alpha contrast), so the line smoothly swells into
          each circle instead of just crossing it. Drawn at full opacity —
          the goo math needs solid alpha — and faded via the svg's own
          opacity, which applies after the filter. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-muted-foreground opacity-40 transition-opacity duration-200 group-hover/map:opacity-70"
      >
        <defs>
          <filter id={gooId} x="-150%" y="-25%" width="400%" height="150%">
            <feGaussianBlur
              in="SourceGraphic"
              stdDeviation="1.4"
              result="blur"
            />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
            />
          </filter>
        </defs>
        <g filter={`url(#${gooId})`}>
          <line
            x1="50%"
            x2="50%"
            y1="0%"
            y2="100%"
            stroke="currentColor"
            strokeWidth="2"
          />
          {entries.map((entry) => (
            <circle
              key={entry.key}
              cx="50%"
              cy={`${entry.ratio * 100}%`}
              fill="currentColor"
              // Geometry-as-CSS so the swell animates.
              style={{
                r: hoveredKey === entry.key ? "6px" : "4px",
                transition: "r 150ms ease",
              }}
            />
          ))}
        </g>
      </svg>
      <div className="relative h-full">
        {entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-label={`Jump to prompt: ${entry.title}`}
            onClick={() => {
              if (entry.blobId) jumpToBlob(filePath, entry.blobId);
            }}
            onMouseEnter={() => setHoveredKey(entry.key)}
            onMouseLeave={() =>
              setHoveredKey((k) => (k === entry.key ? null : k))
            }
            // Invisible hit target over the drawn dot; the pill hangs off it.
            className="group/dot absolute left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
            style={{ top: `${entry.ratio * 100}%` }}
          >
            <span className="pointer-events-none absolute right-full top-1/2 z-10 mr-1 hidden max-w-[14rem] -translate-y-1/2 truncate whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 text-[0.625rem] leading-tight text-muted-foreground shadow-sm group-hover/dot:block">
              {entry.title}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
