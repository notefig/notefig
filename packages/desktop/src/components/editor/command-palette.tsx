import React, { useCallback } from "react";
import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Settings,
  Search,
  FolderOpen,
  FolderPlus,
  Plus,
  Undo,
  Redo,
  Moon,
  LayoutGrid,
  Maximize,
  X,
  Home,
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
import { useHotkey, formatForDisplay } from "@tanstack/react-hotkeys";
import { useTheme } from "../theme-provider";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useNavigate } from "react-router";
import { pickDirectory } from "../../utils/fs";

interface CommandPaletteProps {
  open: boolean;
  sidebarOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onNewFile?: () => void;
  onNewDirectory?: () => void;
  onCloseFile?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
  onToggleFullscreen?: () => void | Promise<void>;
  onFocusEditor?: () => void;
  direction?: "ltr" | "rtl";
}

interface CommandType {
  id: string;
  label: string;
  icon: React.ElementType;
  shortcut?: string;
  action?: () => void | Promise<void>;
  group: string;
}

export function CommandPalette({
  open,
  sidebarOpen,
  onOpenChange,
  onNewFile,
  onNewDirectory,
  onCloseFile,
  onUndo,
  onRedo,
  onOpenSettings,
  onToggleSidebar,
  onToggleFullscreen,
  onFocusEditor,
  direction = "ltr",
}: CommandPaletteProps) {
  const { setTheme, theme } = useTheme();
  const { setTheme: persistTheme } = useAppSettings();
  const [search, setSearch] = useState("");

  const navigate = useNavigate();

  const handleOpenFolder = useCallback(async () => {
    const selectedPath = await pickDirectory("Select a folder");
    if (selectedPath) {
      const encodedPath = encodeURIComponent(selectedPath);
      navigate(`/${encodedPath}`);
    }
  }, [navigate]);

  useHotkey("Mod+K", () => {
    onOpenChange(!open);
  });

  useHotkey("Mod+P", () => {
    onOpenChange(true);
  });

  useEffect(() => {
    if (!open) {
      setSearch("");
    }
  }, [open]);

  const swapTheme = () => {
    if (theme === "dark") {
      setTheme("light");
      persistTheme("light");
      return;
    }
    if (theme === "light") {
      setTheme("dark");
      persistTheme("dark");
      return;
    }
    setTheme("light");
    persistTheme("light");
  };

  const commands: CommandType[] = [
    {
      id: "new-file",
      label: "New File",
      icon: Plus,
      shortcut: formatForDisplay("Mod+N"),
      action: () => {
        if (sidebarOpen) {
          onToggleSidebar?.();
        }
        onNewFile?.();
      },
      group: "File",
    },
    {
      id: "close-file",
      label: "Close File",
      icon: FileText,
      shortcut: formatForDisplay("Mod+W"),
      action: onCloseFile,
      group: "File",
    },
    {
      id: "new-directory",
      label: "New Directory",
      icon: FolderPlus,
      action: () => {
        if (sidebarOpen) {
          onToggleSidebar?.();
        }
        onNewDirectory?.();
      },
      group: "File",
    },
    {
      id: "open-folder",
      label: "Open Folder",
      icon: FolderOpen,
      action: () => {
        handleOpenFolder();
      },
      group: "File",
    },
    {
      id: "close-workspace",
      label: "Close Workspace",
      icon: Home,
      action: () => {
        navigate("/welcome");
      },
      group: "File",
    },
    {
      id: "undo",
      label: "Undo",
      icon: Undo,
      shortcut: formatForDisplay("Mod+Z"),
      action: onUndo,
      group: "Edit",
    },
    {
      id: "redo",
      label: "Redo",
      icon: Redo,
      shortcut: formatForDisplay("Mod+Shift+Z"),
      action: onRedo,
      group: "Edit",
    },
    // {
    //   id: "find",
    //   label: "Find in File",
    //   icon: Search,
    //   shortcut: formatForDisplay("Mod+F"),
    //   group: "Edit",
    // },
    // {
    //   id: "replace",
    //   label: "Find and Replace",
    //   icon: Edit3,
    //   shortcut: formatForDisplay("Mod+H"),
    //   group: "Edit",
    // },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      icon: LayoutGrid,
      shortcut: formatForDisplay("Mod+\\"),
      action: onToggleSidebar,
      group: "View",
    },
    {
      id: "toggle-fullscreen",
      label: "Toggle Fullscreen",
      icon: Maximize,
      shortcut: "F11",
      action: onToggleFullscreen,
      group: "View",
    },
    // {
    //   id: "next-tab",
    //   label: "Next Tab",
    //   icon: FileText,
    //   shortcut: "Ctrl+Tab",
    //   group: "View",
    // },
    // {
    //   id: "prev-tab",
    //   label: "Previous Tab",
    //   icon: FileText,
    //   shortcut: "Ctrl+Shift+Tab",
    //   group: "View",
    // },
    // {
    //   id: "go-to-file",
    //   label: "Go to File",
    //   icon: FileText,
    //   shortcut: formatForDisplay("Mod+P"),
    //   group: "Navigation",
    // },
    // {
    //   id: "go-to-line",
    //   label: "Go to Line",
    //   icon: Terminal,
    //   shortcut: formatForDisplay("Mod+G"),
    //   group: "Navigation",
    // },
    // {
    //   id: "bookmarks",
    //   label: "Show Bookmarks",
    //   icon: Bookmark,
    //   group: "Navigation",
    // },
    // {
    //   id: "git-status",
    //   label: "Git Status",
    //   icon: GitBranch,
    //   group: "Tools",
    // },
    // {
    //   id: "git-commit",
    //   label: "Git Commit",
    //   icon: GitBranch,
    //   shortcut: formatForDisplay("Mod+Shift+G"),
    //   group: "Tools",
    // },
    {
      id: "open-settings",
      label: "Open Settings",
      icon: Settings,
      shortcut: formatForDisplay("Mod+Shift+,"),
      action: onOpenSettings,
      group: "Settings",
    },
    // {
    //   id: "keyboard-shortcuts",
    //   label: "Keyboard Shortcuts",
    //   icon: Keyboard,
    //   shortcut: formatForDisplay("Mod+K") + " " + formatForDisplay("Mod+S"),
    //   group: "Settings",
    // },
    {
      id: "toggle-theme",
      label: "Toggle Theme",
      icon: Moon,
      group: "Settings",
      action: swapTheme,
    },
    // {
    //   id: "help",
    //   label: "Help",
    //   icon: HelpCircle,
    //   shortcut: "F1",
    //   group: "Help",
    // },
    // {
    //   id: "documentation",
    //   label: "Documentation",
    //   icon: FileText,
    //   group: "Help",
    // },
  ];

  const skipFocusRestoreRef = useRef(false);

  const handleSelect = (command: CommandType) => {
    if (command.id === "new-file" || command.id === "new-directory") {
      skipFocusRestoreRef.current = true;
    }
    if (command.action) {
      Promise.resolve(command.action()).catch((error: unknown) => {
        console.error(`Failed to run command: ${command.id}`, error);
      });
    }
    onOpenChange(false);
  };

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

  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    const shouldRestore = !skipFocusRestoreRef.current;
    skipFocusRestoreRef.current = false;
    if (!shouldRestore) return;
    requestAnimationFrame(() => {
      onFocusEditor?.();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>Search for a command to run...</DialogDescription>
      </DialogHeader>
      <DialogContent
        className="overflow-hidden p-0 max-w-lg gap-0"
        dir={direction}
        onCloseAutoFocus={handleCloseAutoFocus}
        showCloseButton={false}
      >
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <div className="flex items-center border-b px-3 h-12">
            <Search className="size-5 shrink-0 opacity-50 me-2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type a command or search..."
              className="flex-1 h-10 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              // @ts-ignore
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
            />
            <button
              onClick={() => onOpenChange(false)}
              className="ms-2 p-1 rounded hover:bg-accent transition-colors"
              aria-label="Close command palette"
            >
              <X className="size-4 text-muted-foreground" />
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
