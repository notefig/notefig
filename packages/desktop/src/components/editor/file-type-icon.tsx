import { useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  type FileTreeIconConfig,
} from "@pierre/trees";

/**
 * Per-file-type icons rendered from @pierre/trees' built-in sprite set — the
 * same resolver the sidebar file tree would use, so the palette and the tree
 * can never disagree. The tree currently runs with icons off; when they come
 * back, feed it this config so both stay in lockstep.
 *
 * "standard" is the monochrome tier (markdown/image/json/code/… plus a
 * "default" file glyph); icons inherit currentColor. Project-specific
 * overrides layer on top of the built-ins here, e.g.
 * `byFileName: { "metrists.json": { name: "my-symbol" } }`.
 */
export const FILE_ICON_CONFIG: FileTreeIconConfig = {
  set: "standard",
  colored: false,
};

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
      // color per theme (the tree mirrors this in tree-model-cache's
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
