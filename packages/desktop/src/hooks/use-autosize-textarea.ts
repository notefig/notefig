import { useLayoutEffect } from "react";

/**
 * Grows a textarea to fit its content by measuring scrollHeight after each
 * value change — pair with `overflow-hidden` and no max-height cap on the
 * element so no scrollbar ever appears.
 */
export function useAutosizeTextarea(
  ref: React.RefObject<HTMLTextAreaElement>,
  value: string,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
