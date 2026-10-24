import { useState, useEffect, useMemo } from "react";
import { Cloud, CloudUpload, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { TunnelStatus } from "@/components/tunnel/tunnel-status";
import { useContentFetching, useOpenFileRows } from "@/modules/files/react";
import { useWorkspaceOfPath } from "@/modules/workspaces/react";
import { isFileTabId } from "@/modules/tabs";

interface StatusBarProps {
  /** The tab in front; its file content, if it is a file, is counted. */
  activeTabId: string | null;
  direction?: "ltr" | "rtl";
}

/** The active tab's file content, "" unless a file tab is active and its
 *  content has loaded. Read here rather than in the workspace shell, so a
 *  save re-renders the status bar alone. */
function useActiveFileContent(activeTabId: string | null): string {
  const activePath =
    activeTabId !== null && isFileTabId(activeTabId) ? activeTabId : null;
  // No file tab active → no workspace contains "" → no rows, no query.
  const workspacePath = useWorkspaceOfPath(activePath ?? "");
  const paths = useMemo(
    () => (activePath === null ? [] : [activePath]),
    [activePath],
  );
  const [row] = useOpenFileRows(workspacePath, paths);
  return row?.content ?? "";
}

/** Word count, null with nothing to count. */
function countWords(content: string): number | null {
  if (!content) return null;
  return content
    .trim()
    .split(/\s+/)
    .filter((word: string) => word.length > 0).length;
}

function useDebouncedSyncState(
  isSynced: boolean,
  delay: number = 300,
): boolean {
  const [debouncedSynced, setDebouncedSynced] = useState(isSynced);

  useEffect(() => {
    if (!isSynced) {
      setDebouncedSynced(false);
    } else {
      const timeout = setTimeout(() => {
        setDebouncedSynced(true);
      }, delay);
      return () => clearTimeout(timeout);
    }
  }, [isSynced, delay]);

  return debouncedSynced;
}

// Deliberately no git subscription here: the status bar is always mounted,
// and a live git query from it kept the workspace's whole status/log fetch
// hot on every save. Git state now renders only inside the git panels, so
// the collection has zero subscribers (and invalidations cost nothing)
// while no git UI is open.
/** Save state, word count and the tunnel pill, pinned to the window's
 *  bottom corner at the reading-direction end (the shell root is its
 *  containing block, so it sits under the root padding, flush with the
 *  window edge). */
export function StatusBar({ activeTabId, direction = "ltr" }: StatusBarProps) {
  const content = useActiveFileContent(activeTabId);
  const wordCount = useMemo(() => countWords(content), [content]);
  const debouncedSynced = useDebouncedSyncState(!useContentFetching());

  return (
    <div
      className={cn(
        "absolute bottom-0 flex items-center gap-4 px-4 py-1.5 bg-secondary/80 backdrop-blur-sm border-t border-border text-xs text-muted-foreground",
        cornerClasses(direction === "rtl"),
      )}
    >
      <SaveCell synced={debouncedSynced} />
      {wordCount !== null && <WordCountCell count={wordCount} />}
      <TunnelStatus />
    </div>
  );
}

function SaveCell({ synced }: { synced: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-2 min-w-[4.5rem]">
      {synced ? (
        <Cloud className="w-3.5 h-3.5 text-success" />
      ) : (
        <CloudUpload className="w-3.5 h-3.5 text-warning" />
      )}
      <span>{synced ? t("saved") : t("saving")}</span>
    </div>
  );
}

function WordCountCell({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-2 w-[6.5rem]">
      <Type className="w-3.5 h-3.5" />
      <span>
        {JSON.stringify(count)} {count === 1 ? t("word") : t("words")}
      </span>
    </div>
  );
}

/** Pinned to the reading-direction end of the window. */
function cornerClasses(isRtl: boolean): string {
  return isRtl
    ? "left-0 right-auto border-r rounded-tr-lg"
    : "right-0 left-auto border-l rounded-tl-lg";
}
