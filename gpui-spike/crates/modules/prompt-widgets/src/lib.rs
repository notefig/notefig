//! Every prompt widget's state, as a core module: a port of
//! `packages/desktop/src/modules/prompt-widgets/` — `core.promptWidgets` —
//! together with the non-view half of `@notefig/widgets` it builds on (the
//! state machine, the widgets service, the review store, the round outcome).
//!
//! | TS | here |
//! |---|---|
//! | `@notefig/widgets` `prompt/machine.ts` | [`machine`] |
//! | `prompt/widgets-service.ts` (`createPromptWidgets`, `roundStatus`) | [`service`] |
//! | `prompt/change-store.ts` | [`review`] |
//! | `prompt/state.ts` (`deriveRoundOutcome`, `readWidgetResponse`) | [`outcome`] |
//! | `@notefig/widgets/testing` | `testing` (feature `testing`) |
//! | `modules/prompt-widgets/prompt-widgets.ts` | this file |
//!
//! Deviation (Rust forces it): in TS `promptWidgetsModule` needs
//! `promptRounds`, and `promptRounds` reads the types this crate declares
//! (`widget:round-started`, `StoredRound`, `ReviewRangeStore`). Crates can't
//! cycle, so the edge is turned around: `notefig-prompt-rounds` depends on
//! this crate, needs [`PromptWidgetsModule`], and hands its stored rounds to
//! the service in its `boot` ([`PromptWidgetsModuleApi::attach_stored_rounds`]).
//! Until then (or with no prompt rounds module at all) a widget reads no
//! stored round and no saved review ranges, as `inertPromptWidgets` does.

pub mod machine;
pub mod outcome;
pub mod review;
pub mod service;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_agent::model::{AgentTaskRow, AgentTurn};
use notefig_agents::{AgentStore, AgentStoreModule};
use notefig_core::{Hook, Module, ModuleContext, ModuleRef, Subscription};

pub use machine::*;
pub use outcome::{RoundOutcome, derive_round_outcome, is_mutating_tool_call, read_widget_response};
pub use review::{
    NoSavedReviewRanges, PROMPT_CHANGE_META, PromptChange, PromptChangeAttribution, PromptReview, ReviewRangeStore,
    SavedReviewRanges, prompt_change_hue,
};
pub use service::*;

/// `"widget:round-started"`: a prompt widget sent a prompt; a round began in
/// a document.
pub struct WidgetRoundStarted;
impl Hook for WidgetRoundStarted {
    const NAME: &'static str = "widget:round-started";
    type Payload = RoundStart;
}

/// The agent rows a round observer reads: the store's, or a test's.
pub trait AgentRows {
    fn task(&self, task_id: &str) -> Option<AgentTaskRow>;
    fn turn(&self, turn_id: &str) -> Option<AgentTurn>;
    fn turns_for_task(&self, task_id: &str) -> Vec<AgentTurn>;
    fn has_pending_permission(&self, task_id: &str) -> bool;
    /// Rows of one task changed (its row, turns, permissions).
    fn subscribe_task(&self, task_id: &str, listener: Rc<dyn Fn()>) -> Subscription;
}

impl AgentRows for AgentStore {
    fn task(&self, task_id: &str) -> Option<AgentTaskRow> {
        AgentStore::task(self, task_id)
    }
    fn turn(&self, turn_id: &str) -> Option<AgentTurn> {
        AgentStore::turn(self, turn_id)
    }
    fn turns_for_task(&self, task_id: &str) -> Vec<AgentTurn> {
        self.turns(task_id)
    }
    fn has_pending_permission(&self, task_id: &str) -> bool {
        !self.pending_permissions(task_id).is_empty()
    }
    fn subscribe_task(&self, task_id: &str, listener: Rc<dyn Fn()>) -> Subscription {
        AgentStore::subscribe_task(self, task_id, move || listener())
    }
}

/// `roundObserverFor(store)`: one bound round's live rows, watched through
/// the bound task's rows only; the snapshot is kept until one changes.
pub fn round_observer_for(store: Rc<dyn AgentRows>) -> PromptRoundObserverFactory {
    Rc::new(move |turn_id: Option<String>, task_id: Option<String>, on_change: Rc<dyn Fn()>| {
        // A sentinel id keeps the subscription unconditional, matching nothing.
        let task_key = task_id.unwrap_or_else(|| " none".to_string());
        let snapshot: Rc<RefCell<Option<Rc<PromptRoundSnapshot>>>> = Rc::default();
        let cache = snapshot.clone();
        let subscription = store.subscribe_task(
            &task_key,
            Rc::new(move || {
                cache.borrow_mut().take();
                on_change();
            }),
        );
        let store = store.clone();
        PromptRoundObservation::new(
            move || {
                if let Some(s) = snapshot.borrow().clone() {
                    return s;
                }
                let read = Rc::new(PromptRoundSnapshot {
                    turn: turn_id.as_deref().and_then(|t| store.turn(t)),
                    task: store.task(&task_key),
                    task_turns: store.turns_for_task(&task_key),
                    has_pending_permission: store.has_pending_permission(&task_key),
                });
                *snapshot.borrow_mut() = Some(read.clone());
                read
            },
            subscription,
        )
    })
}

