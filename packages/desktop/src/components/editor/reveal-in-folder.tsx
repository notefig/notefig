/**
 * Showing a file in the system's file manager (MET-291), the same from every
 * right-click menu that offers it: the file tree's, and the sidebar's recent
 * documents. Only where the platform has a file manager (`ui.revealInFolder`).
 */
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCore } from "@notefig/core/react";
import { ContextMenuItem } from "@notefig/ui/context-menu";
import type { PlatformUiSurface } from "@/adapters/platform-adapter.interface";

/** What this system calls it, as a `utils/intl.ts` key. */
export const revealLabel = () =>
  navigator.platform.startsWith("Mac")
    ? "revealInFinder"
    : navigator.platform.startsWith("Win")
      ? "showInExplorer"
      : "showInFolder";

/** Show `path` (absolute). A menu click has nowhere to throw, so a failure
 *  is logged. */
export function reveal(ui: Pick<PlatformUiSurface, "revealInFolder">, path: string) {
  ui.revealInFolder?.(path).catch((error: unknown) => {
    console.error(`Failed to reveal ${path}:`, error);
  });
}

/** The item in a right-click menu, or nothing where the platform can't. */
export function RevealInFolderMenuItem({ path }: { path: string }) {
  const { ui } = useCore().platform;
  const { t } = useTranslation();
  if (!ui.revealInFolder) return null;
  return (
    <ContextMenuItem onSelect={() => reveal(ui, path)}>
      <FolderOpen />
      {t(revealLabel())}
    </ContextMenuItem>
  );
}
