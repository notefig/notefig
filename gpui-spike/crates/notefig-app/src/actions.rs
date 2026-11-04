//! App actions, key bindings, native menus and the command palette's list.

use gpui::{Action, App, KeyBinding, Menu, MenuItem, OsAction};
use gpui_kit::actions;
use gpui_kit::component::input;

actions!(
    notefig,
    [
        OpenFolder,
        CloseWorkspace,
        NewNote,
        NewFolder,
        Save,
        CloseTab,
        SplitRight,
        SplitDown,
        QuickOpen,
        CommandPalette,
        ToggleSidebar,
        ShowFiles,
        ShowSearch,
        ShowSessions,
        NewSession,
        OpenSettings,
        NextChange,
        PreviousChange,
        RevealActiveFile,
        NextTab,
        PreviousTab,
        FocusNextPane,
        FocusPreviousPane,
        ToggleTheme,
        ThemeSystem,
        ThemeLight,
        ThemeDark,
        Quit,
    ]
);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-o", OpenFolder, None),
        KeyBinding::new("cmd-n", NewNote, None),
        KeyBinding::new("cmd-s", Save, None),
        KeyBinding::new("cmd-w", CloseTab, None),
        KeyBinding::new("cmd-\\", SplitRight, None),
        KeyBinding::new("cmd-alt-\\", SplitDown, None),
        KeyBinding::new("cmd-p", QuickOpen, None),
        KeyBinding::new("cmd-shift-p", CommandPalette, None),
        KeyBinding::new("ctrl-cmd-s", ToggleSidebar, None),
        KeyBinding::new("cmd-shift-e", ShowFiles, None),
        KeyBinding::new("cmd-shift-f", ShowSearch, None),
        KeyBinding::new("cmd-shift-a", ShowSessions, None),
        KeyBinding::new("ctrl-tab", NextTab, None),
        KeyBinding::new("ctrl-shift-tab", PreviousTab, None),
        KeyBinding::new("cmd-]", FocusNextPane, None),
        KeyBinding::new("cmd-[", FocusPreviousPane, None),
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-alt-n", NewSession, None),
        KeyBinding::new("alt-f5", NextChange, None),
        KeyBinding::new("alt-shift-f5", PreviousChange, None),
    ]);
}

pub fn set_menus(cx: &mut App) {
    cx.set_menus([
        Menu::new("Notefig").items([
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::separator(),
            MenuItem::action("Quit Notefig", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Note", NewNote),
            MenuItem::action("New Folder", NewFolder),
            MenuItem::action("Open Folder…", OpenFolder),
            MenuItem::separator(),
            MenuItem::action("Save", Save),
            MenuItem::action("Close Tab", CloseTab),
            MenuItem::action("Close Workspace", CloseWorkspace),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", input::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", input::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", input::Paste, OsAction::Paste),
            MenuItem::os_action("Select All", input::SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Command Palette…", CommandPalette),
            MenuItem::action("Quick Open…", QuickOpen),
            MenuItem::separator(),
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            MenuItem::action("Files", ShowFiles),
            MenuItem::action("Search", ShowSearch),
            MenuItem::action("Sessions", ShowSessions),
            MenuItem::action("Reveal Active File", RevealActiveFile),
            MenuItem::separator(),
            MenuItem::action("Split Right", SplitRight),
            MenuItem::action("Split Down", SplitDown),
            MenuItem::separator(),
            MenuItem::submenu(Menu::new("Theme").items([
                MenuItem::action("System", ThemeSystem),
                MenuItem::action("Light", ThemeLight),
                MenuItem::action("Dark", ThemeDark),
            ])),
        ]),
    ]);
}

/// The command palette's entries: label and the action it dispatches.
pub fn palette_commands() -> Vec<(&'static str, Box<dyn Action>)> {
    vec![
        ("New Note", NewNote.boxed_clone()),
        ("New Folder", NewFolder.boxed_clone()),
        ("New Session", NewSession.boxed_clone()),
        ("Open Folder…", OpenFolder.boxed_clone()),
        ("Close Workspace", CloseWorkspace.boxed_clone()),
        ("Save", Save.boxed_clone()),
        ("Close Tab", CloseTab.boxed_clone()),
        ("Split Right", SplitRight.boxed_clone()),
        ("Split Down", SplitDown.boxed_clone()),
        ("Quick Open File…", QuickOpen.boxed_clone()),
        ("Toggle Sidebar", ToggleSidebar.boxed_clone()),
        ("Show Files", ShowFiles.boxed_clone()),
        ("Search in Files", ShowSearch.boxed_clone()),
        ("Show Sessions", ShowSessions.boxed_clone()),
        ("Reveal Active File in Sidebar", RevealActiveFile.boxed_clone()),
        ("Next Tab", NextTab.boxed_clone()),
        ("Previous Tab", PreviousTab.boxed_clone()),
        ("Focus Next Pane", FocusNextPane.boxed_clone()),
        ("Toggle Theme", ToggleTheme.boxed_clone()),
        ("Theme: System", ThemeSystem.boxed_clone()),
        ("Theme: Light", ThemeLight.boxed_clone()),
        ("Theme: Dark", ThemeDark.boxed_clone()),
        ("Settings", OpenSettings.boxed_clone()),
        ("Next Change (agent edits)", NextChange.boxed_clone()),
        ("Previous Change (agent edits)", PreviousChange.boxed_clone()),
        ("Quit", Quit.boxed_clone()),
    ]
}
