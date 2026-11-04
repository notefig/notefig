//! The `layout` module: a port of `packages/desktop/src/modules/layout/`
//! plus the pure layout code it is the public face of
//! (`utils/layout-codec.ts`, `utils/dockable-layout.ts`,
//! `components/dockable/reducer.ts`).
//!
//! The URL (`?layout=<json>`) stays the single source of truth, as in TS:
//! [`LayoutApi`] is the only code that reads or writes that param, through
//! the `url` service ([`UrlService`], a [`UrlState`]). `core.tabs` is the
//! way the app changes tabs; this is the tree underneath.

mod node;
mod reducer;
mod url;

use std::cell::RefCell;
use std::rc::Rc;

pub use node::*;
pub use reducer::{DockAction, SplitDirection, reduce};
pub use url::{MemoryUrl, SearchParams, UrlService, UrlState};

use notefig_core::{Module, ModuleContext, ModuleRef, Subscription};

/// `LayoutUpdateOptions`.
#[derive(Default)]
pub struct LayoutUpdateOptions {
    /// Replace the history entry instead of pushing one.
    pub replace: bool,
    /// Change other search params in the same navigation (closing the
    /// settings modal as a file opens from it).
    pub params: Option<Box<dyn FnOnce(&mut SearchParams)>>,
}

/// `core.layout`.
pub struct LayoutApi {
    url: Rc<dyn UrlState>,
    /// Parse once per distinct param value, so `read()` hands back the same
    /// `Rc` until the layout changes.
    cache: RefCell<(Option<String>, Rc<Vec<LayoutNode>>)>,
}

/// The layout over a URL.
pub fn create_layout(url: Rc<dyn UrlState>) -> LayoutApi {
    LayoutApi {
        url,
        cache: RefCell::new((None, Rc::new(Vec::new()))),
    }
}

impl LayoutApi {
    /// The layout. The same `Rc` until it changes (`Rc::ptr_eq`).
    pub fn read(&self) -> Rc<Vec<LayoutNode>> {
        let params = SearchParams::parse(&self.url.search());
        let raw = params.get(LAYOUT_PARAM).map(str::to_string);
        let mut cache = self.cache.borrow_mut();
        if cache.0 != raw {
            let parsed = parse_layout(raw.as_deref());
            *cache = (raw, Rc::new(parsed));
        }
        cache.1.clone()
    }

    pub fn open_tab_ids(&self) -> Vec<String> {
        extract_tab_ids(&self.read())
    }

    /// The selected tab of the first window that has one.
    pub fn selected_tab_id(&self) -> Option<String> {
        find_layout_selected_tab(&self.read())
    }

    /// Write a new layout (pushes a history entry unless `replace`).
    pub fn update(&self, next: Vec<LayoutNode>, options: LayoutUpdateOptions) {
        let mut params = SearchParams::parse(&self.url.search());
        if next.is_empty() {
            params.delete(LAYOUT_PARAM);
        } else {
            params.set(LAYOUT_PARAM, serialize_layout(&next));
        }
        if let Some(f) = options.params {
            f(&mut params);
        }
        self.url.set_search(&params.to_search(), options.replace);
    }

    /// `update(current => next)`.
    pub fn update_with(&self, f: impl FnOnce(&[LayoutNode]) -> Vec<LayoutNode>, options: LayoutUpdateOptions) {
        let current = self.read();
        self.update(f(&current), options);
    }

    /// Called after every layout change (not on other params' changes).
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        let url = self.url.clone();
        let last = RefCell::new(self.read().as_ref().clone());
        self.url.subscribe(Box::new(move || {
            let raw = SearchParams::parse(&url.search()).get(LAYOUT_PARAM).map(str::to_string);
            let next = parse_layout(raw.as_deref());
            if next == *last.borrow() {
                return;
            }
            *last.borrow_mut() = next;
            listener();
        }))
    }

    /// The URL this layout lives in (other params share it).
    pub fn url(&self) -> &Rc<dyn UrlState> {
        &self.url
    }
}

/// `layoutModule`.
pub struct LayoutModule;

impl Module for LayoutModule {
    const NAME: &'static str = "layout";
    type Api = LayoutApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<UrlService>()]
    }

    fn register(ctx: &ModuleContext) -> LayoutApi {
        create_layout(ctx.service::<UrlService>())
    }
}

#[cfg(test)]
mod tests;
