"use client";

import { memo, useCallback, useMemo } from "react";

import {
  FileText,
  Search,
  Bookmark,
  LayoutGrid,
  Clock,
  GitBranch,
  Settings,
  HelpCircle,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router";
import { useSearchParams } from "react-router-dom";
import { useHotkey } from "@tanstack/react-hotkeys";
import { PlainLogo } from "@/components/logo";

interface IconSidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const IconSidebar = memo(function IconSidebar({
  isCollapsed,
  onToggleCollapse,
}: IconSidebarProps) {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const sidebarView = searchParams.get("sidebarView") || "files";

  useHotkey("Mod+\\", () => {
    onToggleCollapse();
  });

  const handleLogoClick = useCallback(() => {
    navigate("/welcome");
  }, [navigate]);

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
        label: "Files",
        active: sidebarView === "files",
        onClick: () => handleSidebarViewChange("files"),
      },
      {
        id: "search",
        icon: Search,
        label: "Search",
        active: sidebarView === "search",
        onClick: () => handleSidebarViewChange("search"),
      },
      {
        id: "git",
        icon: GitBranch,
        label: "Git",
        active: sidebarView === "git",
        onClick: () => handleSidebarViewChange("git"),
      },
    ],
    [sidebarView, handleSidebarViewChange],
  );

  const handleSettingsToggle = useCallback(
    (open: boolean) => {
      setUrlSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (open) {
          next.set("settings", "true");
        } else {
          next.delete("settings");
        }
        return next;
      });
    },
    [setUrlSearchParams],
  );

  const bottomIcons = useMemo(
    () => [
      {
        id: "settings",
        icon: Settings,
        label: "Settings",
        onClick: () => handleSettingsToggle(true),
      },
    ],
    [handleSettingsToggle],
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
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleLogoClick}
            className="mb-3 p-0.5 pt-0 rounded-md transition-colors hover:bg-sidebar-accent cursor-pointer"
          >
            <PlainLogo size={20} className="block dark:hidden" />
            <PlainLogo size={20} fill="#CEFF1A" className="hidden dark:block" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="rtl:hidden" sideOffset={8}>
          Go to Welcome Page
        </TooltipContent>
        <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
          Go to Welcome Page
        </TooltipContent>
      </Tooltip>
      <div className="flex flex-col items-center gap-1">
        {topIcons.map((item) => (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <button
                onClick={item.onClick}
                className={cn(
                  "p-1.5 rounded-md transition-colors hover:bg-sidebar-accent",
                  item.active && "bg-sidebar-accent",
                )}
              >
                <item.icon className="w-4 h-4 text-muted-foreground" />
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
                {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="rtl:hidden" sideOffset={8}>
            {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
          <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
            {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
        {bottomIcons.map((item) => (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <button
                onClick={item.onClick}
                className={cn(
                  "p-1.5 rounded-md transition-colors hover:bg-sidebar-accent",
                )}
              >
                <item.icon className="w-4 h-4 text-muted-foreground" />
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
        ))}
      </div>
    </div>
  );
});
