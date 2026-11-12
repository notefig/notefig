import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./utils";

/**
 * One icon slot whose icon changes with its state: the old icon shrinks
 * and fades out while the new one grows in, in the same cell, so one seems
 * to turn into the other (the motion dictation uses between an icon and its
 * wave). `swapKey` names what is shown; a change of key is a swap, a change
 * of children under the same key just re-renders. With `appear`, the first
 * icon grows in too (a slot that comes in with its face).
 */
export function IconSwap({
  swapKey,
  appear = false,
  className,
  children,
}: {
  swapKey: string;
  appear?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // What the last commit showed, so a swap can keep it on its way out.
  const committed = useRef<{ key: string; node: ReactNode }>({ key: swapKey, node: children });
  const [shown, setShown] = useState({ key: swapKey, entering: appear });
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null);
  // Swapped during render (React's "storing information from previous
  // renders"), so both layers come in the same commit.
  if (shown.key !== swapKey) {
    setLeaving({ ...committed.current });
    setShown({ key: swapKey, entering: true });
  }
  useLayoutEffect(() => {
    committed.current = { key: swapKey, node: children };
  });

  return (
    <span className={cn("inline-grid shrink-0 place-items-center", className)} data-icon-swap={swapKey}>
      {leaving && (
        <span
          key={`out:${leaving.key}`}
          aria-hidden
          // Without motion there is no animation to end: the old icon just goes.
          className={cn(LAYER_CLASS, "animate-out fade-out-0 zoom-out-50 [animation-fill-mode:forwards] motion-reduce:hidden")}
          onAnimationEnd={() => setLeaving(null)}
        >
          {leaving.node}
        </span>
      )}
      <span
        key={`in:${shown.key}`}
        className={cn(LAYER_CLASS, shown.entering && "animate-in fade-in-0 zoom-in-50")}
      >
        {children}
      </span>
    </span>
  );
}

/** Both layers share the slot's one cell; the swap is dictation's timing. */
const LAYER_CLASS =
  "flex items-center justify-center [grid-area:1/1] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:animate-none";
