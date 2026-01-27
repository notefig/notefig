"use client";

import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "react-i18next";

export interface Tab {
  id: string;
  name: string;
  isModified?: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  direction?: "ltr" | "rtl";
}

export function TabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onNewTab,
  direction = "ltr",
}: TabBarProps) {
  const isRtl = direction === "rtl";
  const { t } = useTranslation();
  
  return (
    <div className={cn(
      "flex items-center h-9 bg-secondary/50 border-b border-border",
      isRtl && "flex-row-reverse"
    )}>
      <ScrollArea className="flex-1">
        <div className={cn(
          "flex items-center",
          isRtl && "flex-row-reverse"
        )}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-2 h-9 px-3 border-e border-border cursor-pointer transition-colors",
                activeTabId === tab.id
                  ? "bg-background text-foreground"
                  : "bg-secondary/30 text-muted-foreground hover:bg-secondary/60"
              )}
              onClick={() => onTabSelect(tab.id)}
            >
              <span className="text-sm truncate max-w-32">{tab.name}</span>
              {tab.isModified && (
                <span className="w-2 h-2 rounded-full bg-primary" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                className="p-0.5 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3.5 h-3.5" />
                <span className="sr-only">{t("closeTab")}</span>
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
      <button
        onClick={onNewTab}
        className="flex items-center justify-center w-9 h-9 hover:bg-accent transition-colors shrink-0 border-s border-border"
      >
        <Plus className="w-4 h-4 text-muted-foreground" />
        <span className="sr-only">{t("newTab")}</span>
      </button>
    </div>
  );
}