/// What the prompt rounds module hands the service: each widget's newest
/// recorded round, and where review ranges are kept.
pub trait StoredRounds {
    fn observe_newest(&self, blob_id: &str, on_change: Rc<dyn Fn()>) -> StoredRoundObservation;
    fn review_ranges(&self) -> Rc<dyn ReviewRangeStore>;
}

type RoundsCell = Rc<RefCell<Option<Rc<dyn StoredRounds>>>>;

/// The stored rounds once attached (see the crate doc).
struct Slot {
    rounds: RoundsCell,
    attached: RefCell<Option<futures::channel::oneshot::Sender<()>>>,
    ready: Shared<LocalBoxFuture<'static, ()>>,
}

impl Slot {
    fn current(&self) -> Option<Rc<dyn StoredRounds>> {
        self.rounds.borrow().clone()
    }
}

impl ReviewRangeStore for Slot {
    /// Waits for the rounds to attach; never resolves without them.
    fn load_all(&self) -> LocalBoxFuture<'static, anyhow::Result<BTreeMap<String, SavedReviewRanges>>> {
        let (ready, rounds) = (self.ready.clone(), self.rounds.clone());
        async move {
            ready.await;
            let attached = rounds.borrow().clone();
            match attached {
                Some(r) => r.review_ranges().load_all().await,
                None => Ok(BTreeMap::new()),
            }
        }
        .boxed_local()
    }
    fn save(&self, document_path: &str, saved: SavedReviewRanges) {
        if let Some(r) = self.current() {
            r.review_ranges().save(document_path, saved);
        }
    }
    fn forget(&self, blob_id: &str) {
        if let Some(r) = self.current() {
            r.review_ranges().forget(blob_id);
        }
    }
}

/// `core.promptWidgets`: the service (derefs to [`PromptWidgetsApi`]).
pub struct PromptWidgetsModuleApi {
    pub widgets: PromptWidgetsApi,
    slot: Rc<Slot>,
}

impl std::ops::Deref for PromptWidgetsModuleApi {
    type Target = PromptWidgetsApi;
    fn deref(&self) -> &PromptWidgetsApi {
        &self.widgets
    }
}

impl PromptWidgetsModuleApi {
    /// The prompt rounds module hands over its stored rounds (its `boot`).
    pub fn attach_stored_rounds(&self, rounds: Rc<dyn StoredRounds>) {
        *self.slot.rounds.borrow_mut() = Some(rounds);
        if let Some(tx) = self.slot.attached.borrow_mut().take() {
            let _ = tx.send(());
        }
    }
}

/// `promptWidgetsModule`.
pub struct PromptWidgetsModule;

impl Module for PromptWidgetsModule {
    const NAME: &'static str = "promptWidgets";
    type Api = PromptWidgetsModuleApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<AgentStoreModule>()]
    }

    fn register(ctx: &ModuleContext) -> PromptWidgetsModuleApi {
        let (tx, rx) = futures::channel::oneshot::channel::<()>();
        let slot = Rc::new(Slot {
            rounds: Rc::default(),
            attached: RefCell::new(Some(tx)),
            ready: rx.map(|_| ()).boxed_local().shared(),
        });
        let store: Rc<dyn AgentRows> = ctx.use_::<AgentStoreModule>();
        let hooks = ctx.hooks().clone();
        let stored = slot.clone();
        let widgets = create_prompt_widgets(PromptWidgetsDeps {
            observe_round: round_observer_for(store),
            observe_stored_round: Rc::new(move |blob_id: &str, on_change: Rc<dyn Fn()>| match stored.current() {
                Some(rounds) => rounds.observe_newest(blob_id, on_change),
                None => StoredRoundObservation::new(|| None, Subscription::none()),
            }),
            announce_round: Rc::new(move |round| hooks.emit::<WidgetRoundStarted>(round)),
            review_ranges: slot.clone(),
            executor: ctx.executor(),
        });
        PromptWidgetsModuleApi { widgets, slot }
    }
}
