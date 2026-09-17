"use client";

import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  FileText,
  Search,
  Sparkles,
  GitBranch,
  Settings,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import { cn } from "@notefig/ui/utils";
import { useSearchParams } from "react-router-dom";
import { useHotkey } from "@tanstack/react-hotkeys";
import { PlainLogo } from "@/components/logo";
import { useSearchParamValue } from "@/hooks/use-search-param-flag";
import { DEFAULT_SETTINGS_SECTION } from "./settings-modal";

interface IconSidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const IconSidebar = memo(function IconSidebar({
  isCollapsed,
  onToggleCollapse,
}: IconSidebarProps) {
  const { t } = useTranslation();
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const sidebarView = searchParams.get("sidebarView") || "files";

  useHotkey("Mod+\\", () => {
    onToggleCollapse();
  });

  const handleSidebarViewChange = useCallback(
    (view: string) => {
      setUrlSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (view === "files") {
          next.delete("sidebarView");
        } else {
          next.set("sidebarView", view);
        }
        // Also ensure sidebar is expanded
        next.delete("sidebar");
        return next;
      });
    },
    [setUrlSearchParams],
  );

  const topIcons = useMemo(
    () => [
      {
        id: "files",
        icon: FileText,
        label: t("files"),
        active: sidebarView === "files",
        onClick: () => handleSidebarViewChange("files"),
      },
      {
        id: "search",
        icon: Search,
        label: t("search"),
        active: sidebarView === "search",
        onClick: () => handleSidebarViewChange("search"),
      },
      {
        id: "git",
        icon: GitBranch,
        label: t("git"),
        active: sidebarView === "git",
        onClick: () => handleSidebarViewChange("git"),
      },
      {
        id: "sessions",
        icon: Sparkles,
        label: t("agentSessionsFull"),
        active: sidebarView === "sessions",
        onClick: () => handleSidebarViewChange("sessions"),
      },
    ],
    [sidebarView, handleSidebarViewChange, t],
  );

  const { setValue: setSettingsSection } = useSearchParamValue("settings");

  const bottomIcons = useMemo(
    () => [
      {
        id: "settings",
        icon: Settings,
        label: t("settings"),
        onClick: () => setSettingsSection(DEFAULT_SETTINGS_SECTION),
      },
    ],
    [setSettingsSection, t],
  );

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-start h-full w-9 py-2",
        !isCollapsed &&
          "border-r rtl:border-r-0 rtl:border-l border-sidebar-border",
      )}
      style={{ backgroundColor: "rgba(15, 15, 15, 0.05)" }}
    >
      {/* The mark. There is no welcome page to go to any more — the app
          is one dock over every open workspace, and welcome is what it
          shows with nothing open. Light mode keeps the pre-theming mark:
          fill rides the --logo token so everything sharing the logo color
          stays in sync. */}
      <div className="mb-3 p-0.5 pt-0">
        <PlainLogo size="1.25rem" fill="var(--logo)" />
      </div>
      <div className="flex flex-col items-center gap-1">
        {topIcons.map((item) => (
          <SidebarIconButton key={item.id} item={item} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-1 mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleCollapse}
              className="p-1.5 rounded-md transition-colors hover:bg-sidebar-accent"
            >
              {isCollapsed ? (
                <PanelLeft className="w-4 h-4 text-muted-foreground" />
              ) : (
                <PanelLeftClose className="w-4 h-4 text-muted-foreground" />
              )}
              <span className="sr-only">
                {isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="rtl:hidden" sideOffset={8}>
            {isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          </TooltipContent>
          <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
            {isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          </TooltipContent>
        </Tooltip>
        {bottomIcons.map((item) => (
          <SidebarIconButton key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
});

interface SidebarIconItem {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  active?: boolean;
}

function SidebarIconButton({ item }: { item: SidebarIconItem }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={item.onClick}
          className={cn(
            "p-1.5 rounded-md transition-colors hover:bg-sidebar-accent",
            item.active && "bg-sidebar-accent",
          )}
        >
          <item.icon
            className={cn(
              "w-4 h-4",
              item.active ? "text-foreground" : "text-muted-foreground",
            )}
          />
          <span className="sr-only">{item.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="rtl:hidden" sideOffset={8}>
        {item.label}
      </TooltipContent>
      <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}
