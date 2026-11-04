//! The window body — a port of `components/workspace.tsx`,
//! `components/editor/sidebar.tsx`, `global-column.tsx`,
//! `everything-panel.tsx`, `components/dockable/*`, the editor host
//! (`polymorphic-editor.tsx`, `tiptap-toolbar*.tsx`, `tiptap-link-menu.tsx`,
//! `tiptap-table-menu.tsx`, `frontmatter-popover.tsx`, `code-viewer.tsx`,
//! `image-viewer.tsx`), `status-bar.tsx`, `close-workspace-dialog` and
//! `text-prompt-dialog.tsx`.
//!
//! - [`WorkspaceRoot`]: the app at "/": the welcome screen with nothing
//!   open, else the shell over the focused workspace.
//! - [`Panels`]: how the shell composes other teams' views. The root
//!   (`crates/app/src/main.rs`) fills one slot per contract in
//!   ARCHITECTURE.md; an empty slot renders a placeholder. This keeps the
//!   shell building whatever state a panel crate is in.
//! - [`prompt_text`]: the text prompt dialog (`PlatformUi::prompt_text`).

mod dialogs;
mod dock;
mod editor_host;
mod everything;
mod global_column;
mod prose;
mod root;
mod shell;
mod sidebar;
mod status_bar;
mod toolbar;

use std::rc::Rc;

use gpui::{Action, AnyView, App, Global, KeyBinding, Window, actions};
use notefig_core::WorkspaceHandle;

pub use dialogs::{prompt_text, prompt_text_in};
pub use root::WorkspaceRoot;

actions!(
    workspace,
    [
        /// `Mod+\`: open or close the sidebar.
        ToggleSidebar,
        /// `Mod+W`: close the active tab.
        CloseTab,
        /// `Mod+N`: a new scratchpad in the focused workspace.
        NewScratchpad,
        /// New File / New Folder: the tree's inline naming at the root.
        NewFile,
        NewFolder,
        /// `Mod+F`: the Search tab scoped to the active file, seeded with
        /// the selection.
        SearchInFile,
        /// `Mod+Shift+F`: the Search tab over every file.
        SearchInFiles,
        /// Undo / redo in the active tab (the palette's fallback when the
        /// editor does not have focus).
        Undo,
        Redo,
        /// The bundled release notes as a tab.
        OpenReleaseNotes,
        /// `Mod+S`: flush the active document's pending edits now.
        SaveActive,
        /// The sidebar's tools.
        ShowFiles,
        ShowSearch,
        ShowGit,
        ShowSessions,
        ShowEverything,
        /// Window focus across the dock.
        FocusNextWindow,
        FocusPrevWindow,
        /// Split the active tab into a new window to the right / below.
        SplitRight,
        SplitDown,
        /// Next / previous tab in the active window.
        NextTab,
        PrevTab,
        /// Open a folder as a workspace (the native picker).
        OpenFolder,
        /// Close the focused workspace (asks first).
        CloseWorkspace,
        /// Settings.
        OpenSettings,
        ToggleFullscreen,
    ]
);

/// Open a file as a tab (the palette's file results).
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema, Action)]
#[action(namespace = workspace)]
pub struct OpenFile {
    pub path: String,
}

/// The workspace's text direction (`"ltr"` | `"rtl"`), kept in its
/// project settings.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema, Action)]
#[action(namespace = workspace)]
pub struct SetTextDirection {
    pub direction: String,
}

