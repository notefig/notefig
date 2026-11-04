//! Memory of which directories are expanded, per open workspace:
//! `core.workspace(ws).get::<TreeExpansionModule>()`. A port of
//! `modules/tree-expansion/`.
//!
//! Mirrored from the tree model and replayed into the next one as its
//! initial expansion. A close (or a restart) starts fresh. Paths are
//! canonical workspace-relative.

use std::cell::RefCell;
use std::collections::HashSet;

use notefig_core::{Module, ModuleContext, WorkspacePart};

/// `ExpansionMemory`.
#[derive(Default)]
pub struct ExpansionMemory {
    expanded: RefCell<Option<HashSet<String>>>,
}

pub fn create_expansion_memory() -> ExpansionMemory {
    ExpansionMemory::default()
}

impl ExpansionMemory {
    /// The remembered set, or `None` if this workspace never mounted a tree
    /// (callers then use the default expansion).
    pub fn paths(&self) -> Option<Vec<String>> {
        self.expanded.borrow().as_ref().map(|s| {
            let mut v: Vec<String> = s.iter().cloned().collect();
            v.sort();
            v
        })
    }

    pub fn is_expanded(&self, path: &str) -> bool {
        self.expanded.borrow().as_ref().is_some_and(|s| s.contains(path))
    }

    /// Mirror the model's visible directory rows (`attach`'s `record`):
    /// only rows in the projection are touched, so a folder hidden under a
    /// collapsed ancestor keeps its state.
    pub fn record<'a>(&self, visible_dirs: impl IntoIterator<Item = (&'a str, bool)>) {
        let mut slot = self.expanded.borrow_mut();
        let set = slot.get_or_insert_with(HashSet::new);
        for (path, expanded) in visible_dirs {
            if expanded {
                set.insert(path.to_string());
            } else {
                set.remove(path);
            }
        }
    }
}

/// `treeExpansionModule`.
pub struct TreeExpansionModule;

impl Module for TreeExpansionModule {
    const NAME: &'static str = "treeExpansion";
    type Api = ();
    type Workspace = ExpansionMemory;

    fn register(_: &ModuleContext) {}

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(WorkspacePart::new(|_, _| Ok(create_expansion_memory())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_until_attached_then_mirrors_visible_rows_only() {
        let m = create_expansion_memory();
        assert_eq!(m.paths(), None);
        m.record([("a", true), ("a/b", true)]);
        // a collapsed: a/b is no longer visible, so it keeps its state.
        m.record([("a", false)]);
        assert_eq!(m.paths(), Some(vec!["a/b".to_string()]));
        assert!(m.is_expanded("a/b") && !m.is_expanded("a"));
    }
}
