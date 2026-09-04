import * as React from "react";
import { cn } from "./utils";

interface ScrollAreaProps extends React.ComponentProps<"div"> {
  className?: string;
  children: React.ReactNode;
}

function ScrollArea({ className, children, ...props }: ScrollAreaProps) {
  return (
    <div className={cn("relative overflow-auto", className)} {...props}>
      {children}
    </div>
  );
}

export { ScrollArea };
