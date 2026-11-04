//! `usePaletteCommands`: the TS command list, one row each. A command runs
//! by dispatching a GPUI action by name, so the crate that owns the
//! behaviour registers it (the shell's `workspace::NewScratchpad`, the
//! editor's undo…); a command whose action no crate registers yet is shown,
//! as in TS where an unset handler is a no-op, and does nothing.

/// The palette's groups, in render order. `navigation` (file results)
/// renders last.
pub const GROUP_ORDER: &[&str] = &["file", "edit", "view", "tools", "settings", "help", "navigation"];

#[derive(Debug, Clone)]
pub struct Command {
    pub id: &'static str,
    pub label_key: &'static str,
    pub group: &'static str,
    pub keyword_key: &'static str,
    /// Lucide name; `"#"` draws the scratchpad glyph.
    pub icon: &'static str,
    /// TanStack notation, formatted for display.
    pub shortcut: Option<&'static str>,
    /// The GPUI action names to try, in order, with optional JSON data.
    pub actions: &'static [&'static str],
    /// Commands that move focus elsewhere skip the focus restore.
    pub skips_focus_restore: bool,
}

const fn c(
    id: &'static str,
    label_key: &'static str,
    group: &'static str,
    keyword: &'static str,
    icon: &'static str,
    shortcut: Option<&'static str>,
    actions: &'static [&'static str],
) -> Command {
    Command { id, label_key, group, keyword_key: keyword, icon, shortcut, actions, skips_focus_restore: false }
}

pub fn commands(feedback_available: bool) -> Vec<Command> {
    let mut list = vec![
        Command { skips_focus_restore: true, ..c("new-scratchpad", "newScratchpad", "file", "commandKeywords.newScratchpad", "hash", Some("Mod+N"), &["workspace::NewScratchpad", "file_tree::NewScratchpad"]) },
        Command { skips_focus_restore: true, ..c("new-file", "newFile", "file", "commandKeywords.newFile", "file-plus", None, &["workspace::NewFile", "file_tree::NewFile"]) },
        c("close-file", "closeFile", "file", "commandKeywords.closeFile", "file-text", Some("Mod+W"), &["workspace::CloseTab"]),
        Command { skips_focus_restore: true, ..c("new-directory", "newFolder", "file", "commandKeywords.newFolder", "folder-plus", None, &["workspace::NewFolder", "file_tree::NewFolder"]) },
        c("open-folder", "openFolder", "file", "commandKeywords.openFolder", "folder-open", None, &["workspace::OpenFolder"]),
        c("close-workspace", "closeWorkspace", "file", "commandKeywords.closeWorkspace", "house", None, &["workspace::CloseWorkspace"]),
        c("undo", "undo", "edit", "commandKeywords.undo", "undo", Some("Mod+Z"), &["workspace::Undo", "block_editor::Undo"]),
        c("redo", "redo", "edit", "commandKeywords.redo", "redo", Some("Mod+Shift+Z"), &["workspace::Redo", "block_editor::Redo"]),
        Command { skips_focus_restore: true, ..c("search-in-file", "searchInFile", "edit", "commandKeywords.searchInFile", "search", Some("Mod+F"), &["workspace::SearchInFile"]) },
        Command { skips_focus_restore: true, ..c("search-in-files", "searchInAllFiles", "edit", "commandKeywords.searchInAllFiles", "search", Some("Mod+Shift+F"), &["workspace::SearchInFiles"]) },
        c("toggle-sidebar", "toggleSidebar", "view", "commandKeywords.toggleSidebar", "layout-grid", Some("Mod+\\"), &["workspace::ToggleSidebar"]),
        c("toggle-fullscreen", "toggleFullscreen", "view", "commandKeywords.toggleFullscreen", "maximize", Some("F11"), &["workspace::ToggleFullscreen"]),
        c("open-settings", "openSettings", "settings", "commandKeywords.openSettings", "settings", Some("Mod+Shift+,"), &["settings::OpenSettings"]),
        c("open-usage", "openUsage", "settings", "commandKeywords.openUsage", "chart-no-axes-column", Some("Mod+Shift+U"), &["settings::OpenUsage"]),
        c("toggle-theme", "toggleTheme", "settings", "commandKeywords.toggleTheme", "moon", None, &["settings::ToggleTheme"]),
    ];
    if feedback_available {
        list.push(c("send-feedback", "sendFeedback", "help", "commandKeywords.sendFeedback", "message-square", Some("Mod+Shift+M"), &["settings::ToggleFeedback"]));
    }
    list
}
