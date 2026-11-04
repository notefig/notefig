//! `createPromptRounds`: the stored rounds and the listener that keeps them.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agent::model::{AgentEntry, AgentTurn};
use notefig_agents::agent_events::{
    AgentTurnRequeued, AgentTurnRequeuedEvent, AgentTurnSettled, AgentTurnSettledEvent,
};
use notefig_core::{Executor, ExecutorExt, Hooks, Subscription};
use notefig_files::paths::workspace_key;
use notefig_kv::PersistedCollection;
use notefig_platform::Db;
use notefig_prompt_widgets::{
    RecordStatus, ReviewRangeStore, RoundStart, SavedReviewRanges, StoredRound, StoredRoundObservation, StoredRounds,
    WidgetRoundStarted, derive_round_outcome, PromptChange,
};

use crate::*;

/// What `createPromptRounds` is handed.
pub struct PromptRoundsDeps {
    pub db: Rc<dyn Db>,
    /// The agent store's turn rows (`turns.get`).
    pub turn: Rc<dyn Fn(&str) -> Option<AgentTurn>>,
    /// A turn's entries (task id, turn id), read when it settles.
    pub transcript: Rc<dyn Fn(&str, &str) -> Vec<AgentEntry>>,
    /// Where round starts and settled turns are announced.
    pub hooks: Hooks,
    pub executor: Rc<dyn Executor>,
}

struct Inner {
    rounds: PersistedCollection<PromptRoundRow>,
    turn: Rc<dyn Fn(&str) -> Option<AgentTurn>>,
    transcript: Rc<dyn Fn(&str, &str) -> Vec<AgentEntry>>,
    hooks: Hooks,
    executor: Rc<dyn Executor>,
}

/// `PromptRoundsApi` — `core.promptRounds`.
#[derive(Clone)]
pub struct PromptRoundsApi {
    inner: Rc<Inner>,
}

