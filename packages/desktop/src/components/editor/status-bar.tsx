"use client";

import { Cloud, CloudOff, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface StatusBarProps {
  wordCount: number;
  characterCount: number;
  isSynced: boolean;
  direction?: "ltr" | "rtl";
}

export function StatusBar({ wordCount, characterCount, isSynced, direction = "ltr" }: StatusBarProps) {
  const isRtl = direction === "rtl";
  const { t } = useTranslation();
  
  return (
    <div 
      className={cn(
        "fixed bottom-0 flex items-center gap-4 px-4 py-1.5 bg-secondary/80 backdrop-blur-sm border-t border-border text-xs text-muted-foreground",
        isRtl 
          ? "left-0 right-auto border-r rounded-tr-lg" 
          : "right-0 left-auto border-l rounded-tl-lg"
      )}
    >
      <div className="flex items-center gap-1.5">
        {isSynced ? (
          <Cloud className="w-3.5 h-3.5 text-green-500" />
        ) : (
          <CloudOff className="w-3.5 h-3.5 text-amber-500" />
        )}
        <span>{isSynced ? t("synced") : t("notSynced")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Type className="w-3.5 h-3.5" />
        <span>
          {wordCount} {wordCount === 1 ? t("word") : t("words")}
        </span>
      </div>
      <span>{characterCount} {t("characters")}</span>
    </div>
  );
}
