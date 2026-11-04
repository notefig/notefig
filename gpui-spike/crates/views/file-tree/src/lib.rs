//! The file tree view: a port of `components/editor/file-tree.tsx`,
//! `file-controls.tsx` and `file-type-icon.tsx`.
//!
//! - [`FileTreePanel::new(ws, window, cx)`](FileTreePanel::new): the Files
//!   tool of a workspace's sidebar (control row + tree). `Focusable`.
//! - [`file_type_icon`]: the per-type glyph, for the palette and pickers.
//! - [`init`]: the tree's key bindings (context `FileTree`).
//!
//! Opening a file goes through the tabs module (`tabs.open`), renaming an
//! open file through `tabs.rename_open_file`, as the TS tree's delegate
//! does. The sort order lives in the URL (`?sort=`), like the TS sidebar.

mod icon_table;
mod icons;
mod panel;

pub use icons::{file_type_icon, icon_name_for};
pub use panel::{DraggedTreeRows, FileTreePanel, with_default_markdown_extension};

use gpui::{App, KeyBinding, actions};

actions!(
    file_tree,
    [
        SelectPrev,
        SelectNext,
        ExtendPrev,
        ExtendNext,
        SelectFirst,
        SelectLast,
        ExpandOrDescend,
        CollapseOrAscend,
        OpenFocused,
        RenameFocused,
        DeleteFocused,
        NewFile,
        NewFolder,
        NewScratchpad,
        RevealActiveFile,
    ]
);

/// Key bindings, as trees' keyboard model plus the app's own
/// (`Mod+Backspace` deletes, `Enter` opens).
pub fn init(cx: &mut App) {
    let ctx = Some("FileTree");
    cx.bind_keys([
        KeyBinding::new("up", SelectPrev, ctx),
        KeyBinding::new("down", SelectNext, ctx),
        KeyBinding::new("shift-up", ExtendPrev, ctx),
        KeyBinding::new("shift-down", ExtendNext, ctx),
        KeyBinding::new("home", SelectFirst, ctx),
        KeyBinding::new("end", SelectLast, ctx),
        KeyBinding::new("right", ExpandOrDescend, ctx),
        KeyBinding::new("left", CollapseOrAscend, ctx),
        KeyBinding::new("enter", OpenFocused, ctx),
        KeyBinding::new("f2", RenameFocused, ctx),
        KeyBinding::new("cmd-backspace", DeleteFocused, ctx),
        KeyBinding::new("ctrl-backspace", DeleteFocused, ctx),
    ]);
}
