//! Tab controllers (`modules/tabs/tab-controllers.ts`): the contract every
//! dock tab type implements, and the registry the app talks to instead of
//! one tab type's store. Each tab surface registers its controller when it
//! is live and unregisters when it goes away; an unregistered tab id simply
//! has no controller yet, so generic ops no-op.
//!
//! TS keeps the registry and the focus hand-offs at module scope and routes
//! focus through a DOM focus arbiter. Here both are state of the tabs
//! module (`core.tabs.controllers()`), and the arbiter is reduced to what
//! the dock needs: only the active tab takes ambient focus, a `WhenMounted`
//! intent waits for its tab's controller, and a hand-off lets one claim
//! steal focus.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, ready};
use notefig_editors::SearchTarget;

use crate::tab_id::TabKind;

/// `TabSearchOptions`.
#[derive(Clone, Copy, Debug, Default)]
pub struct TabSearchOptions {
    pub case_sensitive: bool,
}

/// The controls a live tab exposes (`TabController`).
pub trait TabController {
    fn tab_id(&self) -> &str;
    fn kind(&self) -> TabKind;
    /// Move keyboard focus into the tab. `steal` is an explicit hand-off.
    fn focus(&self, steal: bool) -> bool;
    fn is_focusable(&self) -> bool;
    fn selected_text(&self) -> Option<String>;
    /// Release resources; the tab left the layout.
    fn dispose(&self);
    /// Find-in-tab.
    fn search(&self, _query: &str, _options: TabSearchOptions) -> LocalBoxFuture<'static, Vec<SearchTarget>> {
        ready(Vec::new()).boxed_local()
    }
    fn reveal_match(&self, _target: SearchTarget) -> LocalBoxFuture<'static, bool> {
        ready(false).boxed_local()
    }
    /// Undo/redo; `false` when the tab has no history.
    fn history(&self, _redo: bool) -> bool {
        false
    }
}

/// When a focus request should land (`FocusTiming`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusTiming {
    Immediate,
    /// Keep the intent until the tab's surface is up.
    WhenMounted,
}

/// The registry, focus intents and hand-offs.
#[derive(Default)]
pub struct TabControllers {
    controllers: RefCell<HashMap<String, Rc<dyn TabController>>>,
    handoffs: RefCell<HashSet<String>>,
    active: RefCell<Option<String>>,
    /// A `WhenMounted` intent: (tab, steal).
    pending: RefCell<Option<(String, bool)>>,
}

impl TabControllers {
    pub fn register(&self, controller: Rc<dyn TabController>) {
        let id = controller.tab_id().to_string();
        self.controllers.borrow_mut().insert(id.clone(), controller);
        let pending = self.pending.borrow().clone();
        if let Some((tab, steal)) = pending
            && tab == id
            && self.claim(&id, steal)
        {
            self.pending.borrow_mut().take();
        }
    }

    pub fn unregister(&self, tab_id: &str) {
        self.controllers.borrow_mut().remove(tab_id);
    }

    pub fn get(&self, tab_id: &str) -> Option<Rc<dyn TabController>> {
        self.controllers.borrow().get(tab_id).cloned()
    }

    pub fn has(&self, tab_id: &str) -> bool {
        self.controllers.borrow().contains_key(tab_id)
    }

    /// The next focus claim of `tab_id` may take focus from a text entry.
    pub fn grant_focus_handoff(&self, tab_id: &str) {
        self.handoffs.borrow_mut().insert(tab_id.to_string());
    }

    pub fn has_handoff(&self, tab_id: &str) -> bool {
        self.handoffs.borrow().contains(tab_id)
    }

    /// Only the active tab's intents are eligible.
    pub fn set_active_tab(&self, tab_id: Option<&str>) {
        *self.active.borrow_mut() = tab_id.map(str::to_string);
    }

    fn claim(&self, tab_id: &str, steal: bool) -> bool {
        let Some(c) = self.get(tab_id) else { return false };
        let steal = steal || self.has_handoff(tab_id);
        let landed = c.focus(steal);
        if landed {
            self.handoffs.borrow_mut().remove(tab_id);
        }
        landed
    }

    /// File a focus intent. `Immediate` focuses now if the tab is the
    /// active one (or no active tab is known); `WhenMounted` waits for the
    /// tab's controller.
    pub fn request_focus(&self, tab_id: &str, when: FocusTiming, steal: bool) -> bool {
        let active = self.active.borrow().clone();
        if active.as_deref().is_some_and(|a| a != tab_id) {
            *self.pending.borrow_mut() = Some((tab_id.to_string(), steal));
            return false;
        }
        if self.claim(tab_id, steal) {
            return true;
        }
        if when == FocusTiming::WhenMounted {
            *self.pending.borrow_mut() = Some((tab_id.to_string(), steal));
        }
        false
    }

    /// Focus a tab now and report whether focus landed.
    pub fn focus_tab(&self, tab_id: &str) -> bool {
        self.has(tab_id) && self.claim(tab_id, false)
    }

    pub fn is_focusable(&self, tab_id: &str) -> bool {
        self.get(tab_id).is_some_and(|c| c.is_focusable())
    }

    pub fn selected_text(&self, tab_id: &str) -> Option<String> {
        self.get(tab_id).and_then(|c| c.selected_text())
    }

    /// Tear a tab's surface down: unregister first, then dispose. Idempotent.
    pub fn dispose_tab(&self, tab_id: &str) {
        self.handoffs.borrow_mut().remove(tab_id);
        let c = self.controllers.borrow_mut().remove(tab_id);
        if let Some(c) = c {
            c.dispose();
        }
    }

    pub fn search(&self, tab_id: &str, query: &str, options: TabSearchOptions) -> LocalBoxFuture<'static, Vec<SearchTarget>> {
        match self.get(tab_id) {
            Some(c) => c.search(query, options),
            None => ready(Vec::new()).boxed_local(),
        }
    }

    pub fn reveal_match(&self, tab_id: &str, target: SearchTarget) -> LocalBoxFuture<'static, bool> {
        match self.get(tab_id) {
            Some(c) => c.reveal_match(target),
            None => ready(false).boxed_local(),
        }
    }

    /// `runTabHistoryAction`.
    pub fn run_history(&self, tab_id: &str, redo: bool) -> bool {
        self.get(tab_id).is_some_and(|c| c.history(redo))
    }
}
