//! A prompt service over in-memory agent rows: a port of
//! `@notefig/widgets/testing` (`testPrompts`, `testReviewRanges`). Publish a
//! turn, a sign-in hold or a pending permission, and every widget watching
//! it reconciles exactly as it would against the app's rows.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agent::model::{AgentTaskRow, AgentTurn, TaskStatus, TurnStatus};
use notefig_core::{Executor, Listeners};

use crate::review::{ReviewRangeStore, SavedReviewRanges};
use crate::service::*;

/// Review ranges saved in memory; `saved` is what a previous run left.
#[derive(Default)]
pub struct TestReviewRanges {
    pub saved: RefCell<BTreeMap<String, SavedReviewRanges>>,
}

impl TestReviewRanges {
    pub fn new(saved: Vec<(&str, SavedReviewRanges)>) -> Rc<Self> {
        Rc::new(Self { saved: RefCell::new(saved.into_iter().map(|(k, v)| (k.to_string(), v)).collect()) })
    }
}

impl ReviewRangeStore for TestReviewRanges {
    fn load_all(&self) -> LocalBoxFuture<'static, anyhow::Result<BTreeMap<String, SavedReviewRanges>>> {
        let all = self.saved.borrow().clone();
        async move { Ok(all) }.boxed_local()
    }
    fn save(&self, document_path: &str, saved: SavedReviewRanges) {
        self.saved.borrow_mut().insert(document_path.to_string(), saved);
    }
    fn forget(&self, blob_id: &str) {
        for ranges in self.saved.borrow_mut().values_mut() {
            ranges.changes.retain(|c| c.blob_id != blob_id);
        }
    }
}

/// Stop commands that record their calls.
#[derive(Default)]
pub struct RecordingCommands {
    pub cancelled: RefCell<Vec<String>>,
    pub removed: RefCell<Vec<(String, String)>>,
}

impl StopCommands for RecordingCommands {
    fn cancel_task(&self, task_id: &str) {
        self.cancelled.borrow_mut().push(task_id.to_string());
    }
    fn remove_queued_prompt(&self, task_id: &str, turn_id: &str) {
        self.removed.borrow_mut().push((task_id.to_string(), turn_id.to_string()));
    }
}

#[derive(Default)]
struct Rows {
    turns: RefCell<BTreeMap<String, AgentTurn>>,
    tasks: RefCell<HashMap<String, AgentTaskRow>>,
    pending: RefCell<HashSet<String>>,
    changed: Listeners<()>,
    stored: RefCell<HashMap<String, Rc<StoredRound>>>,
    stored_changed: Listeners<()>,
}

/// `testPrompts()`.
pub struct TestPrompts {
    pub prompts: PromptWidgetsApi,
    pub commands: RecordingCommands,
    rows: Rc<Rows>,
}

fn turn_row(turn_id: &str, task_id: &str, status: TurnStatus) -> AgentTurn {
    AgentTurn {
        turn_id: turn_id.into(),
        task_id: task_id.into(),
        session_id: String::new(),
        status,
        stop_reason: None,
        error: None,
        started_at: 0,
        usage: None,
    }
}

/// A bare task row with `auth_required`.
pub fn task_row(task_id: &str, auth_required: bool) -> AgentTaskRow {
    let mut row: AgentTaskRow = serde_json::from_value(serde_json::json!({
        "taskId": task_id, "workspacePath": "/ws", "title": "t", "status": "idle",
        "harnessId": "claude-code", "createdAt": 0, "updatedAt": 0,
    }))
    .expect("task row");
    row.status = TaskStatus::Idle;
    row.auth_required = auth_required;
    row
}

/// What a dispatch hands back for `round`, sent from `/ws/doc.md`.
pub fn dispatched(task_id: &str, turn_id: &str, prompt: &str) -> DispatchedRound {
    DispatchedRound {
        task_id: task_id.into(),
        turn_id: turn_id.into(),
        workspace_path: "/ws".into(),
        document_path: "/ws/doc.md".into(),
        sent_prompt: prompt.into(),
    }
}

impl TestPrompts {
    pub fn new(executor: Rc<dyn Executor>) -> Self {
        Self::with_review_ranges(executor, TestReviewRanges::new(vec![]))
    }

