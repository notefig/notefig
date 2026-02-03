"use client";

import { useMemo, useCallback } from "react";
import { useSearchParams } from "react-router";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "react-i18next";
import type { FileEntries } from "@/utils/fs";

export interface Tab {
  id: string;
  name: string;
  isModified?: boolean;
}

interface TabBarProps {
  files: FileEntries;
  onNewTab: () => void;
}

export function TabBar({ files, onNewTab }: TabBarProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive tabs from URL search params
  const tabs = useMemo<Tab[]>(() => {
    const tabIds = searchParams.getAll("tab");
    return tabIds.map((id) => ({
      id,
      name: id.split("/").pop() || id,
      isModified: false, // TODO: Track modifications
    }));
  }, [searchParams]);

  const activeTabId = searchParams.get("activeTab");

  const handleTabSelect = useCallback(
    (tabId: string) => {
      setSearchParams((prev) => {
        const newParams = new URLSearchParams(prev);
        newParams.set("activeTab", tabId);
        return newParams;
      });
    },
    [setSearchParams],
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      setSearchParams((prev) => {
        const currentTabs = prev.getAll("tab");
        const newTabs = currentTabs.filter((id) => id !== tabId);
        const isActiveTab = prev.get("activeTab") === tabId;

        const newParams = new URLSearchParams();

        // Copy all non-tab params
        prev.forEach((value, key) => {
          if (key !== "tab" && key !== "activeTab") {
            newParams.append(key, value);
          }
        });

        // Add new tabs
        newTabs.forEach((tab) => newParams.append("tab", tab));

        // Set new active tab if needed
        if (isActiveTab && newTabs.length > 0) {
          newParams.set("activeTab", newTabs[newTabs.length - 1]);
        } else if (!isActiveTab && prev.get("activeTab")) {
          newParams.set("activeTab", prev.get("activeTab")!);
        }

        return newParams;
      });
    },
    [setSearchParams],
  );

  return (
    <div className="flex items-center h-9 bg-secondary/50 border-b border-border">
      <ScrollArea className="flex-1">
        <div className="flex items-center">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-2 h-9 px-3 cursor-pointer transition-colors",
                "border-e rtl:border-e-0 rtl:border-s border-border",
                activeTabId === tab.id
                  ? "bg-background text-foreground"
                  : "bg-secondary/30 text-muted-foreground hover:bg-secondary/60",
              )}
              onClick={() => handleTabSelect(tab.id)}
            >
              <span className="text-sm truncate max-w-32">{tab.name}</span>
              {tab.isModified && (
                <span className="w-2 h-2 rounded-full bg-primary" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleTabClose(tab.id);
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
        className="flex items-center justify-center w-9 h-9 hover:bg-accent transition-colors shrink-0 border-s rtl:border-s-0 rtl:border-e border-border"
      >
        <Plus className="w-4 h-4 text-muted-foreground" />
        <span className="sr-only">{t("newTab")}</span>
      </button>
    </div>
  );
}
