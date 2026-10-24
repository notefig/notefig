import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type MutableRefObject,
} from "react";
import {
  FileText,
  Settings,
  Search,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Undo,
  Redo,
  Moon,
  LayoutGrid,
  Maximize,
  X,
  Home,
  MessageSquare,
  BarChart3,
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
} from "@notefig/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@notefig/ui/dialog";
import { useHotkey, formatForDisplay } from "@tanstack/react-hotkeys";
import { useTheme } from "../theme-provider";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useTranslation } from "react-i18next";
import { ScratchpadIcon } from "@/components/editor/scratchpad-icon";
import { getLocalizedCommandKeywords } from "@/utils/command-keywords";
import { useFileSearch, type FileSearchResult } from "@/hooks/use-file-search";
import { useOpenProjectFromPicker } from "@/hooks/use-open-project";
import { canOpenFile } from "@/modules/editors";
import { FileTypeIcon } from "./file-type-icon";
import { useCore } from "@notefig/core/react";
import { path as pathutil } from "@/utils/path";
import type { FeedbackApi } from "@/modules/feedback";
import { FEEDBACK_HOTKEY } from "@/modules/feedback/react";

interface CommandPaletteProps {
  open: boolean;
  workspacePath: string;
  onOpenChange: (open: boolean) => void;
  onNewScratchpad?: () => void;
  onNewFile?: () => void;
  onNewDirectory?: () => void;
  onCloseFile?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onOpenSettings?: () => void;
  onOpenUsageSettings?: () => void;
  onToggleSidebar?: () => void;
  onToggleFullscreen?: () => void | Promise<void>;
  onSearchInFile?: () => void;
  onSearchInFiles?: () => void;
  onFocusTab?: () => void;
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

/** "Send Feedback", in builds that ship with a support URL. */
function helpCommands(feedback: FeedbackApi): CommandType[] {
  if (!feedback.available) return [];
  return [
    {
      id: "send-feedback",
      labelKey: "sendFeedback",
      groupKey: "help",
      keywordKey: "commandKeywords.sendFeedback",
      icon: MessageSquare,
      shortcut: formatForDisplay(FEEDBACK_HOTKEY),
      action: feedback.open,
    },
  ];
}

/**
 * The palette's Linear-style "quick results" tail: fuzzy file matches from
 * any open workspace, rendered after every command group. Hidden outside a
 * workspace tab surface (the editor test harness) — there is nowhere to
 * open a file there.
 *
 * useFileSearch only pre-selects the top matches out of every open
 * workspace; visible filtering/ranking stays with cmdk's default scorer,
 * so file rows get the same interaction behavior as commands (within-group
 * sorting, selection management). cmdk's group re-sorting is a no-op here
 * because every group lives in its own wrapper div, so commands always stay
 * above these results.
 */
function FileQuickResults({
  workspacePath,
  query,
  showSeparator,
  onClose,
}: {
  workspacePath: string;
  query: string;
  showSeparator: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { tabs, workspaceRegistry } = useCore();
  const fileResults = useFileSearch(undefined, query, {
    filter: canOpenFile,
  });

  if (fileResults.length === 0) return null;

  const handleSelect = (result: FileSearchResult) => {
    tabs.open(result.path, { intent: "replace" });
    onClose();
  };

  return (
    <div>
      {showSeparator && <CommandSeparator />}
      <CommandGroup heading={t("quickResultsFor", { query })}>
        {fileResults.map((result) => {
          const resultWorkspace = workspaceRegistry.workspaceOf(result.path);
          const isActiveWorkspace = resultWorkspace === workspacePath;
          const showWorkspace = resultWorkspace && !isActiveWorkspace;
          return (
            <CommandItem
              key={result.path}
              // The absolute path keeps every result unique when the same
              // relative path exists in several open workspaces; keywords
              // carry relativePath/title so the query still matches what
              // the user sees.
              value={result.path}
              keywords={[
                result.relativePath,
                result.title,
                ...(showWorkspace ? [pathutil.basename(resultWorkspace)] : []),
              ]}
              onSelect={() => handleSelect(result)}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileTypeIcon
                path={result.path}
                className="w-4 h-4 text-muted-foreground shrink-0"
              />
              <span className="truncate">{result.title}</span>
              {(result.relativePath !== result.title || showWorkspace) && (
                <span
                  className="ms-auto min-w-0 truncate text-xs text-muted-foreground"
                  dir="ltr"
                >
                  {showWorkspace && (
                    <>
                      {pathutil.basename(resultWorkspace)}{" "}
                      <span className="mx-1">›</span>{" "}
                    </>
                  )}
                  {result.relativePath}
                </span>
              )}
            </CommandItem>
          );
        })}
      </CommandGroup>
    </div>
  );
}

type PaletteCommandProps = Omit<
  CommandPaletteProps,
  "open" | "onOpenChange" | "onFocusTab" | "direction"
>;

function usePaletteCommands(props: PaletteCommandProps): CommandType[] {
  const {
    workspacePath,
    onNewScratchpad,
    onNewFile,
    onNewDirectory,
    onCloseFile,
    onUndo,
    onRedo,
    onOpenSettings,
    onOpenUsageSettings,
    onToggleSidebar,
    onToggleFullscreen,
    onSearchInFile,
    onSearchInFiles,
  } = props;

  const { t } = useTranslation();
  const core = useCore();
  const { setTheme, theme } = useTheme();
  const { setTheme: persistTheme } = useAppSettings();
  const handleOpenFolder = useOpenProjectFromPicker();

  const swapTheme = useCallback(() => {
    const next = theme === "system" || theme === "dark" ? "light" : "dark";
    setTheme(next);
    persistTheme(next);
  }, [theme, setTheme, persistTheme]);

  return useMemo(() => {
    const commands: CommandType[] = [
      {
        id: "new-scratchpad",
        labelKey: "newScratchpad",
        groupKey: "file",
        keywordKey: "commandKeywords.newScratchpad",
        icon: ScratchpadIcon,
        shortcut: formatForDisplay("Mod+N"),
        action: () => {
          onNewScratchpad?.();
        },
      },
      {
        id: "new-file",
        labelKey: "newFile",
        groupKey: "file",
        keywordKey: "commandKeywords.newFile",
        icon: FilePlus,
        action: () => onNewFile?.(),
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
        action: () => onNewDirectory?.(),
      },
      {
        id: "open-folder",
        labelKey: "openFolder",
        groupKey: "file",
        keywordKey: "commandKeywords.openFolder",
        icon: FolderOpen,
        action: handleOpenFolder,
      },
      {
        id: "close-workspace",
        labelKey: "closeWorkspace",
        groupKey: "file",
        keywordKey: "commandKeywords.closeWorkspace",
        icon: Home,
        action: () => {
          void core.workspace(workspacePath).close();
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
      {
        id: "open-settings",
        labelKey: "openSettings",
        groupKey: "settings",
        keywordKey: "commandKeywords.openSettings",
        icon: Settings,
        shortcut: formatForDisplay("Mod+Shift+,"),
        action: onOpenSettings,
      },
      {
        id: "open-usage",
        labelKey: "openUsage",
        groupKey: "settings",
        keywordKey: "commandKeywords.openUsage",
        icon: BarChart3,
        shortcut: formatForDisplay("Mod+Shift+U"),
        action: onOpenUsageSettings,
      },
      {
        id: "toggle-theme",
        labelKey: "toggleTheme",
        groupKey: "settings",
        keywordKey: "commandKeywords.toggleTheme",
        icon: Moon,
        action: swapTheme,
      },
      ...helpCommands(core.feedback),
    ];
    return commands;
  }, [
    workspacePath,
    onNewScratchpad,
    onNewFile,
    onNewDirectory,
    onCloseFile,
    onUndo,
    onRedo,
    onOpenSettings,
    onOpenUsageSettings,
    onToggleSidebar,
    onToggleFullscreen,
    onSearchInFile,
    onSearchInFiles,
    swapTheme,
    handleOpenFolder,
    core.feedback,
    core.workspace,
  ]);
}

interface CommandPaletteGroupsProps {
  commands: CommandType[];
  workspacePath: string;
  query: string;
  skipFocusRestoreRef: MutableRefObject<boolean>;
  onOpenChange: (open: boolean) => void;
}

function CommandPaletteGroups({
  commands,
  workspacePath,
  query,
  skipFocusRestoreRef,
  onOpenChange,
}: CommandPaletteGroupsProps) {
  const { t } = useTranslation();
  const trimmedQuery = query.trim();

  const handleSelect = useCallback(
    (command: CommandType) => {
      if (
        command.id === "new-scratchpad" ||
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
    },
    [onOpenChange, skipFocusRestoreRef],
  );

  const groupedCommands = useMemo(() => {
    return commands.reduce<Record<string, CommandType[]>>((acc, command) => {
      if (!acc[command.groupKey]) {
        acc[command.groupKey] = [];
      }
      acc[command.groupKey].push(command);
      return acc;
    }, {});
  }, [commands]);

  // "navigation" (file results) renders LAST, Linear-style: actions always
  // outrank quick results — searching "theme" surfaces Toggle Theme above
  // theme-related files.
  const groupOrder = [
    "file",
    "edit",
    "view",
    "tools",
    "settings",
    "help",
    "navigation",
  ];

  return (
    <CommandList>
      <CommandEmpty>{t("noResults")}</CommandEmpty>
      {groupOrder.map((groupName, index) => {
        if (groupName === "navigation") {
          return (
            <FileQuickResults
              key={groupName}
              workspacePath={workspacePath}
              query={trimmedQuery}
              showSeparator={index > 0}
              onClose={() => onOpenChange(false)}
            />
          );
        }

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
                  keywords={getLocalizedCommandKeywords(t, command.keywordKey)}
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
  );
}

export function CommandPalette(props: CommandPaletteProps) {
  const {
    open,
    workspacePath,
    onOpenChange,
    onFocusTab,
    direction = "ltr",
  } = props;
  const commands = usePaletteCommands(props);
  const { t } = useTranslation();
  // cmdk's Command value/onValueChange track the *highlighted item*, not the
  // input — the query needs its own controlled state (it drives file search).
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState("");
  const skipFocusRestoreRef = useRef(false);

  useHotkey("Mod+K", () => {
    onOpenChange(!open);
  });

  useHotkey("Mod+P", () => {
    onOpenChange(true);
  });

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlighted("");
    }
  }, [open]);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      const shouldRestore = !skipFocusRestoreRef.current;
      skipFocusRestoreRef.current = false;
      if (!shouldRestore) return;
      onFocusTab?.();
    },
    [onFocusTab],
  );

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
          value={highlighted}
          onValueChange={setHighlighted}
          className={`bg-transparent [&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 ${
            highlighted.trim().length > 0
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
              value={query}
              onValueChange={setQuery}
            />
            <button
              onClick={() => onOpenChange(false)}
              className="absolute top-1/2 end-3 -translate-y-1/2 p-1 rounded hover:bg-accent transition-colors"
              aria-label={t("closeCommandPalette")}
            >
              <X className="size-4 text-muted-foreground" />
            </button>
          </div>
          <CommandPaletteGroups
            commands={commands}
            workspacePath={workspacePath}
            query={query}
            skipFocusRestoreRef={skipFocusRestoreRef}
            onOpenChange={onOpenChange}
          />
        </Command>
      </DialogContent>
    </Dialog>
  );
}
