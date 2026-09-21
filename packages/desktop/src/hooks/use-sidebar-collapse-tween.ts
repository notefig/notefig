import { useState, useEffect } from "react";

const COLLAPSE_TWEEN_MS = 200;

/**
 * The open/close tween's two flags: `rendered` keeps the column mounted
 * until the close tween has played; `expanded` flips a frame after the
 * open mounts so the width has a 0 to start from. Presentation only —
 * nothing reads the timer for state.
 */
export function useSidebarCollapseTween(isCollapsed: boolean) {
  const [rendered, setRendered] = useState(!isCollapsed);
  const [expanded, setExpanded] = useState(!isCollapsed);

  useEffect(() => {
    if (!isCollapsed) {
      setRendered(true);
      const frame = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setRendered(false), COLLAPSE_TWEEN_MS);
    return () => clearTimeout(timer);
  }, [isCollapsed]);

  return { rendered, expanded };
}

export type SidebarCollapseTween = ReturnType<typeof useSidebarCollapseTween>;
