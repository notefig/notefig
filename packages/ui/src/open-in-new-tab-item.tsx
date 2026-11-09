import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { OpenInNewTabIcon } from "./open-intent";

/**
 * The "Open in New Tab" item, the same in every right-click menu that has
 * one — a file's, a scratchpad's, a prompt's, a session's — so the item
 * reads and sits the same whatever the entity. It leads its menu; what
 * else the menu holds is the entity's own.
 */
export function OpenInNewTabMenuItem({
  label,
  onSelect,
}: {
  /** The app's `openInNewTab` string. */
  label: string;
  onSelect: () => void;
}) {
  return (
    <ContextMenuItem onSelect={onSelect}>
      <OpenInNewTabIcon />
      {label}
    </ContextMenuItem>
  );
}

/**
 * The right-click menu of a link that has nothing to offer but where to
 * open it: a document chip, a diff's file, a recent row. `children` is
 * the link itself (one element, which takes the trigger's handlers).
 */
export function OpenInNewTabContextMenu({
  label,
  onOpenInNewTab,
  children,
}: {
  label: string;
  onOpenInNewTab: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <OpenInNewTabMenuItem label={label} onSelect={onOpenInNewTab} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
