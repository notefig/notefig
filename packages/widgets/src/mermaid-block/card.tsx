/**
 * A Mermaid diagram drawn as a card: the diff card's frame, the diagram as
 * Pele draws it, and an Edit control in its corner where the block can be
 * edited. Pele loads with the first diagram, not with the editor.
 *
 * It follows the app's theme with no code: Pele colours its SVG from CSS
 * variables (./card.css), which name the app's own.
 *
 * A wide diagram shrinks to fit, down to SMALLEST_SCALE, then scrolls
 * sideways.
 *
 * A diagram Pele can't read shows its message, and the source under it, so
 * a broken diagram still reads as what it says; one Pele didn't load for
 * shows its source.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import "./card.css";

/** How far a wide diagram shrinks to fit the card before it scrolls
 *  instead: below this its labels stop being legible. */
const SMALLEST_SCALE = 0.75;

/** What the card can do, numbered as the keys run them. */
export function mermaidControls(onEdit: (() => void) | undefined): (() => void)[] {
  return onEdit ? [onEdit] : [];
}

export function MermaidCard({
  source,
  onEdit,
  keys = false,
}: {
  source: string;
  /** Shows the block's source, where it has one to edit. */
  onEdit?: () => void;
  /** The keys are on the card: each control shows the digit that runs it. */
  keys?: boolean;
}) {
  const { t } = useTranslation();
  const diagram = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = diagram.current!;
    let destroy: (() => void) | null = null;
    let gone = false;
    setFailed(false);
    const fail = () => {
      if (!gone) setFailed(true);
    };
    import("pele/lazy")
      .then(async ({ mountAsync }) => {
        if (gone) return;
        // Zoom off: its pinch and Mod+wheel are the document's, to scroll
        // and zoom the page.
        const mounted = await mountAsync(element, source, { zoom: false, onError: fail });
        if (gone) mounted.destroy();
        else {
          destroy = () => mounted.destroy();
          if (mounted.error !== undefined) fail();
          const svg = element.querySelector("svg");
          if (svg && mounted.result) svg.style.minWidth = `${Math.round(mounted.result.width * SMALLEST_SCALE)}px`;
        }
      })
      // Pele didn't load (offline, a stale chunk): the source, not a blank card.
      .catch(fail);
    return () => {
      gone = true;
      destroy?.();
    };
  }, [source]);

  return (
    <div
      className="not-prose group relative w-full select-text overflow-hidden rounded-lg border border-border/60 bg-card/80 p-3"
      data-mermaid-card
    >
      {/* Where it isn't edited (chat, a response) the keys scroll it; in the
          editor they select the card, and Enter shows its source. */}
      <div
        ref={diagram}
        className="notefig-mermaid overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-mermaid-diagram
        {...(onEdit ? {} : { tabIndex: 0, role: "region", "aria-label": t("mermaidBlockDiagram") })}
      />
      {failed && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{source}</pre>
      )}
      {onEdit && <EditButton onEdit={onEdit} digit={keys ? 1 : null} />}
    </div>
  );
}

function EditButton({ onEdit, digit }: { onEdit: () => void; digit: number | null }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("mermaidBlockEdit")}
      aria-label={t("mermaidBlockEdit")}
      aria-keyshortcuts={digit === null ? undefined : String(digit)}
      data-mermaid-edit
      className={cn(
        "absolute right-1 top-1 flex cursor-pointer items-center gap-0.5 rounded bg-card/90 p-0.5 text-muted-foreground/70 transition-opacity hover:text-foreground",
        digit === null && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
      )}
      onClick={onEdit}
    >
      <Braces className="size-3" />
      {digit !== null && <kbd className="font-sans text-[0.5625rem]">{digit}</kbd>}
    </button>
  );
}
