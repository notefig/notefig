"use client";

import {
  FileText,
  Search,
  Bookmark,
  LayoutGrid,
  Clock,
  GitBranch,
  Settings,
  HelpCircle,
  Command,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSearchParams } from "react-router";

interface IconSidebarProps {
  onCommandPaletteClick: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function IconSidebar({
  onCommandPaletteClick,
  isCollapsed,
  onToggleCollapse,
}: IconSidebarProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const topIcons = [
    { id: "search", icon: Search, label: "Search", onClick: () => {} },
    {
      id: "command",
      icon: Command,
      label: "Command Palette",
      onClick: onCommandPaletteClick,
    },
    { id: "git", icon: GitBranch, label: "Git", onClick: () => {} },
  ];

  const handleSettingsToggle = (open: boolean) => {
    if (open) {
      searchParams.set("settings", "true");
    } else {
      searchParams.delete("settings");
    }
    setSearchParams(searchParams);
  };

  const bottomIcons = [
    {
      id: "settings",
      icon: Settings,
      label: "Settings",
      onClick: () => handleSettingsToggle(true),
    },
  ];

  return (
    <TooltipProvider>
      <div className="flex flex-col items-center justify-between h-full w-12 bg-sidebar border-r rtl:border-r-0 rtl:border-l border-sidebar-border py-2">
        <div className="flex flex-col items-center gap-1">
          {topIcons.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={item.onClick}
                  className={cn(
                    "p-2 rounded-md transition-colors hover:bg-sidebar-accent",
                  )}
                >
                  <item.icon className="w-5 h-5 text-muted-foreground" />
                  <span className="sr-only">{item.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="rtl:hidden"
                sideOffset={8}
              >
                {item.label}
              </TooltipContent>
              <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
                {item.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleCollapse}
                className="p-2 rounded-md transition-colors hover:bg-sidebar-accent"
              >
                {isCollapsed ? (
                  <PanelLeft className="w-5 h-5 text-muted-foreground" />
                ) : (
                  <PanelLeftClose className="w-5 h-5 text-muted-foreground" />
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
                    "p-2 rounded-md transition-colors hover:bg-sidebar-accent",
                  )}
                >
                  <item.icon className="w-5 h-5 text-muted-foreground" />
                  <span className="sr-only">{item.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="rtl:hidden"
                sideOffset={8}
              >
                {item.label}
              </TooltipContent>
              <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
                {item.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
