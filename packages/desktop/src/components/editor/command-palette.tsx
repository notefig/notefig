import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ElementType,
} from "react";
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
  CommandInput,
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
import { useTranslation } from "react-i18next";
import { pickDirectory } from "../../utils/fs";
import { getLocalizedCommandKeywords } from "@/utils/command-keywords";

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
  onSearchInFile?: () => void;
  onSearchInFiles?: () => void;
  onFocusEditor?: () => void;
  direction?: "ltr" | "rtl";
}

interface CommandType {
  id: string;
  labelKey: string;
  groupKey: string;
  keywordKey: string;
  icon: ElementType;
  shortcut?: string;
  action?: () => void | Promise<void>;
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
  onSearchInFile,
  onSearchInFiles,
  onFocusEditor,
  direction = "ltr",
}: CommandPaletteProps) {
  const { setTheme, theme } = useTheme();
  const { setTheme: persistTheme } = useAppSettings();
  const { t } = useTranslation();
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
      labelKey: "newFile",
      groupKey: "file",
      keywordKey: "commandKeywords.newFile",
      icon: Plus,
      shortcut: formatForDisplay("Mod+N"),
      action: () => {
        if (sidebarOpen) {
          onToggleSidebar?.();
        }
        onNewFile?.();
      },
    },
    {
      id: "close-file",
      labelKey: "closeFile",
      groupKey: "file",
      keywordKey: "commandKeywords.closeFile",
      icon: FileText,
      shortcut: formatForDisplay("Mod+W"),
      action: onCloseFile,
    },
    {
      id: "new-directory",
      labelKey: "newFolder",
      groupKey: "file",
      keywordKey: "commandKeywords.newFolder",
      icon: FolderPlus,
      action: () => {
        if (sidebarOpen) {
          onToggleSidebar?.();
        }
        onNewDirectory?.();
      },
    },
    {
      id: "open-folder",
      labelKey: "openFolder",
      groupKey: "file",
      keywordKey: "commandKeywords.openFolder",
      icon: FolderOpen,
      action: () => {
        handleOpenFolder();
      },
    },
    {
      id: "close-workspace",
      labelKey: "closeWorkspace",
      groupKey: "file",
      keywordKey: "commandKeywords.closeWorkspace",
      icon: Home,
      action: () => {
        navigate("/welcome");
      },
    },
    {
      id: "undo",
      labelKey: "undo",
      groupKey: "edit",
      keywordKey: "commandKeywords.undo",
      icon: Undo,
      shortcut: formatForDisplay("Mod+Z"),
      action: onUndo,
    },
    {
      id: "redo",
      labelKey: "redo",
      groupKey: "edit",
      keywordKey: "commandKeywords.redo",
      icon: Redo,
      shortcut: formatForDisplay("Mod+Shift+Z"),
      action: onRedo,
    },
    {
      id: "search-in-file",
      labelKey: "searchInFile",
      groupKey: "edit",
      keywordKey: "commandKeywords.searchInFile",
      icon: Search,
      shortcut: formatForDisplay("Mod+F"),
      action: onSearchInFile,
    },
    {
      id: "search-in-files",
      labelKey: "searchInAllFiles",
      groupKey: "edit",
      keywordKey: "commandKeywords.searchInAllFiles",
      icon: Search,
      shortcut: formatForDisplay("Mod+Shift+F"),
      action: onSearchInFiles,
    },
    {
      id: "toggle-sidebar",
      labelKey: "toggleSidebar",
      groupKey: "view",
      keywordKey: "commandKeywords.toggleSidebar",
      icon: LayoutGrid,
      shortcut: formatForDisplay("Mod+\\"),
      action: onToggleSidebar,
    },
    {
      id: "toggle-fullscreen",
      labelKey: "toggleFullscreen",
      groupKey: "view",
      keywordKey: "commandKeywords.toggleFullscreen",
      icon: Maximize,
      shortcut: "F11",
      action: onToggleFullscreen,
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
      labelKey: "openSettings",
      groupKey: "settings",
      keywordKey: "commandKeywords.openSettings",
      icon: Settings,
      shortcut: formatForDisplay("Mod+Shift+,"),
      action: onOpenSettings,
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
      labelKey: "toggleTheme",
      groupKey: "settings",
      keywordKey: "commandKeywords.toggleTheme",
      icon: Moon,
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
    if (
      command.id === "new-file" ||
      command.id === "new-directory" ||
      command.id === "search-in-file" ||
      command.id === "search-in-files"
    ) {
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
      if (!acc[command.groupKey]) {
        acc[command.groupKey] = [];
      }
      acc[command.groupKey].push(command);
      return acc;
    },
    {} as Record<string, CommandType[]>,
  );

  const groupOrder = [
    "file",
    "edit",
    "view",
    "navigation",
    "tools",
    "settings",
    "help",
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
        <DialogTitle>{t("commandPaletteTitle")}</DialogTitle>
        <DialogDescription>{t("commandPaletteDesc")}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className="overflow-hidden p-0 max-w-lg gap-0 texture-surface"
        dir={direction}
        onCloseAutoFocus={handleCloseAutoFocus}
        showCloseButton={false}
      >
        <Command
          value={search}
          onValueChange={setSearch}
          className={`bg-transparent [&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5 ${
            search.trim().length > 0
              ? "[&_[cmdk-item]]:opacity-60 [&_[cmdk-item][data-selected=true]]:opacity-100"
              : ""
          }`}
        >
          <div className="relative">
            <CommandInput
              placeholder={t("typeCommand")}
              className="pe-10"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              onClick={() => onOpenChange(false)}
              className="absolute top-1/2 end-3 -translate-y-1/2 p-1 rounded hover:bg-accent transition-colors"
              aria-label="Close command palette"
            >
              <X className="size-4 text-muted-foreground" />
            </button>
          </div>
          <CommandList>
            <CommandEmpty>{t("noResults")}</CommandEmpty>
            {groupOrder.map((groupName, index) => {
              const groupCommands = groupedCommands[groupName];
              if (!groupCommands) return null;

              const groupLabel = t(groupName);

              return (
                <div key={groupName}>
                  {index > 0 && <CommandSeparator />}
                  <CommandGroup heading={groupLabel}>
                    {groupCommands.map((command) => (
                      <CommandItem
                        key={command.id}
                        value={t(command.labelKey)}
                        keywords={getLocalizedCommandKeywords(
                          t,
                          command.keywordKey,
                        )}
                        onSelect={() => handleSelect(command)}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <command.icon className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="flex-1">{t(command.labelKey)}</span>
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
