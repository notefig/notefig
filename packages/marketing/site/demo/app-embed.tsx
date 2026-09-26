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
 * card size so the component keeps its real proportions.
 *
 * `width` and `height` are the demo's design size in page px at `zoom`. The
 * component lays out once, at its natural size, and is scaled as a picture
 * with `transform`: boxes and text together, identically in every engine.
 * CSS `zoom` is not: iOS Safari was seen scaling the boxes but not the text.
 * A narrower container scales the whole demo further instead of reflowing
 * it, so a phone sees the same component, smaller. Without `width` the
 * embed fills its container.
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
  const [measureOuter, available] = useObservedSize("width");
  const [measureInner, naturalHeight] = useObservedSize("height");
  const layout = embedLayout({ zoom, width, height, available, naturalHeight });

  return (
    <div ref={measureOuter} className="flex w-full min-w-0 justify-center">
      <div className="relative shrink-0" style={layout.outer}>
        <div
          ref={measureInner}
          className={className ? `app-embed ${className}` : "app-embed"}
          style={layout.inner}
        >
          <DemoHost>{children}</DemoHost>
        </div>
      </div>
    </div>
  );
}

/**
 * The embed's two boxes: the outer one takes the scaled size in the page;
 * the inner one is the component's natural layout box, scaled from its
 * top-left corner.
 */
function embedLayout({
  zoom,
  width,
  height,
  available,
  naturalHeight,
}: {
  zoom: number;
  width?: number;
  height?: number;
  available: number | null;
  naturalHeight: number | null;
}): { outer: CSSProperties; inner: CSSProperties } {
  const scale = zoom * fitScale(width, available);
  const layoutWidth = toLayout(width ?? available, zoom);
  const fixedHeight = toLayout(height ?? null, zoom);
  return {
    outer: {
      width: scaled(layoutWidth, scale),
      height: scaled(fixedHeight ?? naturalHeight, scale),
    },
    inner: {
      position: "absolute",
      top: 0,
      left: 0,
      width: layoutWidth ?? undefined,
      height: fixedHeight ?? undefined,
      transform: `scale(${scale})`,
      transformOrigin: "top left",
    },
  };
}

/** A design size (page px at `zoom`) as the component's layout size. */
function toLayout(size: number | null, zoom: number): number | null {
  return size ? size / zoom : null;
}

/** A layout size as it takes up the page once scaled (auto if unknown). */
function scaled(size: number | null, scale: number): number | undefined {
  return size === null ? undefined : size * scale;
}

/** How far a `width`-wide demo must shrink to fit `available` (never grow). */
function fitScale(width: number | undefined, available: number | null): number {
  if (!width || available === null) return 1;
  return Math.min(1, available / width);
}

/** A callback ref plus one dimension of that element's layout box, which a
 *  transform does not change (null until first measured). */
function useObservedSize(
  dimension: "width" | "height",
): [(node: HTMLDivElement | null) => void, number | null] {
  const [size, setSize] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node) return;
      observer.current = new ResizeObserver(([entry]) =>
        setSize(entry.contentRect[dimension]),
      );
      observer.current.observe(node);
    },
    [dimension],
  );
  return [measure, size];
}
