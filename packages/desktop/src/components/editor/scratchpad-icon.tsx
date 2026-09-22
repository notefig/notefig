import { Hash } from "lucide-react";
import { cn } from "@notefig/ui/utils";

/**
 * The one scratchpad mark outside the file tree: lucide's hash, so the
 * create button, the palette command and the Everything view all say
 * "scratchpad" with the same glyph and the same stroke as every other
 * icon. (The tree paints its own tinted hash on the scratchpads folder —
 * tree-model-cache.ts.)
 */
export function ScratchpadIcon({ className }: { className?: string }) {
  return <Hash aria-hidden="true" className={cn("shrink-0", className)} />;
}
