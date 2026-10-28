/**
 * A change drawn as a card: the prompt widget's settled frame, a compact
 * header naming the file (a link when it is one of the workspace's) with
 * the lines added and removed, and the diff itself, by `@pierre/diffs` —
 * the library the code viewer is built on, highlighting with the Shiki
 * document code blocks share.
 *
 * Side by side where the change has both sides and its lines fit beside
 * each other; one unified column otherwise. Wrapped, never scrolled sideways. It follows the
 * app's theme with no code: Pierre's colours are `light-dark()` pairs,
 * picked by the page's `color-scheme` (dark under `html.dark`), once its
 * host stops asking for the OS's.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { FileDiff as FileDiffIcon } from "lucide-react";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs";
import { cn } from "@notefig/ui/utils";
import { diffStats } from "./patch";

/** What a side needs besides its code: gutter, indicator, padding. */
const SIDE_CHROME_PX = 56;
/** A code character at the card's size, near enough for a layout choice. */
const CHAR_PX = 7.8;
/** Lines longer than this wrap side by side as they would in one column. */
const FIT_COLUMNS = 80;

/**
 * Into the shadow root's `@layer unsafe`. The colour scheme is the page's
 * (Pierre's own `light dark` follows the OS), the background the card's
 * (Pierre mixes every tint against it), and the code is sized against the
 * card as a code block's is against its `<pre>`.
 */
const CSS = `
:host {
  color-scheme: inherit;
  --diffs-light-bg: hsl(var(--card));
  --diffs-dark-bg: hsl(var(--card));
  --diffs-font-size: 0.8571429em;
  --diffs-line-height: 1.6667em;
}
`;

/** The file a change is to, as the host resolved it. */
export interface DiffFile {
  /** How to name it: workspace-relative where it is in one. */
  label: string;
  /** Opens it; absent when it isn't a file of the workspace. */
  open?: () => void;
}

export function DiffCard({
  diff,
  file,
  actions,
  className,
}: {
  diff: FileDiffMetadata;
  file: DiffFile;
  /** The header's trailing buttons. */
  actions?: ReactNode;
  className?: string;
}) {
  const { added, removed } = diffStats(diff);
  const slash = file.label.lastIndexOf("/");
  return (
    <div
      className={cn("not-prose w-full select-text overflow-hidden rounded-lg border border-border/60 bg-card/80 text-xs", className)}
      data-diff-card
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-border/60 pl-2.5 pr-1 text-muted-foreground">
        <FileDiffIcon className="size-3.5 shrink-0" />
        {file.label && (
          <FileLabel open={file.open}>
            <span>{file.label.slice(0, slash + 1)}</span>
            <span className="font-medium text-foreground">{file.label.slice(slash + 1)}</span>
          </FileLabel>
        )}
        {added > 0 && <span className="shrink-0 tabular-nums text-success">+{added}</span>}
        {removed > 0 && <span className="shrink-0 tabular-nums text-destructive">−{removed}</span>}
        <span className="ml-auto flex shrink-0 items-center">{actions}</span>
      </div>
      <DiffBody diff={diff} />
    </div>
  );
}

function FileLabel({ open, children }: { open?: () => void; children: ReactNode }) {
  const className = "min-w-0 truncate text-left";
  if (!open) return <span className={className}>{children}</span>;
  return (
    <button type="button" className={cn(className, "cursor-pointer hover:underline")} onClick={open}>
      {children}
    </button>
  );
}

/** Pierre's diff, its own header off: the card's is the header. */
function DiffBody({ diff }: { diff: FileDiffMetadata }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current!;
    const changed = (side: "additionLines" | "deletionLines") => diff.hunks.some((hunk) => hunk[side] > 0);
    const canSplit = changed("additionLines") && changed("deletionLines");
    const longest = Math.min(
      FIT_COLUMNS,
      Math.max(0, ...[...diff.additionLines, ...diff.deletionLines].map((line) => line.trimEnd().length)),
    );
    const fits = (width: number) => width / 2 - SIDE_CHROME_PX >= longest * CHAR_PX;
    const styleAt = (width: number): "split" | "unified" => (canSplit && fits(width) ? "split" : "unified");
    const options = { overflow: "wrap", disableFileHeader: true, unsafeCSS: CSS } as const;
    let style = styleAt(container.clientWidth);
    const view = new FileDiff({ ...options, diffStyle: style });
    view.render({ fileDiff: diff, containerWrapper: container });
    const resizes = new ResizeObserver(([entry]) => {
      const next = styleAt(entry.contentRect.width);
      if (next === style) return;
      style = next;
      view.setOptions({ ...options, diffStyle: style });
      view.rerender();
    });
    if (canSplit) resizes.observe(container);
    return () => {
      resizes.disconnect();
      view.cleanUp();
    };
  }, [diff]);
  return <div ref={host} />;
}
