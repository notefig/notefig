/**
 * A change drawn as a card: the prompt widget's settled frame, a compact
 * header naming the file (a link when it is one of the workspace's) with
 * the lines added and removed, and the diff itself, by `@pierre/diffs` —
 * the library the code viewer is built on, highlighting with the Shiki
 * document code blocks share.
 *
 * A collapsible card starts as its header alone, and makes Pierre's diff
 * only once it is opened (and drops it when closed): a transcript's many
 * edits cost their headers until someone looks.
 *
 * Side by side where the change has both sides and its lines fit beside
 * each other; one unified column otherwise. Wrapped, never scrolled sideways. It follows the
 * app's theme with no code: Pierre's colours are `light-dark()` pairs,
 * picked by the page's `color-scheme` (dark under `html.dark`), once its
 * host stops asking for the OS's.
 */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Braces, ChevronRight, FileDiff as FileDiffIcon } from "lucide-react";
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
 * card as a code block's is against its `<pre>`. With Pierre's header off
 * the code starts under the card's, so it drops the gap Pierre leaves for
 * a header-less diff, as it does under its own.
 */
const CSS = `
:host {
  color-scheme: inherit;
  --diffs-light-bg: hsl(var(--card));
  --diffs-dark-bg: hsl(var(--card));
  --diffs-font-size: 0.8571429em;
  --diffs-line-height: 1.6667em;
}
[data-code] {
  padding-top: 0;
}
`;

/** The file a change is to, as the host resolved it. */
export interface DiffFile {
  /** How to name it: workspace-relative where it is in one. */
  label: string;
  /** Opens it; absent when it isn't a file of the workspace. */
  open?: () => void;
}

/** What the card's header can do, numbered left to right as it shows
 *  them — opening its file where it is one, then editing the block where
 *  it can be edited. The keys and the header both number them from this. */
export function diffControls(onEdit: (() => void) | undefined, file: DiffFile): (() => void)[] {
  return [file.open, onEdit].filter((control): control is () => void => control !== undefined);
}

export function DiffCard({
  diff,
  file,
  icon,
  onEdit,
  keys = false,
  collapsible = false,
  className,
}: {
  diff: FileDiffMetadata;
  file: DiffFile;
  /** The file's type icon; a generic diff glyph without one. */
  icon?: ReactNode;
  /** Shows the block's source, where it has one to edit. */
  onEdit?: () => void;
  /** The keys are on the card: each control shows the digit that runs it. */
  keys?: boolean;
  /** Starts closed, its header opening and closing it. */
  collapsible?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(!collapsible);
  // The header toggles it, but for its own controls (the file link).
  const toggleFrom = (event: MouseEvent) => {
    if (!(event.target as Element).closest("button")) setOpen(!open);
  };
  const { added, removed } = diffStats(diff);
  const slash = file.label.lastIndexOf("/");
  const controls = diffControls(onEdit, file);
  /** The digit that runs a control, while the keys are on the card. */
  const digit = (control: (() => void) | undefined) => {
    const index = control ? controls.indexOf(control) : -1;
    return keys && index >= 0 && index < 9 ? index + 1 : null;
  };
  return (
    <div
      className={cn("not-prose w-full select-text overflow-hidden rounded-lg border border-border/60 bg-card/80 text-xs", className)}
      data-diff-card
    >
      <div
        className={cn(
          "flex h-6 items-center gap-1.5 pl-2.5 pr-1 text-[0.6875rem] text-muted-foreground",
          open && "border-b border-border/60",
          collapsible && "cursor-pointer pl-1",
        )}
        onClick={collapsible ? toggleFrom : undefined}
      >
        {collapsible && <Toggle open={open} onToggle={() => setOpen(!open)} />}
        {icon ?? <FileDiffIcon className="size-3 shrink-0" />}
        {file.label && (
          <FileLabel open={file.open} digit={digit(file.open)}>
            <span>{file.label.slice(0, slash + 1)}</span>
            <span className="font-medium text-foreground">{file.label.slice(slash + 1)}</span>
          </FileLabel>
        )}
        {added > 0 && <span className="shrink-0 tabular-nums text-success">+{added}</span>}
        {removed > 0 && <span className="shrink-0 tabular-nums text-destructive">−{removed}</span>}
        {onEdit && <EditButton onEdit={onEdit} digit={digit(onEdit)} />}
      </div>
      {open && <DiffBody diff={diff} />}
    </div>
  );
}

/** Opens and closes a collapsible card. */
function Toggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t(open ? "diffBlockHide" : "diffBlockShow")}
      data-diff-toggle
      className="flex shrink-0 cursor-pointer items-center rounded p-0.5 transition-colors hover:text-foreground"
      onClick={onToggle}
    >
      <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
    </button>
  );
}

function EditButton({ onEdit, digit }: { onEdit: () => void; digit: number | null }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("diffBlockEdit")}
      aria-label={t("diffBlockEdit")}
      aria-keyshortcuts={digit === null ? undefined : String(digit)}
      data-diff-edit
      className="ml-auto flex shrink-0 cursor-pointer items-center gap-0.5 rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
      onClick={onEdit}
    >
      <Braces className="size-3" />
      <Digit digit={digit} />
    </button>
  );
}

/** A control's digit, inside its control, as the prompt widget's choices
 *  show theirs. */
function Digit({ digit }: { digit: number | null }) {
  if (digit === null) return null;
  return (
    <kbd className="shrink-0 font-sans text-[0.5625rem]" data-diff-key>
      {digit}
    </kbd>
  );
}

function FileLabel({ open, digit, children }: { open?: () => void; digit: number | null; children: ReactNode }) {
  const className = "min-w-0 truncate text-left";
  if (!open) return <span className={className}>{children}</span>;
  return (
    <button type="button" className="flex min-w-0 cursor-pointer items-center gap-1 hover:text-foreground" onClick={open}>
      <span className={cn(className, "hover:underline")}>{children}</span>
      <Digit digit={digit} />
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
