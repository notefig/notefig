"use client";

import { cn } from "@/lib/utils";

import { Toolbar } from "./toolbar";

export function FixedToolbar(props: React.ComponentProps<typeof Toolbar>) {
  return (
    <Toolbar
      {...props}
      className={cn(
        "scrollbar-hide sticky top-0 left-0 z-10 w-full justify-between overflow-x-auto p-1",
        props.className,
      )}
    />
  );
}
