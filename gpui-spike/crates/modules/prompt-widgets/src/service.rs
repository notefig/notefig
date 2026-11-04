//! Every prompt widget's state, by `blob_id`: a port of `@notefig/widgets`
//! `prompt/widgets-service.ts` (`createPromptWidgets`).
//!
//! A widget is a document node plus a round with an agent. The node holds
//! the draft and the ids that go into the file; this service holds the rest:
//! the state machine, the session and turn the widget is bound to, the last
//! prompt it sent, and the document it was last mounted in. The agent's side
//! is observed, not told (`observe_round`); what a round left behind is the
//! app's record of it (`observe_stored_round`, the prompt rounds module).
//!
//! Deviation: snapshots are `Rc<PromptWidget>` — "the same object until the
//! widget changes" is `Rc::ptr_eq`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agent::model::{AgentTaskRow, AgentTurn, TurnStatus};
use notefig_core::{Executor, Listeners, Subscription};
use serde::{Deserialize, Serialize};

use crate::machine::{COMPOSING, RoundFacts, WidgetEvent, WidgetState, WorkingTurn, transition};
use crate::outcome::RoundOutcome;
use crate::review::{PromptReview, ReviewRangeStore};

/// One bound round's live rows.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PromptRoundSnapshot {
    pub turn: Option<AgentTurn>,
    pub task: Option<AgentTaskRow>,
    /// Every turn on the bound task, for the queue-position readout.
    pub task_turns: Vec<AgentTurn>,
    pub has_pending_permission: bool,
}

/// A watch on one round's rows; dropping it stops watching (`destroy`).
pub struct PromptRoundObservation {
    get: Box<dyn Fn() -> Rc<PromptRoundSnapshot>>,
    _subscription: Subscription,
}

impl PromptRoundObservation {
    pub fn new(get: impl Fn() -> Rc<PromptRoundSnapshot> + 'static, subscription: Subscription) -> Self {
        Self { get: Box::new(get), _subscription: subscription }
    }
    pub fn get(&self) -> Rc<PromptRoundSnapshot> {
        (self.get)()
    }
}

/// Watch one round's rows (`turn_id`, `task_id`); `on_change` fires on any
/// change to them.
pub type PromptRoundObserverFactory =
    Rc<dyn Fn(Option<String>, Option<String>, Rc<dyn Fn()>) -> PromptRoundObservation>;

/// How a recorded round stands: `live` until it ends, then how it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordStatus {
    Live,
    Completed,
    Cancelled,
    Error,
}

impl RecordStatus {
    /// The turn status an ended record means; `None` for `live`.
    pub fn as_turn(self) -> Option<TurnStatus> {
        match self {
            RecordStatus::Live => None,
            RecordStatus::Completed => Some(TurnStatus::Completed),
            RecordStatus::Cancelled => Some(TurnStatus::Cancelled),
            RecordStatus::Error => Some(TurnStatus::Error),
        }
    }

    /// The record an ended turn writes; `None` for a live one.
    pub fn for_turn(turn: TurnStatus) -> Option<RecordStatus> {
        match turn {
            TurnStatus::Completed => Some(RecordStatus::Completed),
            TurnStatus::Cancelled => Some(RecordStatus::Cancelled),
            TurnStatus::Error => Some(RecordStatus::Error),
            _ => None,
        }
    }
}

/// A widget's round as the app stored it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredRound {
    pub turn_id: String,
    pub task_id: String,
    pub status: RecordStatus,
    /// The prompt as the user typed it, directives and all.
    pub prompt: String,
    pub outcome: Option<RoundOutcome>,
}

/// A watch on a widget's newest stored round; dropping it stops watching.
pub struct StoredRoundObservation {
    get: Box<dyn Fn() -> Option<Rc<StoredRound>>>,
    _subscription: Subscription,
}

impl StoredRoundObservation {
    pub fn new(get: impl Fn() -> Option<Rc<StoredRound>> + 'static, subscription: Subscription) -> Self {
        Self { get: Box::new(get), _subscription: subscription }
    }
    /// Stable: the same `Rc` until the record changes.
    pub fn get(&self) -> Option<Rc<StoredRound>> {
        (self.get)()
    }
}

/// What a send's dispatch hands back.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchedRound {
    pub task_id: String,
    pub turn_id: String,
    pub workspace_path: String,
    /// Absolute path of the document the widget sent from.
    pub document_path: String,
    /// The prompt as it went out, directives taken out.
    pub sent_prompt: String,
}

