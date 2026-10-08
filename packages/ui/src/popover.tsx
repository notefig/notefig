"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { usePointerCloseFocus } from "./pointer-close-focus";
import { cn } from "./utils";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const setRef = (node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  const focusHandlers = usePointerCloseFocus({
    ...props,
    // A modal popover blocks pointers outside it, but a trigger inside a
    // pointer-events-auto island (the agent composer) still gets them: its
    // press read as an outside dismiss, then its click toggled the popover
    // open again. Leave that press to the trigger's toggle, as Radix's
    // non-modal popover does.
    onPointerDownOutside: (event) => {
      props.onPointerDownOutside?.(event);
      const contentId = contentRef.current?.id;
      const target = event.target;
      if (
        contentId &&
        target instanceof Element &&
        target.closest(`[aria-controls="${CSS.escape(contentId)}"]`)
      ) {
        event.preventDefault();
      }
    },
  });
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={setRef}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin] texture-surface",
          className,
        )}
        {...props}
        {...focusHandlers}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
