import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

/**
 * Marker — an inline conversation marker for status updates, system notes,
 * bordered rows, and labeled separators. Compose with Message rows in a
 * transcript. Presentational by default; pass `role="status"` for streaming
 * updates, or `asChild` to render a link/button. Ported to this project's
 * Tailwind v4 token setup (see message-scroller / shimmer for the streaming
 * text effect).
 */
const markerVariants = cva(
  "inline-flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
        border: "w-full border-b border-border pb-2",
        separator:
          "w-full justify-center text-xs before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface MarkerProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof markerVariants> {
  asChild?: boolean;
}

const Marker = React.forwardRef<HTMLDivElement, MarkerProps>(
  ({ className, variant, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        className={cn(markerVariants({ variant, className }))}
        {...props}
      />
    );
  },
);
Marker.displayName = "Marker";

const MarkerIcon = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    aria-hidden
    className={cn("flex shrink-0 items-center", className)}
    {...props}
  />
));
MarkerIcon.displayName = "MarkerIcon";

const MarkerContent = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span ref={ref} className={cn("min-w-0", className)} {...props} />
));
MarkerContent.displayName = "MarkerContent";

export { Marker, MarkerIcon, MarkerContent, markerVariants };
