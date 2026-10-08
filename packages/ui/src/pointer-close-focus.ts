import * as React from "react";

type OverlayFocusHandlers<E extends Element> = {
  onPointerDown?: (event: React.PointerEvent<E>) => void;
  onKeyDown?: (event: React.KeyboardEvent<E>) => void;
  onPointerDownOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>,
  ) => void;
  onCloseAutoFocus?: (event: Event) => void;
};

/**
 * Radix hands focus back to the trigger when an overlay closes, and the
 * browser paints that scripted focus as :focus-visible — so a plain mouse
 * pick left the trigger wearing its focus ring. When the last interaction
 * with the open overlay was the pointer, focus is left where it falls
 * instead; closing from the keyboard still returns it to the trigger.
 * The caller's own handlers run first, and an onCloseAutoFocus that already
 * placed focus (preventDefault) is left alone.
 */
export function usePointerCloseFocus<E extends Element>(
  props: OverlayFocusHandlers<E>,
): Required<OverlayFocusHandlers<E>> {
  const closedByPointer = React.useRef(false);
  return {
    onPointerDown: (event) => {
      closedByPointer.current = true;
      props.onPointerDown?.(event);
    },
    onKeyDown: (event) => {
      closedByPointer.current = false;
      props.onKeyDown?.(event);
    },
    onPointerDownOutside: (event) => {
      closedByPointer.current = true;
      props.onPointerDownOutside?.(event);
    },
    onCloseAutoFocus: (event) => {
      props.onCloseAutoFocus?.(event);
      if (closedByPointer.current) event.preventDefault();
      closedByPointer.current = false;
    },
  };
}
