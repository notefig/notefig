//! Open/close state for the "connect a machine" dialog — a port of
//! `pair-dialog-store.ts`. A workspace-level modal, not a route.
//!
//! Deviation: TS keeps this in module scope and captures a deep-link code
//! from `window.location.hash` at import. Here the store belongs to the
//! tunnel API (`core.tunnel.dialog()`), and a deep link (`notefig://pair#…`,
//! `…/pair#…`) is handed in through [`PairDialogStore::open_from_link`] by
//! whoever receives it.

use std::cell::{Cell, RefCell};

use notefig_core::{Listeners, Subscription};

use crate::connect_flow::pairing_code_from_hash;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PairDialogState {
    pub open: bool,
    pub prefill_code: Option<String>,
}

#[derive(Default)]
pub struct PairDialogStore {
    state: RefCell<PairDialogState>,
    listeners: Listeners<()>,
    deep_linked: Cell<bool>,
    pairing_requests: Listeners<()>,
}

impl PairDialogStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> PairDialogState {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.listeners.subscribe(move |_| listener())
    }

    pub fn open(&self, prefill_code: Option<String>) {
        *self.state.borrow_mut() = PairDialogState { open: true, prefill_code };
        self.listeners.emit();
    }

    pub fn close(&self) {
        *self.state.borrow_mut() = PairDialogState::default();
        self.listeners.emit();
    }

    /// Open pre-filled from a link carrying a pairing code in its fragment.
    /// False (and nothing opens) when the link has no valid code.
    pub fn open_from_link(&self, link: &str) -> bool {
        let hash = link.find('#').map(|i| &link[i..]).unwrap_or(link);
        let Some(code) = pairing_code_from_hash(hash) else {
            return false;
        };
        self.deep_linked.set(true);
        self.open(Some(code));
        true
    }

    /// `hadDeepLinkPairing`: the boot reconnect is skipped then, so it
    /// doesn't race the fresh code the dialog is connecting.
    pub fn had_deep_link_pairing(&self) -> bool {
        self.deep_linked.get()
    }

    /// `ensureAgentRuntime`'s snackbar: someone tried to start an agent
    /// without a worker. A view shows the notice with a "Connect a machine"
    /// action that calls [`Self::open`].
    pub fn request_pairing(&self) {
        self.pairing_requests.emit();
    }

    pub fn on_pairing_requested(&self, listener: impl Fn() + 'static) -> Subscription {
        self.pairing_requests.subscribe(move |_| listener())
    }
}
