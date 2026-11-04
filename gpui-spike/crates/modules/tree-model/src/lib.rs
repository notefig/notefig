//! Each open workspace's file-tree model: `core.workspace(ws).get::<TreeModelModule>()`.
//! A port of `modules/tree-model/`.
//!
//! The TS app's model is a `@pierre/trees` `FileTree`; here it is
//! [`TreeModel`], which ports the parts of that library the app uses:
//! paths with the app's comparator (files and folders together, names
//! lowercased, date-modified newest first, the app dir pinned on top),
//! compact folders (a folder whose only child is a folder shows as one
//! `a / b` row, which is how `.notefig/scratchpads` becomes the
//! "scratchpads" row), expansion, selection and focus, keyboard moves, and
//! the inline rename/create entry.
//!
//! The model outlives the panel (sidebar view switches drop it), so
//! expansion, focus and selection survive by construction; it lives as long
//! as its workspace. The sync signature and the one-shot default expansions
//! live on the entry for the same reason.

mod model;

pub use model::{RenameCommit, RenameSession, SortOrder, TreeModel, TreePath, TreeRow};
pub use notefig_scratchpads::{APP_DIR_NAME, SCRATCHPADS_REL_PATH, is_protected_tree_path};

use std::cell::RefCell;
use std::rc::Rc;

use notefig_core::{Module, ModuleContext, WorkspacePart};

/// A model plus the bookkeeping the panel keeps across mounts
/// (`TreeModelEntry`).
pub struct TreeModelEntry {
    pub model: TreeModel,
    /// Sorted-joined paths the model last saw: an unchanged remount never
    /// resets (scroll survives).
    pub paths_signature: Option<String>,
    /// First-ever mount: open root-level folders once paths arrive.
    pub needs_default_expansion: bool,
    /// The scratchpads row opens on its first appearance.
    pub needs_scratchpads_expansion: bool,
    /// Pixels scrolled, kept across remounts.
    pub scroll_top: f32,
}

/// What the first mount builds the model from (`TreeModelInit`).
pub struct TreeModelInit {
    pub order: SortOrder,
    pub initial_selected: Option<String>,
    /// `None`: never mounted, use the default expansion.
    pub initial_expanded: Option<Vec<String>>,
}

/// `core.workspace(ws).treeModel`.
#[derive(Default)]
pub struct WorkspaceTreeModel {
    entry: RefCell<Option<Rc<RefCell<TreeModelEntry>>>>,
}

pub fn create_workspace_tree_model() -> WorkspaceTreeModel {
    WorkspaceTreeModel::default()
}

impl WorkspaceTreeModel {
    /// The workspace's model: built from `init` on the first call, the same
    /// one after.
    pub fn acquire(&self, init: TreeModelInit) -> Rc<RefCell<TreeModelEntry>> {
        self.entry
            .borrow_mut()
            .get_or_insert_with(|| {
                let mut model = TreeModel::new(init.order);
                let fresh = init.initial_expanded.is_none();
                if let Some(expanded) = init.initial_expanded {
                    model.set_expanded_paths(expanded);
                }
                if let Some(sel) = init.initial_selected {
                    model.select_only(&sel);
                }
                Rc::new(RefCell::new(TreeModelEntry {
                    model,
                    paths_signature: None,
                    needs_default_expansion: fresh,
                    needs_scratchpads_expansion: fresh,
                    scroll_top: 0.,
                }))
            })
            .clone()
    }

    pub fn dispose(&self) {
        self.entry.borrow_mut().take();
    }
}

/// Whether `path` (tree-domain) can be dragged or renamed: not a protected
/// app path, and not a folder with open tabs inside (`canDrop` /
/// `canRename`). `contains_open_tab` answers for a folder.
pub fn can_move(path: &str, contains_open_tab: impl Fn(&str) -> bool) -> bool {
    !is_protected_tree_path(path) && !contains_open_tab(path)
}

/// Where a drop of `dragged` onto `target_dir` (`""` for the root) lands;
/// `None` for a no-op or a folder into itself.
pub fn drop_destination(dragged: &str, target_dir: &str) -> Option<String> {
    let name = dragged.rsplit('/').next().unwrap_or(dragged);
    let dest = if target_dir.is_empty() { name.to_string() } else { format!("{target_dir}/{name}") };
    let into_itself = target_dir == dragged || target_dir.starts_with(&format!("{dragged}/"));
    (dest != dragged && !into_itself).then_some(dest)
}

/// `treeModelModule`.
pub struct TreeModelModule;

impl Module for TreeModelModule {
    const NAME: &'static str = "treeModel";
    type Api = ();
    type Workspace = WorkspaceTreeModel;

    fn register(_: &ModuleContext) {}

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(WorkspacePart::new(|_, _| Ok(create_workspace_tree_model())).dispose(|tm: Rc<WorkspaceTreeModel>, _, _| {
            tm.dispose();
            Box::pin(futures::future::ready(Ok(())))
        }))
    }
}

#[cfg(test)]
mod tests;
