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
  activeItem: string;
  onItemClick: (item: string) => void;
  onCommandPaletteClick: () => void;
}

const topIcons = [
  { id: "files", icon: FileText, label: "Files" },
  { id: "search", icon: Search, label: "Search" },
  { id: "command", icon: Command, label: "Command Palette" },
  { id: "bookmarks", icon: Bookmark, label: "Bookmarks" },
  { id: "grid", icon: LayoutGrid, label: "Views" },
  { id: "recent", icon: Clock, label: "Recent" },
  { id: "git", icon: GitBranch, label: "Git" },
];

const bottomIcons = [
  { id: "help", icon: HelpCircle, label: "Help" },
  { id: "settings", icon: Settings, label: "Settings" },
];

export function IconSidebar({
  activeItem,
  onItemClick,
  onCommandPaletteClick,
}: IconSidebarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const handleSettingsToggle = (open: boolean) => {
    if (open) {
      searchParams.set("settings", "true");
    } else {
      searchParams.delete("settings");
    }
    setSearchParams(searchParams);
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col items-center justify-between h-full w-12 bg-sidebar border-r rtl:border-r-0 rtl:border-l border-sidebar-border py-2">
        <div className="flex flex-col items-center gap-1">
          {topIcons.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    if (item.id === "command") {
                      onCommandPaletteClick();
                    } else {
                      onItemClick(item.id);
                    }
                  }}
                  className={cn(
                    "p-2 rounded-md transition-colors hover:bg-sidebar-accent",
                    activeItem === item.id &&
                      "bg-sidebar-accent text-sidebar-primary",
                  )}
                >
                  <item.icon className="w-5 h-5 text-muted-foreground" />
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
        <div className="flex flex-col items-center gap-1">
          {bottomIcons.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    if (item.id === "settings") {
                      handleSettingsToggle(true);
                    } else {
                      onItemClick(item.id);
                    }
                  }}
                  className={cn(
                    "p-2 rounded-md transition-colors hover:bg-sidebar-accent",
                    activeItem === item.id &&
                      "bg-sidebar-accent text-sidebar-primary",
                  )}
                >
                  <item.icon className="w-5 h-5 text-muted-foreground" />
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
    </TooltipProvider>
  );
}