/// A round a widget started: the `widget:round-started` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct RoundStart {
    pub task_id: String,
    pub turn_id: String,
    pub workspace_path: String,
    pub document_path: String,
    pub blob_id: String,
    /// The prompt as sent.
    pub prompt: String,
    /// The prompt as typed, directives and all.
    pub typed_prompt: String,
}

/// The agent commands a stop runs.
pub trait StopCommands {
    fn cancel_task(&self, task_id: &str);
    /// Withdraw a turn still queued behind others.
    fn remove_queued_prompt(&self, task_id: &str, turn_id: &str);
}

/// One widget's state.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptWidget {
    pub state: WidgetState,
    pub bound_task_id: Option<String>,
    pub bound_turn_id: Option<String>,
    pub last_sent_prompt: String,
    pub document_path: Option<String>,
    /// Ms since the epoch an edit last failed to delete it.
    pub removal_refused_at: Option<i64>,
    pub outcome: Option<RoundOutcome>,
    pub seen_turn_id: Option<String>,
    /// The composer's live text, as the minimap's dot titles it. Deviation:
    /// in TS the draft is document content (the widget node's
    /// `promptDraft` child) and `promptEntry` reads it there; the Rust
    /// draft lives in the widget view, which publishes it here.
    pub draft: String,
}

impl Default for PromptWidget {
    fn default() -> Self {
        Self {
            state: COMPOSING,
            bound_task_id: None,
            bound_turn_id: None,
            last_sent_prompt: String::new(),
            document_path: None,
            removal_refused_at: None,
            outcome: None,
            seen_turn_id: None,
            draft: String::new(),
        }
    }
}

/// A widget bound to a session, located in its document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptWidgetLocation {
    pub blob_id: String,
    pub document_path: String,
    pub bound_turn_id: Option<String>,
}

/// What `stop` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopResult {
    Withdrawn,
    Cancelled,
    None,
}

/// `PromptWidgetsDeps`.
pub struct PromptWidgetsDeps {
    pub observe_round: PromptRoundObserverFactory,
    /// Watch the newest round the app recorded for a widget.
    pub observe_stored_round: Rc<dyn Fn(&str, Rc<dyn Fn()>) -> StoredRoundObservation>,
    /// A widget started a round: the app records it.
    pub announce_round: Rc<dyn Fn(RoundStart)>,
    pub review_ranges: Rc<dyn ReviewRangeStore>,
    pub executor: Rc<dyn Executor>,
}

/// Where a recorded round stands (`roundStatus`): the record says whether
/// it ended, the turn row how a live one is going. See the TS doc.
pub fn round_status(record: Option<RecordStatus>, turn: Option<TurnStatus>, turn_gone: bool) -> Option<TurnStatus> {
    if let Some(record) = record
        && record != RecordStatus::Live
    {
        return match turn {
            Some(TurnStatus::Queued | TurnStatus::Running) => turn,
            _ => record.as_turn(),
        };
    }
    match turn {
        None => turn_gone.then_some(TurnStatus::Cancelled),
        Some(TurnStatus::Queued) => turn,
        Some(_) => Some(TurnStatus::Running),
    }
}

struct Watch {
    turn_id: Option<String>,
    task_id: Option<String>,
    observation: PromptRoundObservation,
    /// The bound turn's row has existed.
    seen_turn: Cell<bool>,
}

struct Inner {
    deps: PromptWidgetsDeps,
    widgets: RefCell<HashMap<String, Rc<PromptWidget>>>,
    /// Insertion order of `widgets` (TS `Map` order).
    order: RefCell<Vec<String>>,
    escape_claims: RefCell<HashMap<String, usize>>,
    listeners: Listeners<String>,
    watches: RefCell<HashMap<String, Rc<Watch>>>,
    stored_rounds: RefCell<HashMap<String, Rc<StoredRoundObservation>>>,
    pending_restore: RefCell<HashSet<String>>,
    review: PromptReview,
    empty: Rc<PromptWidget>,
}

/// `PromptWidgetsApi` — `core.promptWidgets`.
#[derive(Clone)]
pub struct PromptWidgetsApi {
    inner: Rc<Inner>,
}

