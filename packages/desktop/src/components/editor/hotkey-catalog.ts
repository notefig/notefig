/**
 * The shortcuts the app ships, as a list the settings UI can render.
 *
 * This is documentation, not the source of truth: each `useHotkey()` call site
 * still owns its own binding literal. The shape is chosen so that making this
 * the registry those call sites read from — the next step, when shortcuts
 * become user-editable — is a rewire of the call sites rather than a rewrite of
 * this file.
 */
export type HotkeyGroup = "general" | "tabs" | "editing";

export interface HotkeyEntry {
  id: string;
  /** Chord in `@tanstack/react-hotkeys` notation, for `formatForDisplay`. */
  binding: string;
  /**
   * Last chord of a contiguous range, when one row stands for several
   * bindings (⌘1 through ⌘9). Rendered as `<binding> – <bindingEnd>`.
   */
  bindingEnd?: string;
  /** i18n key under `hotkeyLabels`. */
  labelKey: string;
  group: HotkeyGroup;
}

export const HOTKEY_GROUPS: { id: HotkeyGroup; labelKey: string }[] = [
  { id: "general", labelKey: "hotkeyGroups.general" },
  { id: "tabs", labelKey: "hotkeyGroups.tabs" },
  { id: "editing", labelKey: "hotkeyGroups.editing" },
];

export const HOTKEY_CATALOG: HotkeyEntry[] = [
  // src/components/editor/command-palette.tsx
  {
    id: "commandPalette",
    binding: "Mod+K",
    labelKey: "commandPalette",
    group: "general",
  },
  {
    id: "quickSwitcher",
    binding: "Mod+P",
    labelKey: "quickSwitcher",
    group: "general",
  },
  // src/components/editor/settings-modal.tsx
  {
    id: "openSettings",
    binding: "Mod+Shift+,",
    labelKey: "openSettings",
    group: "general",
  },
  // src/components/editor/icon-sidebar.tsx
  {
    id: "toggleSidebar",
    binding: "Mod+\\",
    labelKey: "toggleSidebar",
    group: "general",
  },
  // src/hooks/use-workspace-commands.ts
  {
    id: "sessionsSidebar",
    binding: "Mod+Shift+A",
    labelKey: "sessionsSidebar",
    group: "general",
  },

  // src/hooks/use-dockable-tabs.ts
  { id: "closeTab", binding: "Mod+W", labelKey: "closeTab", group: "tabs" },
  { id: "nextTab", binding: "Control+Tab", labelKey: "nextTab", group: "tabs" },
  {
    id: "prevTab",
    binding: "Control+Shift+Tab",
    labelKey: "prevTab",
    group: "tabs",
  },
  {
    id: "selectTabByNumber",
    binding: "Mod+1",
    bindingEnd: "Mod+9",
    labelKey: "selectTabByNumber",
    group: "tabs",
  },

  // src/hooks/use-workspace-commands.ts
  {
    id: "newScratchpad",
    binding: "Mod+N",
    labelKey: "newScratchpad",
    group: "editing",
  },
  {
    id: "searchInFile",
    binding: "Mod+F",
    labelKey: "searchInFile",
    group: "editing",
  },
  {
    id: "searchInAllFiles",
    binding: "Mod+Shift+F",
    labelKey: "searchInAllFiles",
    group: "editing",
  },
  { id: "undo", binding: "Mod+Z", labelKey: "undo", group: "editing" },
  { id: "redo", binding: "Mod+Shift+Z", labelKey: "redo", group: "editing" },
];
