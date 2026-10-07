import { useCallback, useEffect, useState } from "react";

/** An element's content height, kept current as it resizes — for drawing
 *  that has to fill a box whose height the layout decides. Attach the
 *  returned ref; the height is 0 until the element is measured. */
export function useElementHeight<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setHeight(Math.round(entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const ref = useCallback((next: T | null) => setElement(next), []);
  return [ref, height];
}
