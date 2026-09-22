import type { ReactNode } from "react";
import { cn } from "@notefig/ui/utils";

/**
 * The control row every sidebar tool puts above its content — the file
 * tree's sort menu, the search input, the commit controls, the new
 * session button. One height for all of them, so switching tools never
 * moves the content edge; no rule beneath — the sidebar draws no lines,
 * the header's tint and spacing do the separating. `expanded` is the one
 * exception: extra rows (the search filters) stack beneath the row.
 */
export function ToolBar({
  children,
  expanded,
  className,
}: {
  children: ReactNode;
  expanded?: ReactNode;
  className?: string;
}) {
  return (
    <div className="shrink-0">
      <div className={cn("flex h-9 items-center gap-1 px-2", className)}>
        {children}
      </div>
      {expanded}
    </div>
  );
}

/**
 * The sidebar's separator: a hairline that stops short of the edges,
 * never a full-bleed border. `vertical` for the line beside the rail.
 */
export function SidebarSeparator({
  vertical,
  className,
}: {
  vertical?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "shrink-0 bg-border",
        vertical ? "my-2 w-px" : "mx-2 h-px",
        className,
      )}
    />
  );
}
