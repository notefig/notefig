import { useEffect, useState } from "react";

/**
 * Returns a value that trails `value` by `delay` ms, updating only after
 * the input has stopped changing for that long.
 *
 * Useful for expensive consumers (e.g. fuzzy file search) where recomputing
 * on every keystroke would block the main thread. The leading edge is
 * immediate for the initial value so the first render is never empty.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
