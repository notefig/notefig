import { useState, useEffect } from "react";
import { Cloud, CloudUpload, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface StatusBarProps {
  wordCount: number;
  characterCount: number;
  isSynced: boolean;
  direction?: "ltr" | "rtl";
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

export function StatusBar({
  wordCount,
  characterCount,
  isSynced,
  direction = "ltr",
}: StatusBarProps) {
  const isRtl = direction === "rtl";
  const { t } = useTranslation();
  const debouncedSynced = useDebouncedSyncState(isSynced);

  return (
    <div
      className={cn(
        "fixed bottom-0 flex items-center gap-4 px-4 py-1.5 bg-secondary/80 backdrop-blur-sm border-t border-border text-xs text-muted-foreground",
        isRtl
          ? "left-0 right-auto border-r rounded-tr-lg"
          : "right-0 left-auto border-l rounded-tl-lg",
      )}
    >
      <div className="flex items-center gap-1.5 min-w-[4.5rem]">
        {debouncedSynced ? (
          <Cloud className="w-3.5 h-3.5 text-green-500" />
        ) : (
          <CloudUpload className="w-3.5 h-3.5 text-amber-500" />
        )}
        <span>{debouncedSynced ? t("synced") : t("syncing")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Type className="w-3.5 h-3.5" />
        <span>
          {wordCount} {wordCount === 1 ? t("word") : t("words")}
        </span>
      </div>
      <span>
        {characterCount} {t("characters")}
      </span>
    </div>
  );
}
