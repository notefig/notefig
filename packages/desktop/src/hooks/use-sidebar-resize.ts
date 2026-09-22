import { useState, useEffect, useRef, useCallback } from "react";

// Widths in rem so they track the root font-size (app-wide UI scale).
const SIDEBAR_DEFAULT_REM = 15;
const SIDEBAR_MIN_REM = 10;
const SIDEBAR_MAX_REM = 26;

/** Drag-to-resize, measured from the column's own left edge. */
export function useSidebarResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(`${SIDEBAR_DEFAULT_REM}rem`);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const left = containerRef.current?.getBoundingClientRect().left ?? 0;
      const remPx = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const clampedRem = Math.max(
        SIDEBAR_MIN_REM,
        Math.min(SIDEBAR_MAX_REM, (e.clientX - left) / remPx),
      );
      setSidebarWidth(`${clampedRem}rem`);
    };
    const handleMouseUp = () => setIsResizing(false);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  const handleResizeStart = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  return { containerRef, sidebarWidth, handleResizeStart };
}

export type SidebarResize = ReturnType<typeof useSidebarResize>;
