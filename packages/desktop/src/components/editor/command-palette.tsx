"use client";

import React from "react";

import { useEffect, useState } from "react";
import {
  FileText,
  Settings,
  Search,
  FolderOpen,
  Plus,
  Save,
  Undo,
  Redo,
  Copy,
  Clipboard,
  Scissors,
  Moon,
  Keyboard,
  HelpCircle,
  LayoutGrid,
  Bookmark,
  GitBranch,
  RefreshCw,
  Edit3,
  Terminal,
  Maximize,
  Minimize,
  X,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewFile?: () => void;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
  direction?: "ltr" | "rtl";
}

interface CommandType {
  id: string;
  label: string;
  icon: React.ElementType;
  shortcut?: string;
  action?: () => void;
  group: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNewFile,
  onOpenSettings,
  onToggleSidebar,
  direction = "ltr",
}: CommandPaletteProps) {
  const [search, setSearch] = useState("");

  // Reset search when dialog closes
  useEffect(() => {
    if (!open) {
      setSearch("");
    }
  }, [open]);

  const commands: CommandType[] = [
    // File commands
    {
      id: "new-file",
      label: "New File",
      icon: Plus,
      shortcut: "Ctrl+N",
      action: onNewFile,
      group: "File",
    },
    {
      id: "open-file",
      label: "Open File",
      icon: FolderOpen,
      shortcut: "Ctrl+O",
      group: "File",
    },
    {
      id: "save-file",
      label: "Save File",
      icon: Save,
      shortcut: "Ctrl+S",
      group: "File",
    },
    {
      id: "close-file",
      label: "Close File",
      icon: FileText,
      shortcut: "Ctrl+W",
      group: "File",
    },

    // Edit commands
    {
      id: "undo",
      label: "Undo",
      icon: Undo,
      shortcut: "Ctrl+Z",
      group: "Edit",
    },
    {
      id: "redo",
      label: "Redo",
      icon: Redo,
      shortcut: "Ctrl+Shift+Z",
      group: "Edit",
    },
    {
      id: "cut",
      label: "Cut",
      icon: Scissors,
      shortcut: "Ctrl+X",
      group: "Edit",
    },
    {
      id: "copy",
      label: "Copy",
      icon: Copy,
      shortcut: "Ctrl+C",
      group: "Edit",
    },
    {
      id: "paste",
      label: "Paste",
      icon: Clipboard,
      shortcut: "Ctrl+V",
      group: "Edit",
    },
    {
      id: "find",
      label: "Find in File",
      icon: Search,
      shortcut: "Ctrl+F",
      group: "Edit",
    },
    {
      id: "replace",
      label: "Find and Replace",
      icon: Edit3,
      shortcut: "Ctrl+H",
      group: "Edit",
    },

    // View commands
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      icon: LayoutGrid,
      shortcut: "Ctrl+B",
      action: onToggleSidebar,
      group: "View",
    },
    {
      id: "toggle-fullscreen",
      label: "Toggle Fullscreen",
      icon: Maximize,
      shortcut: "F11",
      group: "View",
    },
    {
      id: "zoom-in",
      label: "Zoom In",
      icon: Maximize,
      shortcut: "Ctrl++",
      group: "View",
    },
    {
      id: "zoom-out",
      label: "Zoom Out",
      icon: Minimize,
      shortcut: "Ctrl+-",
      group: "View",
    },

    // Navigation commands
    {
      id: "go-to-file",
      label: "Go to File",
      icon: FileText,
      shortcut: "Ctrl+P",
      group: "Navigation",
    },
    {
      id: "go-to-line",
      label: "Go to Line",
      icon: Terminal,
      shortcut: "Ctrl+G",
      group: "Navigation",
    },
    {
      id: "bookmarks",
      label: "Show Bookmarks",
      icon: Bookmark,
      group: "Navigation",
    },
    {
      id: "recent-files",
      label: "Recent Files",
      icon: RefreshCw,
      group: "Navigation",
    },

    // Tools commands
    {
      id: "git-status",
      label: "Git Status",
      icon: GitBranch,
      group: "Tools",
    },
    {
      id: "git-commit",
      label: "Git Commit",
      icon: GitBranch,
      shortcut: "Ctrl+Shift+G",
      group: "Tools",
    },

    // Settings commands
    {
      id: "open-settings",
      label: "Open Settings",
      icon: Settings,
      shortcut: "Ctrl+,",
      action: onOpenSettings,
      group: "Settings",
    },
    {
      id: "keyboard-shortcuts",
      label: "Keyboard Shortcuts",
      icon: Keyboard,
      shortcut: "Ctrl+K Ctrl+S",
      group: "Settings",
    },
    {
      id: "toggle-theme",
      label: "Toggle Dark/Light Theme",
      icon: Moon,
      group: "Settings",
    },

    // Help commands
    {
      id: "help",
      label: "Help",
      icon: HelpCircle,
      shortcut: "F1",
      group: "Help",
    },
    {
      id: "documentation",
      label: "Documentation",
      icon: FileText,
      group: "Help",
    },
  ];

  const handleSelect = (command: CommandType) => {
    if (command.action) {
      command.action();
    }
    onOpenChange(false);
  };

  // Group commands by their group
  const groupedCommands = commands.reduce(
    (acc, command) => {
      if (!acc[command.group]) {
        acc[command.group] = [];
      }
      acc[command.group].push(command);
      return acc;
    },
    {} as Record<string, CommandType[]>,
  );

  const groupOrder = [
    "File",
    "Edit",
    "View",
    "Navigation",
    "Tools",
    "Settings",
    "Help",
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>Search for a command to run...</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 max-w-lg" dir={direction}>
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <div className="flex items-center border-b px-3 h-12">
            <Search className="size-5 shrink-0 opacity-50 me-2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type a command or search..."
              className="flex-1 h-10 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              onClick={() => onOpenChange(false)}
              className="ms-2 p-1 rounded hover:bg-accent transition-colors"
            >
              <X className="size-4 text-muted-foreground" />
              <span className="sr-only">Close</span>
            </button>
          </div>
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            {groupOrder.map((groupName, index) => {
              const groupCommands = groupedCommands[groupName];
              if (!groupCommands) return null;

              // Filter by search
              const filteredCommands = search
                ? groupCommands.filter((cmd) =>
                    cmd.label.toLowerCase().includes(search.toLowerCase()),
                  )
                : groupCommands;

              if (filteredCommands.length === 0) return null;

              return (
                <div key={groupName}>
                  {index > 0 && <CommandSeparator />}
                  <CommandGroup heading={groupName}>
                    {filteredCommands.map((command) => (
                      <CommandItem
                        key={command.id}
                        onSelect={() => handleSelect(command)}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <command.icon className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="flex-1">{command.label}</span>
                        {command.shortcut && (
                          <CommandShortcut className="ms-auto">
                            {command.shortcut}
                          </CommandShortcut>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </div>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
