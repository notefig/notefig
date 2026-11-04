//! The URL as the shell sees it: TS keeps the dock layout, the sidebar view
//! and the tree's sort order in the router's search params. The desktop app
//! has no router, so [`MemoryUrl`] is the app's URL (the `session` module
//! may persist its search); the shape is TS's `UrlState`, so `layout`,
//! `sidebar-view` and anything else that reads a param port line for line.

use std::cell::RefCell;
use std::rc::Rc;

use notefig_core::{Listeners, Service, Subscription};

/// `UrlState` (`modules/layout/layout.ts`).
pub trait UrlState {
    /// The route's path; the app's own surface is "/".
    fn pathname(&self) -> String;
    /// `?a=1&b=2`, or "" with no params.
    fn search(&self) -> String;
    /// Must update `search()` synchronously.
    fn set_search(&self, search: &str, replace: bool);
    /// Called after every location change.
    fn subscribe(&self, listener: Box<dyn Fn()>) -> Subscription;
}

/// The `url` service (`urlModule` in `core/services.ts`).
pub struct UrlService;

impl Service for UrlService {
    const NAME: &'static str = "url";
    type Value = dyn UrlState;
}

/// `memoryUrlState`: a URL held in memory. The desktop app's URL, and
/// tests'.
#[derive(Clone, Default)]
pub struct MemoryUrl {
    search: Rc<RefCell<String>>,
    /// Pushed entries, newest last (`replace` overwrites the last).
    history: Rc<RefCell<Vec<String>>>,
    listeners: Listeners<()>,
}

impl MemoryUrl {
    pub fn new(initial_search: &str) -> Rc<Self> {
        Rc::new(Self {
            search: Rc::new(RefCell::new(initial_search.to_string())),
            history: Rc::new(RefCell::new(vec![initial_search.to_string()])),
            listeners: Listeners::new(),
        })
    }

    /// How many entries have been pushed (tests).
    pub fn history_len(&self) -> usize {
        self.history.borrow().len()
    }
}

impl UrlState for MemoryUrl {
    fn pathname(&self) -> String {
        "/".into()
    }

    fn search(&self) -> String {
        self.search.borrow().clone()
    }

    fn set_search(&self, search: &str, replace: bool) {
        *self.search.borrow_mut() = search.to_string();
        let mut history = self.history.borrow_mut();
        if replace {
            history.pop();
        }
        history.push(search.to_string());
        drop(history);
        self.listeners.emit();
    }

    fn subscribe(&self, listener: Box<dyn Fn()>) -> Subscription {
        self.listeners.subscribe(move |_| listener())
    }
}

/// `URLSearchParams`: ordered, form-encoded.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchParams(Vec<(String, String)>);

impl SearchParams {
    /// Parse `?a=1&b=2` (the leading `?` is optional).
    pub fn parse(search: &str) -> Self {
        let s = search.strip_prefix('?').unwrap_or(search);
        Self(form_urlencoded::parse(s.as_bytes()).into_owned().collect())
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// Replace every `key` with one entry, where the first one was.
    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        let value = value.into();
        match self.0.iter().position(|(k, _)| k == key) {
            Some(i) => {
                self.0[i].1 = value;
                let mut seen = false;
                self.0.retain(|(k, _)| {
                    if k != key {
                        return true;
                    }
                    let keep = !seen;
                    seen = true;
                    keep
                });
            }
            None => self.0.push((key.to_string(), value)),
        }
    }

    pub fn delete(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `a=1&b=2`, without the `?`.
    pub fn to_query(&self) -> String {
        let mut s = form_urlencoded::Serializer::new(String::new());
        for (k, v) in &self.0 {
            s.append_pair(k, v);
        }
        s.finish()
    }

    /// `?a=1&b=2`, or "" with no params: what `set_search` takes.
    pub fn to_search(&self) -> String {
        if self.0.is_empty() { String::new() } else { format!("?{}", self.to_query()) }
    }
}
