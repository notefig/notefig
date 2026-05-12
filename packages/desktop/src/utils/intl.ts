import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    debug: true,
    fallbackLng: "en",
    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    resources: {
      en: {
        translation: {
          // Welcome
          welcome: "Welcome to Metrists",
          welcomeDescription:
            "Open a folder to start browsing and editing your files.",
          welcomeTitle: "You are a",
          welcomeTitleHighlight: "Metrist.",
          newDocument: "Open Workspace",
          createBlankDocument: "Open a blank workspace",
          modified: "Modified",
          noRecentProjects: "No recent projects",
          startByCreatingNew: "Start by creating a new document",
          openFolder: "Open Folder",
          opening: "Opening...",
          loading: "Loading...",
          loadingWorkspace: "Loading workspace files...",
          chooseFolderHint: "Choose a folder to browse your files",
          clickFileHint: "Click any file to start editing",
          pickDirectory: "Select Directory",

          // Theme
          light: "Light",
          dark: "Dark",
          system: "System",

          // File Actions
          rename: "Rename",
          delete: "Delete",
          cancel: "Cancel",
          deleteConfirmTitle: 'Delete "{{name}}"?',
          deleteDirectoryConfirm:
            "This will permanently delete the folder and all its contents. This action cannot be undone.",
          deleteFileConfirm:
            "This will permanently delete the file. This action cannot be undone.",

          // File Controls
          newFile: "New file",
          newFolder: "New folder",
          sort: "Sort",
          sortFiles: "Sort files",
          sortNameAsc: "Name (A \u2192 Z)",
          sortNameDesc: "Name (Z \u2192 A)",
          sortDateModified: "Date modified",
          expandSidebar: "Expand sidebar",
          collapseSidebar: "Collapse sidebar",

          // Tab Bar
          closeTab: "Close tab",
          newTab: "New tab",

          // Status Bar
          synced: "Synced ",
          syncing: "Syncing",
          word: "word",
          words: "words",
          characters: "characters",

          // Workspace
          noFileSelected:
            "No file selected. Open a file from the sidebar or create a new one.",
          untitled: "Untitled",

          // Debug Panel
          debugRouteInfo: "🐛 DEBUG ROUTE INFO:",
          currentUrl: "Current URL:",
          basePathParam: "basePath param:",
          filePathParam: "filePath param (*):",
          currentDirectory: "currentDirectory:",
          selectedFilePath: "selectedFilePath:",
          isEditRoute: "isEditRoute:",
          searchParams: "searchParams:",

          // Settings Modal
          settings: "Settings",
          close: "Close",
          options: "Options",
          projectSettings: "Project Settings",
          general: "General",
          editor: "Editor",
          filesAndLinks: "Files and links",
          appearance: "Appearance",
          hotkeys: "Hotkeys",
          keychain: "Keychain",
          corePlugins: "Core plugins",
          communityPlugins: "Community plugins",
          backlinks: "Backlinks",
          canvas: "Canvas",
          commandPalette: "Command palette",
          dailyNotes: "Daily notes",
          fileRecovery: "File recovery",
          noteComposer: "Note composer",
          pagePreview: "Page preview",
          quickSwitcher: "Quick switcher",
          sync: "Sync",
          templates: "Templates",

          // General Settings
          version: "Version",
          installerVersion: "Installer version:",
          newVersionReady: "A new version is ready to be installed.",
          readChangelog: "Read the changelog.",
          relaunch: "Relaunch",
          automaticUpdates: "Automatic updates",
          automaticUpdatesDesc:
            "Turn this off to prevent the app from checking for updates.",
          language: "Language",
          languageDesc: "Change the display language.",
          learnAddLanguage: "Learn how to add a new language.",
          textDirection: "Text direction",
          textDirectionDesc:
            "Control the layout direction of the entire application.",
          leftToRight: "Left to Right",
          rightToLeft: "Right to Left",
          help: "Help",
          helpDesc:
            "Learn how to use the editor and get help from the community.",
          open: "Open",
          account: "Account",
          yourAccount: "Your account",
          notLoggedIn:
            "You're not logged in right now. An account is only needed for Sync, Publish, and early access versions.",
          logIn: "Log in",
          signUp: "Sign up",
          commercialLicense: "Commercial license",
          commercialLicenseDesc: "Help keep the editor 100% user-supported.",
          learnMore: "Learn more",
          activate: "Activate",
          purchase: "Purchase",
          advanced: "Advanced",
          notifySlowStartup: "Notify if startup takes longer than expected",
          notifySlowStartupDesc:
            "Diagnose issues with your app by seeing what is causing the app to load slowly.",

          // Editor Settings
          spellcheck: "Spellcheck",
          spellcheckDesc: "Enable spellcheck in the editor.",
          showLineNumbers: "Show line numbers",
          showLineNumbersDesc: "Display line numbers in the editor gutter.",
          fontSize: "Font size",
          fontSizeDesc: "Set the editor font size.",

          // Appearance Settings
          theme: "Theme",
          themeDesc: "Choose a color theme for the interface.",
          accentColor: "Accent color",
          accentColorDesc:
            "Choose an accent color for highlights and interactive elements.",

          // Languages
          english: "English",
          spanish: "Spanish",
          french: "French",
          german: "German",
          japanese: "Japanese",
          arabic: "Arabic",
          hebrew: "Hebrew",

          // Colors
          purple: "Purple",
          blue: "Blue",
          green: "Green",
          orange: "Orange",
          pink: "Pink",

          // Placeholder
          settingsWillAppear: "Settings for {{section}} will appear here.",

          // Command Palette
          commandPaletteTitle: "Command Palette",
          commandPaletteDesc: "Search for a command to run...",
          typeCommand: "Type a command or search...",
          noResults: "No results found.",

          // Command Groups
          file: "File",
          edit: "Edit",
          view: "View",
          navigation: "Navigation",
          tools: "Tools",

          // File Commands
          openFile: "Open File",
          saveFile: "Save File",
          closeFile: "Close File",

          // Edit Commands
          undo: "Undo",
          redo: "Redo",
          cut: "Cut",
          copy: "Copy",
          paste: "Paste",
          findInFile: "Find in File",
          findAndReplace: "Find and Replace",

          // View Commands
          toggleSidebar: "Toggle Sidebar",
          toggleFullscreen: "Toggle Fullscreen",
          zoomIn: "Zoom In",
          zoomOut: "Zoom Out",

          // Navigation Commands
          goToFile: "Go to File",
          goToLine: "Go to Line",
          showBookmarks: "Show Bookmarks",
          recentFiles: "Recent Files",

          // Tools Commands
          gitStatus: "Git Status",
          gitCommit: "Git Commit",

          // Checkpoints (Git Sidebar)
          saveCheckpoint: "Commit",
          checkpointSaving: "Saving commit...",
          saveCheckpointWithDescription: "Save commit with description",
          checkpointDescriptionHint: "Add a brief description of what changed",
          checkpointDescriptionPlaceholder: "What changed?",
          autoSaveCheckpoints: "Auto-save commits",
          autoSaveCheckpointsHint: "After each change",
          loadingTimeline: "Loading commit history...",
          noCheckpointsYet: "No commits yet. Save your first one!",
          latest: "Latest",
          compareCheckpoint: "Compare commit",
          restoreCheckpoint: "Restore commit",
          initializeTimeline: "Initialize commit history",
          repairTimeline: "Repair commit history",
          retry: "Retry",
          timelineNotInitializedTitle: "Commit history not initialized",
          timelineNotInitializedMessage:
            "Project commit history is not initialized.",
          timelineBusyTitle: "Commit history is busy",
          timelineBusyMessage: "Project commit history is busy.",
          timelineCorruptTitle: "Commit history needs repair",
          timelineCorruptMessage:
            "Project commit history metadata is inconsistent.",
          timelineMergeRequiredTitle: "Revert needs attention",
          timelineMergeRequiredMessage:
            "Revert would conflict with current changes.",
          timelineUnsupportedTitle: "Action unavailable",
          timelineUnsupportedMessage:
            "This action is not available in this environment.",
          timelineInvalidInputTitle: "Invalid input",
          timelineUnexpectedTitle: "Timeline error",
          timelineStateUncommitted: "Unchecked",
          timelineStateUnsynced: "Not synced",
          timelineStateSynced: "Synced",
          copyCommitHash: "Copy commit hash",
          abortRevert: "Abort revert",
          dismiss: "Dismiss",

          // Settings Commands
          openSettings: "Open Settings",
          keyboardShortcuts: "Keyboard Shortcuts",
          toggleTheme: "Toggle Dark/Light Theme",

          // Help Commands
          documentation: "Documentation",
        },
      },
    },
  });

export default i18n;
