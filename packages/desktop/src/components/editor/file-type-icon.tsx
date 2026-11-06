import { useEffect } from "react";
import { cn } from "@notefig/ui/utils";
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
} from "@pierre/trees";
import { FILE_ICON_CONFIG } from "@/modules/tree-model";

/**
 * Per-file-type icons rendered from @pierre/trees' built-in sprite set — the
 * same resolver and config the sidebar file tree uses (FILE_ICON_CONFIG), so
 * the palette and the tree can never disagree.
 */
const { resolveIcon } = createFileTreeIconResolver(FILE_ICON_CONFIG);

const SPRITE_HOST_ID = "file-type-icon-sprite";

// The sprite sheet must exist once in the light DOM for <use> references to
// resolve (the tree injects its own copy into its shadow root). Kept
// rendered-but-invisible: display:none sprite sheets break <use> in some
// engines.
function ensureSpriteSheet() {
  if (document.getElementById(SPRITE_HOST_ID)) return;
  const host = document.createElement("div");
  host.id = SPRITE_HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "hidden";
  host.innerHTML = getBuiltInSpriteSheet(FILE_ICON_CONFIG.set ?? "standard");
  document.body.appendChild(host);
}

export function FileTypeIcon({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  useEffect(ensureSpriteSheet, []);
  const icon = resolveIcon("file-tree-icon-file", path);
  return (
    <svg
      viewBox={icon.viewBox ?? "0 0 16 16"}
      // Markdown is the app's home format — its icon carries the logo
      // color per theme (the tree mirrors this in the tree model's
      // unsafeCSS). Last-wins via cn's tailwind-merge over the caller's
      // muted color.
      className={cn(className, icon.token === "markdown" && "text-logo")}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
}