/// `createPromptRounds(deps)`.
pub fn create_prompt_rounds(deps: PromptRoundsDeps) -> PromptRoundsApi {
    PromptRoundsApi {
        inner: Rc::new(Inner {
            rounds: PersistedCollection::new(PROMPT_ROUNDS_COLLECTION_ID, deps.db),
            turn: deps.turn,
            transcript: deps.transcript,
            hooks: deps.hooks,
            executor: deps.executor,
        }),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn first_line(text: &str) -> String {
    text.trim().split('\n').next().unwrap_or("").to_string()
}

type Done = LocalBoxFuture<'static, anyhow::Result<()>>;

impl PromptRoundsApi {
    /// The stored rows (`collection`).
    pub fn collection(&self) -> &PersistedCollection<PromptRoundRow> {
        &self.inner.rounds
    }

    /// One round by its turn id (the round's key), if stored: what `seen`
    /// reads to tell a widget round from a chat turn.
    pub fn round(&self, turn_id: &str) -> Option<PromptRoundRow> {
        self.inner.rounds.get(turn_id)
    }

    /// Every stored round.
    pub fn rounds(&self) -> Vec<PromptRoundRow> {
        self.inner.rounds.values()
    }

    /// Called when the stored rounds change.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> notefig_core::Subscription {
        self.inner.rounds.subscribe(listener)
    }

    /// Keep storage bounded.
    fn prune(&self, now: i64) -> Done {
        let doomed = rounds_to_evict(&self.inner.rounds.values(), now);
        if doomed.is_empty() {
            return futures::future::ready(Ok(())).boxed_local();
        }
        self.inner.rounds.delete(doomed)
    }

    /// The listener's start half. `now` defaults to the clock.
    pub fn record_started(&self, detail: RoundStart, now: Option<i64>) -> Done {
        let this = self.clone();
        let now = now.unwrap_or_else(now_ms);
        async move {
            let rounds = &this.inner.rounds;
            rounds.preload().await;
            if rounds.has(&detail.turn_id) {
                return Ok(());
            }
            let row = PromptRoundRow {
                turn_id: detail.turn_id.clone(),
                task_id: detail.task_id.clone(),
                workspace_key: workspace_key(&detail.workspace_path),
                document_path: detail.document_path.clone(),
                prompt: first_line(&detail.prompt),
                status: RecordStatus::Live,
                started_at: now,
                settled_at: None,
                blob_id: Some(detail.blob_id.clone()),
                workspace_path: Some(detail.workspace_path.clone()),
                typed_prompt: Some(detail.typed_prompt.clone()),
                outcome: None,
                changes: None,
            };
            rounds.upsert(&row.turn_id, row.clone()).await?;
            // A turn can end before its start is announced (a dead session
            // settles it inside the send): the turn row says how it ended.
            if let Some(turn) = (this.inner.turn)(&detail.turn_id)
                && turn.status.is_ended()
            {
                this.record_settled(AgentTurnSettledEvent {
                    task_id: detail.task_id.clone(),
                    turn_id: detail.turn_id.clone(),
                    status: turn.status,
                    at: now,
                })
                .await?;
            }
            this.prune(now).await
        }
        .boxed_local()
    }

    /// The listener's settle half: only rounds known to be widget rounds.
    pub fn record_settled(&self, detail: AgentTurnSettledEvent) -> Done {
        let this = self.clone();
        async move {
            let rounds = &this.inner.rounds;
            rounds.preload().await;
            let Some(row) = rounds.get(&detail.turn_id) else { return Ok(()) };
            let Some(status) = RecordStatus::for_turn(detail.status) else { return Ok(()) };
            // Snapshotted now: the transcript is memory-only, and a revival
            // replays it away.
            let outcome = derive_round_outcome(
                &(this.inner.transcript)(&detail.task_id, &detail.turn_id),
                (this.inner.turn)(&detail.turn_id).and_then(|t| t.error),
                row.workspace_path.as_deref().unwrap_or(""),
            );
            rounds
                .update(&detail.turn_id, |draft| {
                    draft.status = status;
                    draft.settled_at = Some(detail.at);
                    draft.outcome = Some(outcome);
                })
                .await
        }
        .boxed_local()
    }

    /// The round's turn runs again: back to live, its old outcome gone.
    pub fn record_requeued(&self, detail: AgentTurnRequeuedEvent) -> Done {
        let this = self.clone();
        async move {
            let rounds = &this.inner.rounds;
            rounds.preload().await;
            match rounds.get(&detail.turn_id) {
                Some(row) if row.status != RecordStatus::Live => {}
                _ => return Ok(()),
            }
            rounds
                .update(&detail.turn_id, |draft| {
                    draft.status = RecordStatus::Live;
                    draft.settled_at = None;
                    draft.outcome = None;
                })
                .await
        }
        .boxed_local()
    }

    /// A round still `live` from a previous run never finished: settle it.
    pub fn settle_orphaned(&self) -> Done {
        let this = self.clone();
        async move {
            let rounds = &this.inner.rounds;
            rounds.preload().await;
            this.prune(now_ms()).await?;
            let orphaned: Vec<String> = rounds
                .values()
                .into_iter()
                .filter(|row| row.status == RecordStatus::Live && (this.inner.turn)(&row.turn_id).is_none())
                .map(|row| row.turn_id)
                .collect();
            let now = now_ms();
            for id in orphaned {
                rounds
                    .update(&id, |draft| {
                        draft.status = RecordStatus::Cancelled;
                        draft.settled_at = Some(now);
                    })
                    .await?;
            }
            Ok(())
        }
        .boxed_local()
    }

    /// Boot: settle the orphans, then the one global listener.
    pub fn track(&self) -> Subscription {
        let orphans = self.settle_orphaned();
        self.inner.executor.spawn_local(async move {
            if let Err(err) = orphans.await {
                log::error!("Failed to settle orphaned prompt rounds: {err:#}");
            }
        });
        let hooks = &self.inner.hooks;
        let (a, b, c) = (self.clone(), self.clone(), self.clone());
        Subscription::join(vec![
            hooks.on::<WidgetRoundStarted, _>(move |detail| a.record_started(detail.clone(), None)),
            hooks.on::<AgentTurnRequeued, _>(move |detail| b.record_requeued(detail.clone())),
            hooks.on::<AgentTurnSettled, _>(move |detail| c.record_settled(detail.clone())),
        ])
    }

    /// Watch a widget's newest round, as the widget reads it: the same `Rc`
    /// until that row changes.
    pub fn observe_newest(&self, blob_id: &str, on_change: Rc<dyn Fn()>) -> StoredRoundObservation {
        let rounds = self.inner.rounds.clone();
        let blob = blob_id.to_string();
        let rows_of = {
            let (rounds, blob) = (rounds.clone(), blob.clone());
            move || -> Vec<PromptRoundRow> {
                rounds.values().into_iter().filter(|r| r.blob_id.as_deref() == Some(blob.as_str())).collect()
            }
        };
        // What the widget's rows were when last read: a change elsewhere is
        // not this widget's.
        let seen: Rc<RefCell<Vec<PromptRoundRow>>> = Rc::new(RefCell::new(rows_of()));
        let last: Rc<RefCell<Option<(PromptRoundRow, Rc<StoredRound>)>>> = Rc::default();
        let (seen2, rows2) = (seen.clone(), rows_of.clone());
        let subscription = rounds.subscribe(move || {
            let now = rows2();
            if *seen2.borrow() == now {
                return;
            }
            *seen2.borrow_mut() = now;
            on_change();
        });
        StoredRoundObservation::new(
            move || {
                let newest = rows_of().into_iter().fold(None::<PromptRoundRow>, |best, row| match best {
                    Some(b) if row.started_at <= b.started_at => Some(b),
                    _ => Some(row),
                })?;
                let mut last = last.borrow_mut();
                if let Some((row, round)) = last.as_ref()
                    && *row == newest
                {
                    return Some(round.clone());
                }
                let round = Rc::new(stored_round(&newest));
                *last = Some((newest, round.clone()));
                Some(round)
            },
            subscription,
        )
    }

    /// Where the prompt widgets keep each document's review ranges: on the
    /// rounds that made them.
    pub fn review_ranges(&self) -> Rc<dyn ReviewRangeStore> {
        Rc::new(RoundsReviewRanges { api: self.clone() })
    }
}

impl StoredRounds for PromptRoundsApi {
    fn observe_newest(&self, blob_id: &str, on_change: Rc<dyn Fn()>) -> StoredRoundObservation {
        PromptRoundsApi::observe_newest(self, blob_id, on_change)
    }
    fn review_ranges(&self) -> Rc<dyn ReviewRangeStore> {
        PromptRoundsApi::review_ranges(self)
    }
}

/// A row as the widget reads it.
fn stored_round(row: &PromptRoundRow) -> StoredRound {
    StoredRound {
        turn_id: row.turn_id.clone(),
        task_id: row.task_id.clone(),
        status: row.status,
        prompt: row.typed_prompt.clone().unwrap_or_else(|| row.prompt.clone()),
        outcome: row.outcome.clone(),
    }
}

struct RoundsReviewRanges {
    api: PromptRoundsApi,
}

impl RoundsReviewRanges {
    /// Run the writes; a failure is logged, as TS does.
    fn persist(&self, writes: Vec<Done>, what: &'static str) {
        self.api.inner.executor.spawn_local(async move {
            for write in writes {
                if let Err(err) = write.await {
                    log::error!("Failed to {what}: {err:#}");
                }
            }
        });
    }
}

impl ReviewRangeStore for RoundsReviewRanges {
    fn load_all(&self) -> LocalBoxFuture<'static, anyhow::Result<BTreeMap<String, SavedReviewRanges>>> {
        let rounds = self.api.inner.rounds.clone();
        async move {
            rounds.preload().await;
            let mut by_document: BTreeMap<String, SavedReviewRanges> = BTreeMap::new();
            for row in rounds.values() {
                for changes in row.changes.iter().flatten() {
                    let saved = by_document.entry(changes.document_path.clone()).or_insert_with(|| SavedReviewRanges {
                        fingerprint: changes.fingerprint.clone(),
                        changes: vec![],
                    });
                    for range in &changes.ranges {
                        saved.changes.push(PromptChange {
                            blob_id: row.blob_id.clone().unwrap_or_default(),
                            turn_id: row.turn_id.clone(),
                            from: range.from,
                            to: range.to,
                        });
                    }
                }
            }
            Ok(by_document)
        }
        .boxed_local()
    }

    fn save(&self, document_path: &str, saved: SavedReviewRanges) {
        let mut by_turn: HashMap<String, Vec<ChangeRange>> = HashMap::new();
        for change in &saved.changes {
            by_turn.entry(change.turn_id.clone()).or_default().push(ChangeRange { from: change.from, to: change.to });
        }
        let rounds = &self.api.inner.rounds;
        let touched: Vec<String> = rounds
            .values()
            .into_iter()
            .filter(|row| {
                by_turn.contains_key(&row.turn_id)
                    || row.changes.iter().flatten().any(|c| c.document_path == document_path)
            })
            .map(|row| row.turn_id)
            .collect();
        if touched.is_empty() {
            return;
        }
        let writes = touched
            .into_iter()
            .map(|turn_id| {
                let ranges = by_turn.get(&turn_id).cloned();
                let (doc, fingerprint) = (document_path.to_string(), saved.fingerprint.clone());
                rounds.update(&turn_id, move |draft| {
                    let mut kept: Vec<RoundChanges> =
                        draft.changes.take().unwrap_or_default().into_iter().filter(|c| c.document_path != doc).collect();
                    if let Some(ranges) = ranges {
                        kept.push(RoundChanges { document_path: doc, fingerprint, ranges });
                    }
                    draft.changes = Some(kept);
                })
            })
            .collect();
        self.persist(writes, "save review ranges");
    }

    fn forget(&self, blob_id: &str) {
        let rounds = &self.api.inner.rounds;
        let held: Vec<String> = rounds
            .values()
            .into_iter()
            .filter(|row| row.blob_id.as_deref() == Some(blob_id) && row.changes.as_ref().is_some_and(|c| !c.is_empty()))
            .map(|row| row.turn_id)
            .collect();
        if held.is_empty() {
            return;
        }
        let writes = held.iter().map(|id| rounds.update(id, |draft| draft.changes = Some(vec![]))).collect();
        self.persist(writes, "forget review ranges");
    }
}