    pub fn with_review_ranges(executor: Rc<dyn Executor>, review_ranges: Rc<dyn ReviewRangeStore>) -> Self {
        let rows = Rc::new(Rows::default());
        let r = rows.clone();
        let observe_round: PromptRoundObserverFactory = Rc::new(move |turn_id, task_id, on_change| {
            let sub = r.changed.subscribe(move |_| on_change());
            let r = r.clone();
            PromptRoundObservation::new(
                move || {
                    Rc::new(PromptRoundSnapshot {
                        turn: turn_id.as_ref().and_then(|t| r.turns.borrow().get(t).cloned()),
                        task: task_id.as_ref().and_then(|t| r.tasks.borrow().get(t).cloned()),
                        task_turns: r
                            .turns
                            .borrow()
                            .values()
                            .filter(|t| Some(&t.task_id) == task_id.as_ref())
                            .cloned()
                            .collect(),
                        has_pending_permission: task_id.as_ref().is_some_and(|t| r.pending.borrow().contains(t)),
                    })
                },
                sub,
            )
        });
        let r = rows.clone();
        let observe_stored_round = Rc::new(move |blob_id: &str, on_change: Rc<dyn Fn()>| {
            let sub = r.stored_changed.subscribe(move |_| on_change());
            let (r, blob) = (r.clone(), blob_id.to_string());
            StoredRoundObservation::new(move || r.stored.borrow().get(&blob).cloned(), sub)
        });
        let r = rows.clone();
        let announce_round = Rc::new(move |round: RoundStart| {
            store_round(
                &r,
                &round.blob_id,
                StoredRound {
                    turn_id: round.turn_id,
                    task_id: round.task_id,
                    status: RecordStatus::Live,
                    prompt: round.typed_prompt,
                    outcome: None,
                },
            );
        });
        let prompts = create_prompt_widgets(PromptWidgetsDeps {
            observe_round,
            observe_stored_round,
            announce_round,
            review_ranges,
            executor,
        });
        Self { prompts, commands: RecordingCommands::default(), rows }
    }

    /// Write (or overwrite) a turn row. A turn that ends is recorded as
    /// ended too, unless `unrecorded`.
    pub fn set_turn_with(&self, turn_id: &str, task_id: &str, status: TurnStatus, unrecorded: bool) {
        self.rows.turns.borrow_mut().insert(turn_id.into(), turn_row(turn_id, task_id, status));
        self.rows.changed.emit();
        let Some(record) = RecordStatus::for_turn(status) else { return };
        if unrecorded {
            return;
        }
        let matching: Vec<(String, Rc<StoredRound>)> = self
            .rows
            .stored
            .borrow()
            .iter()
            .filter(|(_, r)| r.turn_id == turn_id)
            .map(|(b, r)| (b.clone(), r.clone()))
            .collect();
        for (blob, round) in matching {
            store_round(&self.rows, &blob, StoredRound { status: record, ..(*round).clone() });
        }
    }

    pub fn set_turn(&self, turn_id: &str, task_id: &str, status: TurnStatus) {
        self.set_turn_with(turn_id, task_id, status, false);
    }

    /// Store (or overwrite) a widget's newest round, as the app does.
    pub fn store_round(&self, blob_id: &str, round: StoredRound) {
        store_round(&self.rows, blob_id, round);
    }

    pub fn remove_turn(&self, turn_id: &str) {
        self.rows.turns.borrow_mut().remove(turn_id);
        self.rows.changed.emit();
    }

    pub fn set_auth_required(&self, task_id: &str, auth_required: bool) {
        self.rows.tasks.borrow_mut().insert(task_id.into(), task_row(task_id, auth_required));
        self.rows.changed.emit();
    }

    pub fn set_pending_permission(&self, task_id: &str, pending: bool) {
        if pending {
            self.rows.pending.borrow_mut().insert(task_id.into());
        } else {
            self.rows.pending.borrow_mut().remove(task_id);
        }
        self.rows.changed.emit();
    }

    /// Send `prompt` from `blob_id`, the dispatch writing a queued turn.
    pub fn send(&self, blob_id: &str, prompt: &str, task_id: &str, turn_id: &str) -> LocalBoxFuture<'static, bool> {
        let rows = self.rows.clone();
        let (task, turn, text) = (task_id.to_string(), turn_id.to_string(), prompt.to_string());
        self.prompts.send(blob_id, prompt, move || {
            async move {
                rows.turns.borrow_mut().insert(turn.clone(), turn_row(&turn, &task, TurnStatus::Queued));
                Ok(dispatched(&task, &turn, &text))
            }
            .boxed_local()
        })
    }
}

fn store_round(rows: &Rows, blob_id: &str, round: StoredRound) {
    rows.stored.borrow_mut().insert(blob_id.to_string(), Rc::new(round));
    rows.stored_changed.emit();
}
