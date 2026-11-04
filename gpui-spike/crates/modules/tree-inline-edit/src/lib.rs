//! The file tree's inline text entry (rename, and the name field "New
//! File" opens) ends when the user presses outside its tree: a port of
//! `modules/tree-inline-edit/`.
//!
//! The TS module installs one capture-phase `mousedown` listener for the
//! whole app and blurs the entry, so the press lands where it was aimed.
//! GPUI has no document; the equivalent is one app-wide slot naming the
//! entry that is open (only one can be) with its commit, which the tree's
//! `on_mouse_down_out` calls through [`TreeInlineEditApi::dismiss`]. One
//! slot for the whole app, as one listener was.

use std::cell::RefCell;
use std::rc::Rc;

use notefig_core::{Module, ModuleContext};

/// `core.use_::<TreeInlineEditModule>()`.
#[derive(Default)]
pub struct TreeInlineEditApi {
    open: RefCell<Option<(u64, Rc<dyn Fn()>)>>,
    next: RefCell<u64>,
}

impl TreeInlineEditApi {
    /// An entry opened; `commit` ends it. Returns its token.
    pub fn begin(&self, commit: impl Fn() + 'static) -> u64 {
        let mut next = self.next.borrow_mut();
        *next += 1;
        *self.open.borrow_mut() = Some((*next, Rc::new(commit)));
        *next
    }

    /// The entry with this token ended on its own.
    pub fn end(&self, token: u64) {
        let mut open = self.open.borrow_mut();
        if open.as_ref().is_some_and(|(t, _)| *t == token) {
            *open = None;
        }
    }

    pub fn is_open(&self) -> bool {
        self.open.borrow().is_some()
    }

    /// A press outside the tree: commit the open entry, as its blur would.
    pub fn dismiss(&self) {
        let open = self.open.borrow_mut().take();
        if let Some((_, commit)) = open {
            commit();
        }
    }
}

/// `treeInlineEditModule`.
pub struct TreeInlineEditModule;

impl Module for TreeInlineEditModule {
    const NAME: &'static str = "tree-inline-edit";
    type Api = TreeInlineEditApi;
    type Workspace = ();

    fn register(_: &ModuleContext) -> TreeInlineEditApi {
        TreeInlineEditApi::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn an_outside_press_commits_the_open_entry_once() {
        let api = TreeInlineEditApi::default();
        let n = Rc::new(Cell::new(0));
        let c = n.clone();
        let t = api.begin(move || c.set(c.get() + 1));
        api.dismiss();
        api.dismiss();
        assert_eq!(n.get(), 1);
        api.end(t);
        let c = n.clone();
        let t2 = api.begin(move || c.set(c.get() + 10));
        api.end(t);
        assert!(api.is_open());
        api.end(t2);
        api.dismiss();
        assert_eq!(n.get(), 1);
    }
}
