import type { ReactNode } from "react";
import { cn } from "@notefig/ui/utils";

/**
 * The control row every sidebar tool puts above its content — the file
 * tree's sort menu, the search input, the commit controls, the new
 * session button. One height and one separator for all of them, so
 * switching tools never moves the content edge. `expanded` is the one
 * exception: extra rows (the search filters) stack beneath the row,
 * inside the same separator.
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
    <div className="shrink-0 border-b border-border">
      <div className={cn("flex h-9 items-center gap-1 px-2", className)}>
        {children}
      </div>
      {expanded}
    </div>
  );
}
