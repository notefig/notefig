import { useCallback, useEffect, useRef, useState } from "react";

/** Phones get a static product shot; tablet/desktop keep the live app. */
export const MOBILE_PRODUCT_SHOT_QUERY = "(max-width: 767px)";

export function useMobileProductShot(): boolean {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(MOBILE_PRODUCT_SHOT_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_PRODUCT_SHOT_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return mobile;
}

export interface ProductWindow {
  frameRef: React.RefObject<HTMLElement | null>;
  live: boolean;
  /** Smooth-scroll the product window into view and let the editor take input. */
  scrollToApp: () => void;
  /** Same destination, no animation — deep links that open a specific page. */
  jumpToApp: () => void;
}

/**
 * The in-page app is a framed product shot, not a viewport takeover.
 *
 * It stays `inert` until the visitor clicks it (or arrives on a deep link)
 * so the editor's mount-time autofocus cannot yank scroll past the hero.
 */
export function useProductWindow(startLive: boolean): ProductWindow {
  const frameRef = useRef<HTMLElement | null>(null);
  const [live, setLive] = useState(startLive);

  const show = useCallback((behavior: ScrollBehavior) => {
    setLive(true);
    frameRef.current?.scrollIntoView({ behavior, block: "center" });
  }, []);

  return {
    frameRef,
    live,
    scrollToApp: useCallback(() => show("smooth"), [show]),
    jumpToApp: useCallback(() => show("auto"), [show]),
  };
}