/// Constructors for the panels other view crates provide (ARCHITECTURE.md's
/// contracts). Set with [`set_panels`]; each defaults to a placeholder.
#[derive(Default, Clone)]
pub struct Panels {
    /// `FileTreePanel::new(ws, window, cx)`.
    pub files: Option<PanelCtor>,
    /// `SearchPanel::new(ws, window, cx)`.
    pub search: Option<PanelCtor>,
    /// Start the file tree's inline create at `parent` (tree-relative, ""
    /// for the root; a folder when `true`) on a view `files` built
    /// (`FileTreePanel::start_create`).
    pub files_start_create: Option<Rc<dyn Fn(&AnyView, &str, bool, &mut Window, &mut App)>>,
    /// Focus the search view's input with an optional file pattern and
    /// seed query (`SearchPanel::focus_input`).
    pub search_focus: Option<Rc<dyn Fn(&AnyView, Option<&str>, Option<&str>, &mut Window, &mut App)>>,
    /// `GitPanel::new(ws, window, cx)`.
    pub git: Option<PanelCtor>,
    /// `SessionsPanel::new(ws, window, cx)`.
    pub sessions: Option<PanelCtor>,
    /// `ChatTab::new(ws, task_id, window, cx)`.
    pub chat_tab: Option<Rc<dyn Fn(WorkspaceHandle, String, &mut Window, &mut App) -> AnyView>>,
    /// `Welcome::new(window, cx)`.
    pub welcome: Option<Rc<dyn Fn(&mut Window, &mut App) -> AnyView>>,
    /// The release-notes tab's content and title.
    pub release_notes: Option<Rc<dyn Fn(&mut Window, &mut App) -> (AnyView, String)>>,
    /// `open_settings(section, window, cx)`.
    pub open_settings: Option<Rc<dyn Fn(Option<&str>, &mut Window, &mut App)>>,
    /// The command palette's `toggle(window, cx)`.
    pub toggle_palette: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    /// Agent tasks mid-run in a workspace (the close confirmation).
    pub running_task_count: Option<Rc<dyn Fn(&str, &App) -> usize>>,
    /// An agent session's title, for its tab.
    pub agent_title: Option<Rc<dyn Fn(&str, &App) -> Option<String>>>,
    /// The status bar's tunnel pill ("Connect a machine").
    pub tunnel_pill: Option<Rc<dyn Fn(&mut Window, &mut App) -> AnyView>>,
    /// Told when the focused workspace changes (the palette's scope).
    pub workspace_focused: Option<Rc<dyn Fn(Option<&str>, &mut App)>>,
    /// Overlays the shell places over everything (update toasts).
    pub overlays: Vec<Rc<dyn Fn(&mut Window, &mut App) -> AnyView>>,
    /// More per-editor attachments (dictation's editor target, …), each
    /// kept alive with the editor host: called with the markdown editor and
    /// its document path once the document has loaded.
    pub editor_attachments: Vec<Rc<dyn Fn(&gpui::Entity<markdown_editor::BlockEditorState>, &str, &mut Window, &mut App) -> Option<notefig_core::Subscription>>>,
    /// The editor's change-tracking round of an agent turn
    /// (`notefig_view_agent::prompt_round_id`): an attributed write is
    /// applied as `EditOrigin::Agent { round }`.
    pub round_id_for_turn: Option<Rc<dyn Fn(&str) -> markdown_editor::RoundId>>,
    /// The editor's prompt-widget node views (`prompt_widget_view`), given
    /// the markdown editor to install them on.
    /// The document minimap's dots (TS `promptMinimapSource` + the
    /// registry's `revealWidget` as the jump), for the document at a path.
    /// The rail is drawn only when this is set. The source is read on every
    /// render; animated dots keep the window drawing while they move.
    pub minimap: Option<Rc<dyn Fn(&str, &App) -> Option<(markdown_editor::MinimapSource, Option<markdown_editor::MinimapJump>)>>>,
    pub install_node_views: Option<Rc<dyn Fn(&gpui::Entity<markdown_editor::BlockEditorState>, &str, &mut Window, &mut App)>>,
}

/// A sidebar tool panel's constructor.
pub type PanelCtor = Rc<dyn Fn(WorkspaceHandle, &mut Window, &mut App) -> AnyView>;

struct PanelsGlobal(Panels);
impl Global for PanelsGlobal {}

/// Hand the shell panels. Merges: each `Some` slot replaces that slot,
/// `None` slots keep what an earlier call set, and overlays add up — so
/// each owner can register its own panels in `main.rs` independently.
pub fn set_panels(panels: Panels, cx: &mut App) {
    let mut current = cx.try_global::<PanelsGlobal>().map(|p| p.0.clone()).unwrap_or_default();
    macro_rules! merge {
        ($($f:ident),*) => { $( if panels.$f.is_some() { current.$f = panels.$f.clone(); } )* };
    }
    merge!(files, search, files_start_create, search_focus, git, sessions, chat_tab, welcome, release_notes, open_settings, toggle_palette, running_task_count, agent_title, workspace_focused, round_id_for_turn, tunnel_pill, install_node_views, minimap);
    current.overlays.extend(panels.overlays);
    current.editor_attachments.extend(panels.editor_attachments);
    cx.set_global(PanelsGlobal(current));
}

pub(crate) fn panels(cx: &App) -> Panels {
    cx.try_global::<PanelsGlobal>().map(|p| p.0.clone()).unwrap_or_default()
}

/// The shell's actions and key bindings.
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-\\", ToggleSidebar, None),
        KeyBinding::new("cmd-w", CloseTab, None),
        KeyBinding::new("cmd-n", NewScratchpad, None),
        KeyBinding::new("cmd-f", SearchInFile, None),
        KeyBinding::new("cmd-s", SaveActive, None),
        KeyBinding::new("cmd-shift-e", ShowFiles, None),
        KeyBinding::new("cmd-shift-f", SearchInFiles, None),
        KeyBinding::new("cmd-shift-g", ShowGit, None),
        KeyBinding::new("cmd-shift-a", ShowSessions, None),
        KeyBinding::new("cmd-alt-right", FocusNextWindow, None),
        KeyBinding::new("cmd-alt-left", FocusPrevWindow, None),
        KeyBinding::new("cmd-shift-]", NextTab, None),
        KeyBinding::new("cmd-shift-[", PrevTab, None),
        KeyBinding::new("cmd-o", OpenFolder, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-ctrl-f", ToggleFullscreen, None),
    ]);
    editor_host::init(cx);
    dialogs::init(cx);
    shell::init_global_actions(cx);
}
