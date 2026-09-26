import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { DemoHost } from "./demo-host";

/**
 * The app's own type, spacing and theme tokens for a subtree of the
 * marketing page (which rescales Tailwind's spacing for itself), shrunk to
 * card size with `zoom` so the component keeps its real proportions.
 *
 * `width` and `height` are the demo's design size in page px at `zoom`. The
 * layout box never changes: a narrower container scales the whole demo down
 * instead of reflowing it, so a phone sees the same component, smaller —
 * never re-wrapped text or a squeezed row. Without `width` the embed fills
 * its container.
 */
export function AppEmbed({
  zoom = 0.66,
  width,
  height,
  className,
  children,
}: {
  zoom?: number;
  width?: number;
  height?: number;
  className?: string;
  children: ReactNode;
}) {
  const [measure, available] = useContainerWidth();
  return (
    <div ref={measure} className="flex w-full min-w-0 justify-center">
      <div
        className={className ? `app-embed ${className}` : "app-embed"}
        style={embedStyle({ zoom, width, height, available })}
      >
        <DemoHost>{children}</DemoHost>
      </div>
    </div>
  );
}

/** The embed's fixed layout box, and the zoom that fits it to `available`. */
function embedStyle({
  zoom,
  width,
  height,
  available,
}: {
  zoom: number;
  width?: number;
  height?: number;
  available: number | null;
}): CSSProperties {
  const style: Record<string, number> = { "--app-zoom": zoom * fitScale(width, available) };
  const layoutWidth = (width ?? available ?? 0) / zoom;
  if (layoutWidth) style.width = layoutWidth;
  if (height) style.height = height / zoom;
  return style as CSSProperties;
}

/** How far a `width`-wide demo must shrink to fit `available` (never grow). */
function fitScale(width: number | undefined, available: number | null): number {
  if (!width || available === null) return 1;
  return Math.min(1, available / width);
}

/** A callback ref plus the observed element's content width (null until
 *  first measured). */
function useContainerWidth(): [
  (node: HTMLDivElement | null) => void,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.current.observe(node);
  }, []);
  return [measure, width];
}