/// `createPromptWidgets(deps)`.
pub fn create_prompt_widgets(deps: PromptWidgetsDeps) -> PromptWidgetsApi {
    let review = PromptReview::new(deps.review_ranges.clone(), &deps.executor);
    PromptWidgetsApi {
        inner: Rc::new(Inner {
            deps,
            widgets: RefCell::default(),
            order: RefCell::default(),
            escape_claims: RefCell::default(),
            listeners: Listeners::new(),
            watches: RefCell::default(),
            stored_rounds: RefCell::default(),
            pending_restore: RefCell::default(),
            review,
            empty: Rc::new(PromptWidget::default()),
        }),
    }
}

fn facts_of(snapshot: &PromptRoundSnapshot) -> RoundFacts {
    RoundFacts {
        turn: snapshot.turn.as_ref().map(|t| t.status),
        auth_required: snapshot.task.as_ref().is_some_and(|t| t.auth_required),
        pending_permission: snapshot.has_pending_permission,
        awaiting_reply: false,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Inner {
    fn get(&self, blob_id: &str) -> Rc<PromptWidget> {
        self.widgets.borrow().get(blob_id).cloned().unwrap_or_else(|| self.empty.clone())
    }

    fn record_of(&self, blob_id: &str) -> Option<Rc<StoredRound>> {
        let observation = self.stored_rounds.borrow().get(blob_id).cloned()?;
        let stored = observation.get()?;
        (Some(&stored.turn_id) == self.get(blob_id).bound_turn_id.as_ref()).then_some(stored)
    }

    fn emit(&self, blob_id: &str) {
        self.listeners.notify(&blob_id.to_string());
    }
}

fn write(this: &Rc<Inner>, blob_id: &str, patch: impl FnOnce(&mut PromptWidget)) {
    let previous = this.get(blob_id);
    let mut next = (*previous).clone();
    patch(&mut next);
    if next == *previous {
        return;
    }
    let turn_moved = next.bound_turn_id != previous.bound_turn_id;
    let rebind = turn_moved || next.bound_task_id != previous.bound_task_id;
    {
        let mut widgets = this.widgets.borrow_mut();
        if !widgets.contains_key(blob_id) {
            this.order.borrow_mut().push(blob_id.to_string());
        }
        widgets.insert(blob_id.to_string(), Rc::new(next));
    }
    // Review state belongs to the watched round: moving off it discards it.
    if previous.bound_turn_id.is_some() && turn_moved {
        this.review.discard(blob_id);
    }
    if rebind {
        rewatch(this, blob_id);
    }
    this.emit(blob_id);
}

fn fire(this: &Rc<Inner>, blob_id: &str, event: WidgetEvent) {
    let state = transition(this.get(blob_id).state, event);
    write(this, blob_id, |w| w.state = state);
}

/// Fold the watched round's rows and its record into the machine. Returns
/// whether the widget changed.
fn fold(this: &Rc<Inner>, blob_id: &str, watch: &Watch) -> bool {
    let widget = this.get(blob_id);
    let live = facts_of(&watch.observation.get());
    if live.turn.is_some() {
        watch.seen_turn.set(true);
    }
    let record = this.record_of(blob_id);
    let turn = round_status(record.as_ref().map(|r| r.status), live.turn, watch.seen_turn.get());
    // A bound turn whose row isn't written yet: nothing to fold.
    if widget.bound_turn_id.is_some() && turn.is_none() {
        return false;
    }
    let ended = record.as_ref().is_some_and(|r| r.status != RecordStatus::Live);
    let outcome = if ended { record.as_ref().and_then(|r| r.outcome.clone()) } else { None };
    let awaiting_reply = outcome.as_ref().and_then(|o| o.response.as_ref()).is_some_and(|r| r.awaits_reply());
    let state = transition(widget.state, WidgetEvent::RoundChanged(RoundFacts { turn, awaiting_reply, ..live }));
    write(this, blob_id, |w| {
        w.state = state;
        w.outcome = outcome;
    });
    !Rc::ptr_eq(&this.get(blob_id), &widget)
}

/// A change to the watched round's rows or its record. Subscribers hear it
/// when the widget changed, and while it is working (its queue place moves).
fn reconcile(this: &Rc<Inner>, blob_id: &str) {
    let Some(watch) = this.watches.borrow().get(blob_id).cloned() else { return };
    let changed = fold(this, blob_id, &watch);
    if !changed && matches!(this.get(blob_id).state, WidgetState::Working(_)) {
        this.emit(blob_id);
    }
}

/// Watch the rows of whatever the widget is bound to now.
fn rewatch(this: &Rc<Inner>, blob_id: &str) {
    let widget = this.get(blob_id);
    let (turn_id, task_id) = (widget.bound_turn_id.clone(), widget.bound_task_id.clone());
    if let Some(current) = this.watches.borrow().get(blob_id)
        && current.turn_id == turn_id
        && current.task_id == task_id
    {
        return;
    }
    let old = this.watches.borrow_mut().remove(blob_id);
    drop(old);
    if turn_id.is_none() && task_id.is_none() {
        return;
    }
    let weak: Weak<Inner> = Rc::downgrade(this);
    let blob = blob_id.to_string();
    let on_change: Rc<dyn Fn()> = Rc::new(move || {
        if let Some(inner) = weak.upgrade() {
            reconcile(&inner, &blob);
        }
    });
    let observation = (this.deps.observe_round)(turn_id.clone(), task_id.clone(), on_change);
    this.watches.borrow_mut().insert(
        blob_id.to_string(),
        Rc::new(Watch { turn_id, task_id, observation, seen_turn: Cell::new(false) }),
    );
}

fn watch_stored(this: &Rc<Inner>, blob_id: &str) {
    if this.stored_rounds.borrow().contains_key(blob_id) {
        return;
    }
    let weak: Weak<Inner> = Rc::downgrade(this);
    let blob = blob_id.to_string();
    let on_change: Rc<dyn Fn()> = Rc::new(move || {
        if let Some(inner) = weak.upgrade() {
            adopt_stored(&inner, &blob);
            reconcile(&inner, &blob);
        }
    });
    let observation = (this.deps.observe_stored_round)(blob_id, on_change);
    this.stored_rounds.borrow_mut().insert(blob_id.to_string(), Rc::new(observation));
}

/// A widget restored from its file marker binds its last recorded round when
/// that round was on the same session.
fn adopt_stored(this: &Rc<Inner>, blob_id: &str) {
    if !this.pending_restore.borrow().contains(blob_id) {
        return;
    }
    let Some(observation) = this.stored_rounds.borrow().get(blob_id).cloned() else { return };
    let Some(stored) = observation.get() else { return };
    this.pending_restore.borrow_mut().remove(blob_id);
    let widget = this.get(blob_id);
    if widget.bound_turn_id.is_some() || widget.bound_task_id.as_deref() != Some(stored.task_id.as_str()) {
        return;
    }
    // Ended before this run: nothing new to see.
    write(this, blob_id, |w| {
        w.bound_turn_id = Some(stored.turn_id.clone());
        w.last_sent_prompt = stored.prompt.clone();
        w.seen_turn_id = Some(stored.turn_id.clone());
    });
}

fn unbind(this: &Rc<Inner>, blob_id: &str) {
    this.pending_restore.borrow_mut().remove(blob_id);
    let state = transition(this.get(blob_id).state, WidgetEvent::Unbound);
    write(this, blob_id, |w| {
        w.state = state;
        w.bound_task_id = None;
        w.bound_turn_id = None;
        w.outcome = None;
    });
}

/// The bound turn's status as its row says, else as the machine last saw it.
fn turn_status(this: &Rc<Inner>, blob_id: &str) -> Option<TurnStatus> {
    let watch = this.watches.borrow().get(blob_id).cloned();
    if let Some(turn) = watch.and_then(|w| w.observation.get().turn.clone()) {
        return Some(turn.status);
    }
    match this.get(blob_id).state {
        WidgetState::Working(WorkingTurn::Queued) => Some(TurnStatus::Queued),
        WidgetState::Working(WorkingTurn::Running) => Some(TurnStatus::Running),
        _ => None,
    }
}

fn withdraw(this: &Rc<Inner>, blob_id: &str, commands: &dyn StopCommands) -> bool {
    let widget = this.get(blob_id);
    let (Some(task), Some(turn)) = (&widget.bound_task_id, &widget.bound_turn_id) else { return false };
    if turn_status(this, blob_id) != Some(TurnStatus::Queued) {
        return false;
    }
    commands.remove_queued_prompt(task, turn);
    unbind(this, blob_id);
    true
}

fn stoppable(widget: &PromptWidget) -> bool {
    widget.bound_turn_id.is_some()
        && matches!(widget.state, WidgetState::Working(_) | WidgetState::Asking(crate::machine::Ask::Permission))
}

impl PromptWidgetsApi {
    /// Stable snapshot: the same `Rc` until the widget changes.
    pub fn get(&self, blob_id: &str) -> Rc<PromptWidget> {
        self.inner.get(blob_id)
    }

    pub fn subscribe(&self, blob_id: &str, listener: impl Fn() + 'static) -> Subscription {
        let id = blob_id.to_string();
        self.inner.listeners.subscribe(move |changed| {
            if *changed == id {
                listener()
            }
        })
    }

    /// Any widget changed (the minimap rail redraws its dots).
    pub fn subscribe_any(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.listeners.subscribe(move |_| listener())
    }

    /// The bound round's live rows, or `None` when nothing is bound.
    pub fn round(&self, blob_id: &str) -> Option<Rc<PromptRoundSnapshot>> {
        let watch = self.inner.watches.borrow().get(blob_id).cloned()?;
        Some(watch.observation.get())
    }

    /// What every widget's rounds changed in each document.
    pub fn review(&self) -> &PromptReview {
        &self.inner.review
    }

    /// Record where a widget is mounted. Silent when unchanged.
    pub fn set_document(&self, blob_id: &str, document_path: &str) {
        watch_stored(&self.inner, blob_id);
        write(&self.inner, blob_id, |w| w.document_path = Some(document_path.to_string()));
    }

    /// Seed the session a widget carried in its file marker. Never clobbers
    /// a live binding.
    pub fn restore(&self, blob_id: &str, task_id: &str) {
        if self.get(blob_id).bound_task_id.is_some() {
            return;
        }
        self.inner.pending_restore.borrow_mut().insert(blob_id.to_string());
        watch_stored(&self.inner, blob_id);
        write(&self.inner, blob_id, |w| w.bound_task_id = Some(task_id.to_string()));
        adopt_stored(&self.inner, blob_id);
        reconcile(&self.inner, blob_id);
    }

    /// Point the widget at a session without a round (the session picker).
    pub fn rebind(&self, blob_id: &str, task_id: &str) {
        self.inner.pending_restore.borrow_mut().remove(blob_id);
        let state = transition(self.get(blob_id).state, WidgetEvent::Unbound);
        write(&self.inner, blob_id, |w| {
            w.state = state;
            w.bound_task_id = Some(task_id.to_string());
            w.bound_turn_id = None;
            w.outcome = None;
        });
    }

    /// Stop watching any round and drop the session.
    pub fn unbind(&self, blob_id: &str) {
        unbind(&self.inner, blob_id);
    }

    pub fn refuse_removal(&self, blob_id: &str) {
        let now = now_ms();
        write(&self.inner, blob_id, |w| w.removal_refused_at = Some(now));
    }

    /// The composer's text changed (see [`PromptWidget::draft`]). Silent
    /// when unchanged.
    pub fn set_draft(&self, blob_id: &str, text: &str) {
        write(&self.inner, blob_id, |w| {
            if w.draft != text {
                w.draft = text.to_string();
            }
        });
    }

    /// The user has seen how the bound round ended.
    pub fn mark_seen(&self, blob_id: &str) {
        let turn = self.get(blob_id).bound_turn_id.clone();
        write(&self.inner, blob_id, |w| w.seen_turn_id = turn);
    }

    pub fn ask_trust(&self, blob_id: &str) {
        fire(&self.inner, blob_id, WidgetEvent::TrustAsked);
    }

    pub fn answer_trust(&self, blob_id: &str) {
        fire(&self.inner, blob_id, WidgetEvent::TrustAnswered);
    }

    /// Run one send. The widget is `sending` when this returns; the future
    /// resolves false when it couldn't send or the dispatch failed.
    pub fn send(
        &self,
        blob_id: &str,
        prompt: &str,
        dispatch: impl FnOnce() -> LocalBoxFuture<'static, Result<DispatchedRound, String>>,
    ) -> LocalBoxFuture<'static, bool> {
        let this = self.inner.clone();
        let before = this.get(blob_id).state;
        let sending = transition(before, WidgetEvent::SendStarted);
        if sending == before {
            return futures::future::ready(false).boxed_local();
        }
        this.pending_restore.borrow_mut().remove(blob_id);
        watch_stored(&this, blob_id);
        write(&this, blob_id, |w| w.state = sending);
        let dispatched = dispatch();
        let (blob, prompt) = (blob_id.to_string(), prompt.to_string());
        async move {
            match dispatched.await {
                Ok(round) => {
                    (this.deps.announce_round)(RoundStart {
                        task_id: round.task_id.clone(),
                        turn_id: round.turn_id.clone(),
                        workspace_path: round.workspace_path.clone(),
                        document_path: round.document_path.clone(),
                        blob_id: blob.clone(),
                        prompt: round.sent_prompt.clone(),
                        typed_prompt: prompt.clone(),
                    });
                    write(&this, &blob, |w| {
                        w.bound_task_id = Some(round.task_id.clone());
                        w.bound_turn_id = Some(round.turn_id.clone());
                        w.last_sent_prompt = prompt.clone();
                        w.outcome = None;
                    });
                    // The turn row may not be written yet: until it is, queued.
                    let watch = this.watches.borrow().get(&blob).cloned();
                    let facts = watch.map(|w| facts_of(&w.observation.get())).unwrap_or_default();
                    let turn = match facts.turn {
                        Some(_) => round_status(this.record_of(&blob).map(|r| r.status), facts.turn, true),
                        None => Some(TurnStatus::Queued),
                    };
                    fire(&this, &blob, WidgetEvent::Dispatched(RoundFacts { turn, ..facts }));
                    reconcile(&this, &blob);
                    true
                }
                Err(err) => {
                    log::error!("Prompt widget send failed: {err}");
                    fire(&this, &blob, WidgetEvent::SendFailed);
                    false
                }
            }
        }
        .boxed_local()
    }

    /// Withdraw the bound turn if it is still queued; the widget unbinds.
    pub fn withdraw(&self, blob_id: &str, commands: &dyn StopCommands) -> bool {
        withdraw(&self.inner, blob_id, commands)
    }

    /// Stop the bound round: a queued turn withdrawn, a live one cancelled.
    pub fn stop(&self, blob_id: &str, commands: &dyn StopCommands) -> StopResult {
        let widget = self.get(blob_id);
        let (Some(task), Some(_)) = (&widget.bound_task_id, &widget.bound_turn_id) else {
            return StopResult::None;
        };
        if withdraw(&self.inner, blob_id, commands) {
            return StopResult::Withdrawn;
        }
        commands.cancel_task(task);
        StopResult::Cancelled
    }

    /// The widget to reveal for a task. Naming a turn makes it an exact
    /// question; without one any bound, mounted widget answers.
    pub fn find_by_task(&self, task_id: &str, prefer_turn_id: Option<&str>) -> Option<PromptWidgetLocation> {
        let mut fallback = None;
        for blob_id in self.inner.order.borrow().iter() {
            let widget = self.get(blob_id);
            let Some(document_path) = &widget.document_path else { continue };
            if widget.bound_task_id.as_deref() != Some(task_id) {
                continue;
            }
            let location = PromptWidgetLocation {
                blob_id: blob_id.clone(),
                document_path: document_path.clone(),
                bound_turn_id: widget.bound_turn_id.clone(),
            };
            if prefer_turn_id.is_some() && widget.bound_turn_id.as_deref() == prefer_turn_id {
                return Some(location);
            }
            fallback.get_or_insert(location);
        }
        if prefer_turn_id.is_some() { None } else { fallback }
    }

    /// A mounted widget takes part in Escape; dropping the subscription
    /// releases it.
    pub fn claim_escape(&self, blob_id: &str) -> Subscription {
        *self.inner.escape_claims.borrow_mut().entry(blob_id.to_string()).or_default() += 1;
        let weak = Rc::downgrade(&self.inner);
        let blob = blob_id.to_string();
        Subscription::new(move || {
            let Some(inner) = weak.upgrade() else { return };
            let mut claims = inner.escape_claims.borrow_mut();
            let count = claims.get(&blob).copied().unwrap_or(1) - 1;
            if count > 0 {
                claims.insert(blob, count);
            } else {
                claims.remove(&blob);
            }
        })
    }

    /// True when this widget holds the newest turn Escape can stop among the
    /// mounted widgets.
    pub fn is_newest_stoppable(&self, blob_id: &str) -> bool {
        let mine = self.get(blob_id);
        let claimed: Vec<String> = self.inner.escape_claims.borrow().keys().cloned().collect();
        if !claimed.iter().any(|b| b == blob_id) || !stoppable(&mine) {
            return false;
        }
        for other_id in claimed {
            let other = self.get(&other_id);
            if Rc::ptr_eq(&other, &mine) || !stoppable(&other) {
                continue;
            }
            if other.bound_turn_id > mine.bound_turn_id {
                return false;
            }
        }
        true
    }

}
