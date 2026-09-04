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
          welcomeDescription:
            "A better place to write notes, plans and workflows with AI.",
          welcomeTitle: "Welcome to",
          welcomeTitleHighlight: "Notefig.",
          newDocument: "Open Workspace",
          createBlankDocument: "Open a blank workspace",
          modified: "Modified",
          noRecentProjects: "No recent projects",
          startByCreatingNew: "Start by creating a new document",
          recentWorkspaces: "Recent",
          openWorkspaceHint: "Choose a folder to work in",
          harnessNoneConfigured: "No harnesses configured",
          releaseNotesLink: "Release notes",
          openFolder: "Open Folder",
          opening: "Opening...",
          loading: "Loading...",
          loadingWorkspace: "Loading workspace files...",
          chooseFolderHint: "Choose a folder to browse your files",
          clickFileHint: "Click any file to start editing",
          pickDirectory: "Select Directory",

          // Workspace Access Recovery
          fsAccessLostTitle: "Folder access lost",
          fsAccessLostBodyWeb:
            "Your browser paused access to this folder. Grant access again to keep editing — if that fails, reset the site's file permissions (lock icon in the address bar).",
          fsAccessLostBodyDesktop:
            "The operating system denied access to this folder. On macOS, enable this app under Privacy & Security → Files and Folders, then retry.",
          fsRestoreAccess: "Restore access",
          fsReconnectTitle: "Folder no longer connected",
          fsReconnectBody:
            "The connection to this folder was lost. Choose the folder again to reconnect.",
          fsChooseFolderAgain: "Choose folder again",
          fsOpenSystemSettings: "Open System Settings",
          fsSitePermissionsHelp: "How to change site permissions",
          backToHome: "Back to home",
          pickerPermissionDenied:
            "Browser denied folder access — check the site's file permissions.",

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
          newScratchpad: "New scratchpad",
          newFile: "New file",
          newFolder: "New folder",
          sort: "Sort",
          sortFiles: "Sort files",
          switchWorkspace: "Switch workspace",
          sortNameAsc: "Name (A \u2192 Z)",
          sortNameDesc: "Name (Z \u2192 A)",
          sortDateModified: "Date modified",
          expandSidebar: "Expand sidebar",
          collapseSidebar: "Collapse sidebar",

          // Tab Bar
          closeTab: "Close tab",
          newTab: "New tab",
          openInNewTab: "Open in new tab",

          // Status Bar
          saved: "Saved",
          saving: "Saving",
          checked: "Checked",
          unchecked: "Unchecked",
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
          generalSettings: "General Settings",
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
          updaterIdle: "Click to check for updates.",
          updaterChecking: "Checking for updates...",
          updaterUpToDate: "You're on the latest version.",
          updaterUpToDateShort: "Up to date",
          updaterAvailable: "Version {{version}} is available.",
          updaterDownloading: "Downloading update...",
          updaterReady: "Update downloaded. Restart to apply.",
          updaterCheckForUpdates: "Check for updates",
          updaterDownload: "Download",
          updaterRefresh: "Refresh",
          updaterRestart: "Restart",
          updaterGenericError: "Something went wrong. Please try again.",
          updaterToastAvailableTitle: "Update {{version}} is available",
          updaterToastAvailableDescription:
            "Download now and restart when it's ready.",
          updaterToastAvailableDescriptionRefresh:
            "Refresh now to load the latest version.",
          updaterToastDownloading: "Downloading update...",
          updaterToastDownloaded: "Update downloaded.",
          updaterToastReadyToRestart:
            "Update is ready. Restart to apply changes.",
          installerVersion: "Installer version:",
          newVersionReady: "A new version is ready to be installed.",
          readChangelog: "Read the changelog.",
          releaseNotesTitle: "Release Notes",
          releaseNotesEmpty: "No release notes yet.",
          relaunch: "Relaunch",
          scratchpadOnStartup: "Scratchpad on startup",
          scratchpadOnStartupDesc:
            "Open a scratchpad when you enter a project with nothing open.",
          automaticUpdates: "Automatic updates",
          automaticUpdatesDesc:
            "Download updates in the background and notify you when they're ready to install.",
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
          quickResultsFor: 'Quick results for "{{query}}"',
          mentionFilesLabel: "Reference a file",

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
          closeWorkspace: "Close Workspace",

          // Edit Commands
          undo: "Undo",
          redo: "Redo",
          cut: "Cut",
          copy: "Copy",
          paste: "Paste",
          searchInFile: "Search in File",
          searchInAllFiles: "Search in All Files",
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
          toggleTheme: "Toggle Theme",

          // Hotkeys Settings
          hotkeysDescription:
            "The keyboard shortcuts this version ships with. Customizing them is coming in a future release.",
          hotkeyGroups: {
            general: "General",
            tabs: "Tabs",
            editing: "Editing",
          },
          hotkeyLabels: {
            commandPalette: "Open command palette",
            quickSwitcher: "Quick switcher",
            openSettings: "Open settings",
            toggleSidebar: "Toggle sidebar",
            sessionsSidebar: "Open agent sessions",
            closeTab: "Close tab",
            nextTab: "Next tab",
            prevTab: "Previous tab",
            selectTabByNumber: "Select tab by number",
            newScratchpad: "New scratchpad",
            searchInFile: "Find in file",
            searchInAllFiles: "Find in all files",
            undo: "Undo",
            redo: "Redo",
          },

          // Command Keywords
          commandKeywords: {
            newScratchpad: [
              "new",
              "scratchpad",
              "note",
              "create",
              "quick",
              "untitled",
            ],
            newFile: [
              "new",
              "file",
              "create",
              "add",
              "in",
              "folder",
              "location",
            ],
            closeFile: ["close", "file", "tab"],
            newFolder: ["new", "folder", "directory", "create"],
            openFolder: ["open", "folder", "workspace", "directory"],
            closeWorkspace: ["close", "workspace", "home"],
            undo: ["undo", "revert", "back"],
            redo: ["redo", "forward", "again"],
            searchInFile: ["search", "find", "current", "file"],
            searchInAllFiles: ["search", "find", "global", "workspace"],
            toggleSidebar: ["sidebar", "panel", "toggle", "files"],
            toggleFullscreen: ["fullscreen", "maximize", "window"],
            openSettings: ["settings", "preferences", "options"],
            toggleTheme: [
              "theme",
              "appearance",
              "light",
              "dark",
              "system",
              "mode",
            ],
          },

          // Help Commands
          documentation: "Documentation",

          // Agent UI — sessions sidebar panel
          agentSessions: "Sessions",
          agentNewSession: "New session",
          agentNewSessionWith: "New session with {{harness}}",
          agentChooseHarness: "Choose harness",
          agentNoSessions:
            "No agent sessions yet. Start one with the + button above, or prompt from any document.",
          agentStopSession: "Stop session",
          agentTrustTitle: "Run an agent in this workspace?",
          agentTrustDescription:
            "This spawns {{harness}} as a local process with access to the files in this folder. Only continue for workspaces you trust.",
          agentTrustConfirm: "Trust & start",

          // Remote agent tunnel (pairing with `notefig agent`)
          tunnelPairTitle: "Connect to a machine",
          tunnelPairDescription:
            "Run `npx notefig agent` on your computer, then scan the QR code or paste the pairing code below.",
          tunnelPairCodePlaceholder: "Paste pairing code",
          tunnelPairConnect: "Connect",
          tunnelPairConnecting: "Connecting…",
          tunnelPairHint:
            "The code never reaches any server — it stays in the link fragment.",
          tunnelPairedTitle: "Connected machine",
          tunnelPairedWith: "Paired with {{host}}",
          tunnelPairDisconnect: "Disconnect",
          tunnelPairDone: "Done",
          tunnelConnectMachine: "Connect a machine",
          tunnelNoConnection: "Connect a machine to run agents on the web.",
          tunnelStatusConnected: "Paired with {{host}}",
          tunnelStatusConnecting: "Connecting…",
          tunnelStatusReconnect: "Disconnected — re-pair",

          // Agent UI — session meta labels (describeTaskMeta)
          agentNeedsSignIn: "needs sign-in",
          agentRunning: "running",
          agentRunningQueued: "running · {{count}} queued",
          agentQueuedCount: "{{count}} queued",
          agentFailed: "failed",
          agentSessionUnavailable: "unavailable",

          // Agent UI — restored sessions (MET-54)
          agentSessionUnavailableNotice:
            "This session is no longer available — the harness has no record of it.",
          agentDeleteSession: "Delete session",
          agentBlobAnswerOrphaned:
            "Answer saved to the document, but the session that asked is no longer available.",

          // Agent UI — chat tab
          agentSessionEnded: "Session ended.",
          agentSignInRequired: "Sign-in required",
          agentSignedInRetry: "I've signed in — retry",
          agentWorking: "Working…",
          agentTurnFailed: "Turn failed:",
          agentThinking: "Thinking…",
          agentQueuedBadge: "queued",
          agentRemoveFromQueue: "Remove from queue",
          agentScrollToEnd: "Scroll to end",
          agentPromptPlaceholder: "Ask anything, @models, /prompts …",
          agentLoadingSession: "Loading session…",
          agentRefreshSession: "Refresh session",
          agentCopySessionId: "Copy session ID",
          agentCopyResumeCommand: "Copy resume command",
          agentSend: "Send (⏎)",
          agentQueue: "Queue (⏎)",
          agentStop: "Stop",
          copyMessage: "Copy message",
          copied: "Copied",
          agentAuthoredBlob: "authored a {{type}} in",
          agentChangedFiles_one: "{{count}} changed file",
          agentChangedFiles_other: "{{count}} changed files",
          agentTerminal: "Terminal {{id}}",
          agentContentOfType: "{{type}} content",

          // Agent UI — inline prompt blob (in the markdown editor)
          promptBlobPlaceholder: "Ask AI — edit this doc, or any other…",
          promptBlobQueued: "Queued",
          promptBlobQueuedAhead: "Queued · {{count}} ahead",
          promptBlobEdit: "Edit prompt",
          promptBlobDone: "Done",
          promptBlobStopped: "Stopped",
          promptBlobFailed: "Failed.",
          promptBlobRetry: "Retry",
          promptBlobDismiss: "Dismiss",
          promptBlobOpenChat: "Open chat",
          promptBlobReply: "Reply…",
          promptBlobShowMore: "Show more",
          promptBlobShowLess: "Show less",
          promptBlobIssue: "Issue",
          promptBlobSessionGone:
            "That session is no longer available — your reply was kept. Sending again starts a new session.",
          promptBlobNewSessionWith: "New {{harness}} conversation",
          promptBlobTrustWarning:
            "Spawns {{name}} with access to this folder. Press Enter again to continue.",

          // Agent UI — harness settings (SettingsModal "Harnesses" section)
          agentSettings: "Agent",
          harnessSettingsTitle: "Harnesses",
          harnessSettingsDescription:
            "Agents Notefig can launch. Discovery checks which are installed on this machine; entries you customize stay available either way.",
          harnessRescan: "Rescan",
          harnessRescanFailed: "Couldn't scan this machine for harnesses.",
          harnessAdd: "Add harness",
          harnessEditTitle: "Edit harness",
          harnessOriginOverridden: "customized",
          harnessOriginCustom: "custom",
          harnessRowActions: "Harness actions",
          harnessMakeDefault: "Set as default",
          harnessEnable: "Enable",
          harnessDisable: "Disable",
          harnessEdit: "Edit",
          harnessCollapse: "Collapse",
          harnessDelete: "Delete",
          harnessDeleteConfirmTitle: "Delete {{label}}?",
          harnessDeleteConfirmDescription:
            "Removes this harness and its configuration. Existing sessions are unaffected.",
          harnessResetDefaults: "Reset to defaults",
          harnessResetConfirmTitle: "Reset {{label}} to defaults?",
          harnessResetConfirmDescription:
            "Removes your customizations; the built-in command, arguments, and environment apply again.",
          harnessSave: "Save",
          harnessLabelField: "Name",
          harnessLabelRequired: "A name is required.",
          harnessLabelPlaceholder: "My harness",
          harnessCommandField: "Command",
          harnessCommandRequired:
            "A command is required — reset to defaults to restore the built-in one.",
          harnessCommandPlaceholder: "/path/to/binary",
          harnessArgsField: "Arguments (one per line)",
          harnessArgsPlaceholder: "--flag\n${workspace}",
          harnessEnvField: "Environment variables",
          harnessEnvPlaceholder:
            "CLAUDE_CODE_USE_VERTEX=1\nANTHROPIC_VERTEX_PROJECT_ID=my-project",
          harnessEnvErrorNoEquals: "Line {{line}}: missing =",
          harnessEnvErrorBadKey: "Line {{line}}: invalid variable name",
          harnessEnvErrorDuplicate: "Line {{line}}: duplicate variable",
          harnessProbeField: "Probe command (optional)",
          harnessProbePlaceholder: "command -v <command>",
          harnessResumeField: "Resume command (optional)",
          harnessResumePlaceholder:
            "cd ${workspace} && <command> --resume ${sessionId}",
          harnessMcpField: "App tools (MCP)",
          harnessMcpNone: "No app tools",
          harnessMcpSessionNew: "Register via ACP session",
          harnessMcpOptInWarning:
            "This claims untested capabilities: the harness must support MCP servers passed through session/new, or tool calls will silently do nothing.",

          // Agent Tools (display names — AgentTool.title holds these keys,
          // never the literal text; resolved in mcp-server.ts's tools/list)
          agentToolWorkspaceListDocuments: "List Documents",
          agentToolWorkspaceReadDocument: "Read Document",
          agentToolWorkspaceOpenFiles: "Open Files",
          agentToolHistoryLog: "Document History",
          agentToolHistoryDiff: "Compare Versions",
          agentToolHistoryCheckpoint: "Save Checkpoint",
          agentToolHistoryRestore: "Restore Version",
          agentToolAuthorBlob: "Add Interactive Block",
          agentToolWidgetRespond: "Respond in Widget",

          // Telemetry consent + Privacy settings
          telemetryConsentTitle: "Help improve Notefig",
          telemetryConsentBody:
            "Notefig can send anonymous reports to help us fix bugs and improve the app. Your documents, file paths, and workspace contents never leave your machine.",
          telemetryCrashLabel: "Crash reports",
          telemetryCrashDescription:
            "Anonymous error reports so we can fix bugs.",
          telemetryAnalyticsLabel: "Usage analytics",
          telemetryAnalyticsDescription:
            "Anonymous counts of feature use. Never your content.",
          telemetryConsentContinue: "Continue",
          telemetryConsentFootnote:
            "You can change this anytime in Settings → Privacy.",
          privacySettings: "Privacy",
          telemetryDisabledInBuild:
            "Telemetry is disabled in this build — no data is ever sent.",
        },
      },
    },
  });

export default i18n;
