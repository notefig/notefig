import { useState, useEffect } from "react";
import { Cloud, CloudUpload, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TunnelStatus } from "@/components/tunnel/tunnel-status";

interface StatusCellsProps {
  /** Omitted (null) when the focused tab has no text content of its own. */
  wordCount: number | null;
  isSynced: boolean;
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

// Deliberately no git subscription here: the cells are always mounted,
// and a live git query from them kept the workspace's whole status/log
// fetch hot on every save. Git state now renders only inside the git
// panels, so the collection has zero subscribers (and invalidations cost
// nothing) while no git UI is open.
/** Save state, word count and the tunnel pill — laid into the top bar. */
export function StatusCells({ wordCount, isSynced }: StatusCellsProps) {
  const debouncedSynced = useDebouncedSyncState(isSynced);

  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
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
        <Cloud className="w-3.5 h-3.5 text-green-500" />
      ) : (
        <CloudUpload className="w-3.5 h-3.5 text-amber-500" />
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


