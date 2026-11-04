//! `prompt-rounds.test.ts`, `prompt-rounds-interrupt.test.ts`, and
//! `modules/prompt-widgets/prompt-widgets.test.ts` (the widgets over the
//! agent rows and the stored rounds, which needs both crates).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::time::{Duration, Instant};

use notefig_agent::model::{AgentEntry, AgentTaskRow, AgentTurn, EntryType, TurnStatus};
use notefig_agents::agent_events::{AgentTurnRequeuedEvent, AgentTurnSettledEvent, AgentTurnSettled};
use notefig_core::testing::TestExecutor;
use notefig_core::{Executor, Hooks, Listeners, Subscription};
use notefig_platform::fake::FakePlatform;
use notefig_prompt_widgets::*;
use serde_json::json;

use crate::*;

fn hooks(exec: &Rc<TestExecutor>) -> Hooks {
    let executor: Rc<dyn Executor> = exec.clone();
    Hooks::new(executor, Rc::new(|err, name| panic!("{name}: {err:#}")))
}

fn started(turn: &str) -> RoundStart {
    RoundStart {
        task_id: "task_1".into(),
        turn_id: turn.into(),
        workspace_path: "/ws/a".into(),
        document_path: "/ws/a/doc.md".into(),
        prompt: "Do the thing\nsecond line".into(),
        blob_id: "blob_1".into(),
        typed_prompt: "Do the thing\nsecond line".into(),
    }
}

fn settled_event(turn: &str, status: TurnStatus, at: i64) -> AgentTurnSettledEvent {
    AgentTurnSettledEvent { task_id: "task_1".into(), turn_id: turn.into(), status, at }
}

fn turn_row(turn_id: &str, status: TurnStatus, error: Option<&str>) -> AgentTurn {
    AgentTurn {
        turn_id: turn_id.into(),
        task_id: "task_1".into(),
        session_id: "sess_1".into(),
        status,
        stop_reason: None,
        error: error.map(Into::into),
        started_at: 0,
        usage: None,
    }
}

fn entry(id: &str, turn: &str, kind: EntryType, text: Option<&str>, tool: Option<serde_json::Value>) -> AgentEntry {
    AgentEntry {
        id: id.into(),
        task_id: "task_1".into(),
        turn_id: turn.into(),
        kind,
        text: text.map(Into::into),
        tool_call_id: None,
        tool_call: tool,
        plan: None,
        raw: None,
        created_at: None,
    }
}

/// `prompt-rounds.test.ts`'s fixture: turn rows a test sets, transcripts.
struct Env {
    exec: Rc<TestExecutor>,
    hooks: Hooks,
    rounds: PromptRoundsApi,
    live_turns: Rc<RefCell<Vec<String>>>,
    ended_turns: Rc<RefCell<HashMap<String, (TurnStatus, Option<String>)>>>,
    transcripts: Rc<RefCell<HashMap<String, Vec<AgentEntry>>>>,
}

fn env() -> Env {
    let exec = TestExecutor::new();
    let hooks = hooks(&exec);
    let live_turns: Rc<RefCell<Vec<String>>> = Rc::default();
    let ended_turns: Rc<RefCell<HashMap<String, (TurnStatus, Option<String>)>>> = Rc::default();
    let transcripts: Rc<RefCell<HashMap<String, Vec<AgentEntry>>>> = Rc::default();
    let (live, ended, tr) = (live_turns.clone(), ended_turns.clone(), transcripts.clone());
    let rounds = create_prompt_rounds(PromptRoundsDeps {
        db: FakePlatform::new().platform.db.clone(),
        turn: Rc::new(move |id| {
            if let Some((status, error)) = ended.borrow().get(id) {
                return Some(turn_row(id, *status, error.as_deref()));
            }
            live.borrow().iter().any(|t| t == id).then(|| turn_row(id, TurnStatus::Running, None))
        }),
        transcript: Rc::new(move |_task, turn| tr.borrow().get(turn).cloned().unwrap_or_default()),
        hooks: hooks.clone(),
        executor: exec.clone(),
    });
    Env { exec, hooks, rounds, live_turns, ended_turns, transcripts }
}

impl Env {
    fn run(&self, f: futures::future::LocalBoxFuture<'static, anyhow::Result<()>>) {
        self.exec.block_on(f).unwrap();
    }
    fn row(&self, turn: &str) -> Option<PromptRoundRow> {
        self.rounds.collection().get(turn)
    }
    fn saved(&self, doc: &str) -> Option<SavedReviewRanges> {
        self.exec.block_on(self.rounds.review_ranges().load_all()).unwrap().get(doc).cloned()
    }
}

#[test]
fn records_a_started_round_first_line_of_the_prompt_and_settles_it() {
    let e = env();
    e.run(e.rounds.record_started(started("t1"), Some(10)));
    e.run(e.rounds.record_started(started("t1"), Some(11)));
    let row = e.row("t1").unwrap();
    assert_eq!((row.task_id.as_str(), row.document_path.as_str()), ("task_1", "/ws/a/doc.md"));
    assert_eq!(row.prompt, "Do the thing");
    assert_eq!(row.status, RecordStatus::Live);
    assert_eq!(row.started_at, 10);
    e.run(e.rounds.record_settled(settled_event("t1", TurnStatus::Error, 42)));
    e.run(e.rounds.record_settled(settled_event("t_unknown", TurnStatus::Completed, 43)));
    let row = e.row("t1").unwrap();
    assert_eq!((row.status, row.settled_at), (RecordStatus::Error, Some(42)));
    assert_eq!(e.rounds.collection().values().len(), 1);
}

#[test]
fn ends_a_round_whose_turn_ended_before_its_start_was_announced() {
    let e = env();
    e.ended_turns.borrow_mut().insert("t1".into(), (TurnStatus::Error, Some("agent task is not started".into())));
    e.run(e.rounds.record_settled(settled_event("t1", TurnStatus::Error, 9)));
    e.run(e.rounds.record_started(started("t1"), Some(10)));
    let row = e.row("t1").unwrap();
    assert_eq!((row.status, row.settled_at), (RecordStatus::Error, Some(10)));
    assert_eq!(row.outcome.unwrap().error.as_deref(), Some("agent task is not started"));
}

#[test]
fn reopens_a_round_whose_turn_runs_again_and_settles_it_anew() {
    let e = env();
    e.run(e.rounds.record_started(started("t1"), Some(10)));
    e.ended_turns.borrow_mut().insert("t1".into(), (TurnStatus::Error, Some("Authentication required".into())));
    e.run(e.rounds.record_settled(settled_event("t1", TurnStatus::Error, 11)));
    e.ended_turns.borrow_mut().remove("t1");
    e.run(e.rounds.record_requeued(AgentTurnRequeuedEvent { task_id: "task_1".into(), turn_id: "t1".into() }));
    let row = e.row("t1").unwrap();
    assert_eq!(row.status, RecordStatus::Live);
    assert_eq!(row.settled_at, None);
    assert_eq!(row.outcome, None);
    e.run(e.rounds.record_settled(settled_event("t1", TurnStatus::Completed, 12)));
    let row = e.row("t1").unwrap();
    assert_eq!((row.status, row.settled_at), (RecordStatus::Completed, Some(12)));
}

#[test]
fn keeps_the_prompt_as_typed_directives_and_all_beside_the_one_sent() {
    let e = env();
    let detail = RoundStart { prompt: "Review this".into(), typed_prompt: "@skill:review Review this".into(), ..started("t1") };
    e.run(e.rounds.record_started(detail, Some(10)));
    let row = e.row("t1").unwrap();
    assert_eq!(row.prompt, "Review this");
    assert_eq!(row.typed_prompt.as_deref(), Some("@skill:review Review this"));
}

#[test]
fn records_the_widget_and_the_whole_prompt_and_snapshots_the_outcome_when_it_settles() {
    let e = env();
    e.run(e.rounds.record_started(started("t1"), Some(10)));
    let row = e.row("t1").unwrap();
    assert_eq!(row.blob_id.as_deref(), Some("blob_1"));
    assert_eq!(row.workspace_path.as_deref(), Some("/ws/a"));
    assert_eq!(row.typed_prompt.as_deref(), Some("Do the thing\nsecond line"));
    e.transcripts.borrow_mut().insert(
        "t1".into(),
        vec![
            entry("evt_1", "t1", EntryType::Assistant, Some("Shortened it."), None),
            entry("evt_2", "t1", EntryType::ToolCall, None, Some(json!({"toolCallId": "tc", "kind": "edit", "status": "completed", "locations": [{"path": "/ws/a/doc.md"}]}))),
        ],
    );
    e.run(e.rounds.record_settled(settled_event("t1", TurnStatus::Completed, 42)));
    assert_eq!(
        e.row("t1").unwrap().outcome,
        Some(RoundOutcome {
            response: None,
            summary: Some("Shortened it.".into()),
            error: None,
            touched_files: vec!["/ws/a/doc.md".into()],
        })
    );
}

fn change(blob: &str, turn: &str, from: i64, to: i64) -> PromptChange {
    PromptChange { blob_id: blob.into(), turn_id: turn.into(), from, to }
}

#[test]
fn keeps_a_documents_review_ranges_on_the_rounds_that_made_them() {
    let e = env();
    e.run(e.rounds.record_started(started("t1"), Some(10)));
    e.run(e.rounds.record_started(RoundStart { blob_id: "blob_2".into(), ..started("t2") }, Some(11)));
    assert_eq!(e.saved("/ws/a/doc.md"), None);
    let changes = vec![change("blob_1", "t1", 1, 4), change("blob_2", "t2", 9, 12)];
    e.rounds.review_ranges().save("/ws/a/doc.md", SavedReviewRanges { fingerprint: "f1".into(), changes: changes.clone() });
    e.exec.run_until_parked();
    assert_eq!(e.saved("/ws/a/doc.md"), Some(SavedReviewRanges { fingerprint: "f1".into(), changes: changes.clone() }));
    e.rounds.review_ranges().save("/ws/a/doc.md", SavedReviewRanges { fingerprint: "f2".into(), changes: vec![changes[1].clone()] });
    e.exec.run_until_parked();
    assert_eq!(e.saved("/ws/a/doc.md"), Some(SavedReviewRanges { fingerprint: "f2".into(), changes: vec![changes[1].clone()] }));
    assert_eq!(e.row("t1").unwrap().changes, Some(vec![]));
}

#[test]
fn forgets_a_widgets_review_ranges_in_every_document() {
    let e = env();
    e.run(e.rounds.record_started(started("t1"), Some(10)));
    e.run(e.rounds.record_started(RoundStart { blob_id: "blob_2".into(), ..started("t2") }, Some(11)));
    e.rounds.review_ranges().save(
        "/ws/a/doc.md",
        SavedReviewRanges { fingerprint: "f".into(), changes: vec![change("blob_1", "t1", 1, 4), change("blob_2", "t2", 9, 12)] },
    );
    e.exec.run_until_parked();
    assert_eq!(e.saved("/ws/a/doc.md").unwrap().changes.len(), 2);
    e.rounds.review_ranges().forget("blob_1");
    e.exec.run_until_parked();
    assert_eq!(e.saved("/ws/a/doc.md").unwrap().changes, vec![change("blob_2", "t2", 9, 12)]);
}

#[test]
fn settles_rounds_left_live_by_a_previous_run_keeps_live_ones_with_a_turn_row() {
    let e = env();
    e.run(e.rounds.record_started(started("t_orphan"), Some(1)));
    e.run(e.rounds.record_started(started("t_kept"), Some(2)));
    e.live_turns.borrow_mut().push("t_kept".into());
    e.run(e.rounds.settle_orphaned());
    let orphan = e.row("t_orphan").unwrap();
    assert_eq!(orphan.status, RecordStatus::Cancelled);
    assert!(orphan.settled_at.unwrap() > 0);
    assert_eq!(e.row("t_kept").unwrap().status, RecordStatus::Live);
}

#[test]
fn prunes_storage_to_the_cap_oldest_first() {
    let e = env();
    for i in 0..MAX_PROMPT_ROUNDS + 2 {
        e.run(e.rounds.record_started(started(&format!("t{i}")), Some(i as i64)));
    }
    assert_eq!(e.rounds.collection().values().len(), MAX_PROMPT_ROUNDS);
    assert!(e.row("t0").is_none());
}

#[test]
fn derives_rounds_for_open_workspaces_live_first_then_newest() {
    let key = notefig_files::paths::workspace_key("/ws/a");
    let row = |turn: &str, status: RecordStatus, started_at: i64, ws: &str| PromptRoundRow {
        turn_id: turn.into(),
        task_id: "task_1".into(),
        workspace_key: ws.into(),
        document_path: "/ws/a/doc.md".into(),
        prompt: "p".into(),
        status,
        started_at,
        settled_at: None,
        blob_id: None,
        workspace_path: None,
        typed_prompt: None,
        outcome: None,
        changes: None,
    };
    let rows = vec![
        row("old", RecordStatus::Completed, 10, &key),
        row("new", RecordStatus::Completed, 20, &key),
        row("live", RecordStatus::Live, 5, &key),
        row("queued", RecordStatus::Live, 6, &key),
        row("gone", RecordStatus::Live, 7, &key),
        row("closed", RecordStatus::Completed, 99, "other"),
    ];
    let rounds = derive_prompt_rounds(
        &rows,
        &[(key.clone(), "/ws/a".into())],
        &[("queued".into(), TurnStatus::Queued), ("live".into(), TurnStatus::Running)],
    );
    let got: Vec<(&str, TurnStatus)> = rounds.iter().map(|r| (r.turn_id.as_str(), r.status)).collect();
    assert_eq!(
        got,
        vec![
            ("queued", TurnStatus::Queued),
            ("live", TurnStatus::Running),
            ("new", TurnStatus::Completed),
            ("old", TurnStatus::Completed),
            ("gone", TurnStatus::Cancelled),
        ]
    );
    assert_eq!(rounds[0].workspace_path, "/ws/a");
    assert!(is_live_round(rounds[0].status));
    assert!(!is_live_round(rounds[2].status));
    assert_eq!(describe_prompt_round(TurnStatus::Queued), Some("roundQueued"));
    assert_eq!(describe_prompt_round(TurnStatus::Completed), None);
}

#[test]
fn the_boot_listener_records_rounds_from_the_app_events() {
    let e = env();
    let stop = e.rounds.track();
    e.hooks.emit::<WidgetRoundStarted>(started("t9"));
    e.exec.run_until_parked();
    assert!(e.row("t9").is_some());
    e.hooks.emit::<AgentTurnSettled>(settled_event("t9", TurnStatus::Completed, 1));
    e.exec.run_until_parked();
    assert_eq!(e.row("t9").unwrap().status, RecordStatus::Completed);
    drop(stop);
}

// ── roundsToEvict ──

const DAY: i64 = 24 * 60 * 60 * 1000;
const NOW: i64 = 100 * DAY;

fn evict_row(turn: &str, started_at: i64) -> PromptRoundRow {
    PromptRoundRow {
        turn_id: turn.into(),
        task_id: "task_1".into(),
        workspace_key: "k".into(),
        document_path: "/d.md".into(),
        prompt: "p".into(),
        status: RecordStatus::Completed,
        started_at,
        settled_at: Some(started_at),
        blob_id: None,
        workspace_path: None,
        typed_prompt: None,
        outcome: None,
        changes: None,
    }
}

#[test]
fn drops_settled_rounds_past_the_retention_window_never_live_ones() {
    let rows = vec![
        evict_row("old", NOW - PROMPT_ROUND_RETENTION_MS - DAY),
        evict_row("recent", NOW - DAY),
        PromptRoundRow { status: RecordStatus::Live, settled_at: None, ..evict_row("live", NOW - 30 * DAY) },
    ];
    assert_eq!(rounds_to_evict(&rows, NOW), vec!["old".to_string()]);
}

#[test]
fn ages_a_settled_round_with_no_settle_time_from_when_it_started() {
    let rows = vec![PromptRoundRow {
        status: RecordStatus::Cancelled,
        settled_at: None,
        ..evict_row("legacy", NOW - PROMPT_ROUND_RETENTION_MS - DAY)
    }];
    assert_eq!(rounds_to_evict(&rows, NOW), vec!["legacy".to_string()]);
}

#[test]
fn caps_storage_oldest_first_but_keeps_each_widgets_newest_round() {
    let rows: Vec<PromptRoundRow> = (0..MAX_PROMPT_ROUNDS as i64 + 2)
        .map(|i| {
            let row = evict_row(&format!("t{i}"), NOW - DAY + i);
            if i == 0 { PromptRoundRow { blob_id: Some("blob_kept".into()), ..row } } else { row }
        })
        .collect();
    assert_eq!(rounds_to_evict(&rows, NOW), vec!["t1".to_string(), "t2".to_string()]);
}

// ── prompt-widgets.test.ts: the widgets over agent rows and stored rounds ──

#[derive(Default)]
struct FakeStore {
    tasks: RefCell<BTreeMap<String, AgentTaskRow>>,
    turns: RefCell<BTreeMap<String, AgentTurn>>,
    entries: RefCell<Vec<AgentEntry>>,
    /// permission id → (task, pending)
    permissions: RefCell<BTreeMap<String, (String, bool)>>,
    changed: Listeners<String>,
}

impl FakeStore {
    fn set_turn(&self, turn: AgentTurn) {
        let task = turn.task_id.clone();
        self.turns.borrow_mut().insert(turn.turn_id.clone(), turn);
        self.changed.notify(&task);
    }
    fn update_turn(&self, id: &str, status: TurnStatus) {
        let mut turn = self.turns.borrow()[id].clone();
        turn.status = status;
        self.set_turn(turn);
    }
    fn delete_turn(&self, id: &str) {
        let removed = self.turns.borrow_mut().remove(id);
        if let Some(t) = removed {
            self.changed.notify(&t.task_id);
        }
    }
    fn set_permission(&self, id: &str, task: &str, pending: bool) {
        self.permissions.borrow_mut().insert(id.into(), (task.into(), pending));
        self.changed.notify(&task.to_string());
    }
}

impl AgentRows for FakeStore {
    fn task(&self, task_id: &str) -> Option<AgentTaskRow> {
        self.tasks.borrow().get(task_id).cloned()
    }
    fn turn(&self, turn_id: &str) -> Option<AgentTurn> {
        self.turns.borrow().get(turn_id).cloned()
    }
    fn turns_for_task(&self, task_id: &str) -> Vec<AgentTurn> {
        self.turns.borrow().values().filter(|t| t.task_id == task_id).cloned().collect()
    }
    fn has_pending_permission(&self, task_id: &str) -> bool {
        self.permissions.borrow().values().any(|(t, pending)| t == task_id && *pending)
    }
    fn subscribe_task(&self, task_id: &str, listener: Rc<dyn Fn()>) -> Subscription {
        let id = task_id.to_string();
        self.changed.subscribe(move |t| {
            if *t == id {
                listener()
            }
        })
    }
}

/// The app's pieces as the modules wire them, over one database.
struct App {
    exec: Rc<TestExecutor>,
    db: Rc<dyn notefig_platform::Db>,
    store: Rc<FakeStore>,
    rounds: PromptRoundsApi,
    prompts: PromptWidgetsApi,
    _track: Subscription,
}

fn app(exec: Rc<TestExecutor>, db: Rc<dyn notefig_platform::Db>) -> App {
    let store = Rc::new(FakeStore::default());
    let hooks = hooks(&exec);
    let (s1, s2) = (store.clone(), store.clone());
    let rounds = create_prompt_rounds(PromptRoundsDeps {
        db: db.clone(),
        turn: Rc::new(move |id| s1.turn(id)),
        transcript: Rc::new(move |task, turn| {
            s2.entries.borrow().iter().filter(|e| e.task_id == task && e.turn_id == turn).cloned().collect()
        }),
        hooks: hooks.clone(),
        executor: exec.clone(),
    });
    let track = rounds.track();
    let (r, h) = (rounds.clone(), hooks.clone());
    let prompts = create_prompt_widgets(PromptWidgetsDeps {
        observe_round: round_observer_for(store.clone()),
        observe_stored_round: Rc::new(move |blob, on_change| r.observe_newest(blob, on_change)),
        announce_round: Rc::new(move |round| h.emit::<WidgetRoundStarted>(round)),
        review_ranges: rounds.review_ranges(),
        executor: exec.clone(),
    });
    exec.run_until_parked();
    App { exec, db, store, rounds, prompts, _track: track }
}

fn new_app() -> App {
    let exec = TestExecutor::new();
    app(exec, FakePlatform::new().platform.db.clone())
}

/// Send from "blob", the dispatch writing the queued turn row.
fn sent(a: &App) {
    let store = a.store.clone();
    let ok = a.exec.block_on(a.prompts.send("blob", "@skill:edit make it shorter", move || {
        Box::pin(async move {
            store.set_turn(turn_row("trn_1", TurnStatus::Queued, None));
            Ok(DispatchedRound {
                task_id: "task_1".into(),
                turn_id: "trn_1".into(),
                workspace_path: "/ws".into(),
                document_path: "/ws/doc.md".into(),
                sent_prompt: "make it shorter".into(),
            })
        })
    }));
    assert!(ok);
    a.exec.run_until_parked();
}

fn record_settled(a: &App) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    a.exec.block_on(a.rounds.record_settled(settled_event("trn_1", TurnStatus::Completed, now))).unwrap();
}

const DONE: WidgetState = WidgetState::Settled(SettledOutcome::Done);

#[test]
fn follows_the_bound_turn_through_its_statuses() {
    let a = new_app();
    sent(&a);
    assert_eq!(a.prompts.get("blob").state, WidgetState::Working(WorkingTurn::Queued));
    a.store.update_turn("trn_1", TurnStatus::Running);
    assert_eq!(a.prompts.get("blob").state, WidgetState::Working(WorkingTurn::Running));
    a.store.set_permission("perm_1", "task_1", true);
    assert_eq!(a.prompts.get("blob").state, WidgetState::Asking(Ask::Permission));
    a.store.set_permission("perm_1", "task_1", false);
    a.store.update_turn("trn_1", TurnStatus::Completed);
    record_settled(&a);
    assert_eq!(a.prompts.get("blob").state, DONE);
}

#[test]
fn ends_the_round_cancelled_keeping_the_session_when_the_turns_row_is_deleted() {
    let a = new_app();
    sent(&a);
    a.store.delete_turn("trn_1");
    let w = a.prompts.get("blob");
    assert_eq!(w.state, WidgetState::Settled(SettledOutcome::Cancelled));
    assert_eq!(w.bound_task_id.as_deref(), Some("task_1"));
}

#[test]
fn announces_the_round_it_starts_recorded_with_the_prompt_as_sent_and_as_typed() {
    let a = new_app();
    sent(&a);
    let row = a.rounds.collection().get("trn_1").unwrap();
    assert_eq!(row.blob_id.as_deref(), Some("blob"));
    assert_eq!(row.document_path, "/ws/doc.md");
    assert_eq!(row.prompt, "make it shorter");
    assert_eq!(row.typed_prompt.as_deref(), Some("@skill:edit make it shorter"));
}

/// Send and answer, the turn row ending, the round not yet recorded as ended.
fn ended_turn(a: &App) {
    sent(a);
    assert!(a.rounds.collection().get("trn_1").is_some());
    a.store.entries.borrow_mut().push(entry("evt_1", "trn_1", EntryType::Assistant, Some("Shortened it."), None));
    a.store.update_turn("trn_1", TurnStatus::Completed);
}

fn settled_round(a: &App) {
    ended_turn(a);
    record_settled(a);
}

#[test]
fn keeps_a_settled_widgets_face_when_a_revival_replays_its_turn_away() {
    let a = new_app();
    settled_round(&a);
    assert_eq!(a.prompts.get("blob").outcome.as_ref().unwrap().summary.as_deref(), Some("Shortened it."));
    a.store.delete_turn("trn_1");
    let w = a.prompts.get("blob");
    assert_eq!(w.state, DONE);
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.outcome.as_ref().unwrap().summary.as_deref(), Some("Shortened it."));
}

#[test]
fn brings_a_widget_back_as_it_was_left_after_a_restart_its_review_ranges_too() {
    let before = new_app();
    settled_round(&before);
    before.rounds.review_ranges().save(
        "/ws/other.md",
        SavedReviewRanges { fingerprint: "f".into(), changes: vec![change("blob", "trn_1", 1, 3), change("blob", "trn_1", 5, 8)] },
    );
    before.exec.run_until_parked();
    assert_eq!(before.rounds.collection().get("trn_1").unwrap().changes.unwrap().len(), 1);
    // A new run over the same database: no turn rows, no widget state.
    let after = app(before.exec.clone(), before.db.clone());
    after.exec.block_on(after.rounds.collection().preload());
    after.prompts.restore("blob", "task_1");
    let w = after.prompts.get("blob");
    assert_eq!(w.state, DONE);
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.last_sent_prompt, "@skill:edit make it shorter");
    assert_eq!(w.seen_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.outcome.as_ref().unwrap().summary.as_deref(), Some("Shortened it."));
    after.exec.run_until_parked();
    assert_eq!(after.prompts.review().counts("blob"), BTreeMap::from([("/ws/other.md".to_string(), 2)]));
}

#[test]
fn never_shows_an_ended_round_before_what_it_left_is_recorded() {
    let a = new_app();
    ended_turn(&a);
    let w = a.prompts.get("blob");
    assert_eq!(w.state, WidgetState::Working(WorkingTurn::Running));
    assert_eq!(w.outcome, None);
    record_settled(&a);
    assert_eq!(a.prompts.get("blob").state, DONE);
    assert_eq!(a.prompts.get("blob").outcome.as_ref().unwrap().summary.as_deref(), Some("Shortened it."));
}

#[test]
fn reads_the_same_record_until_it_changes() {
    let a = new_app();
    settled_round(&a);
    let observation = a.rounds.observe_newest("blob", Rc::new(|| {}));
    let first = observation.get().unwrap();
    assert!(Rc::ptr_eq(&observation.get().unwrap(), &first));
    a.exec
        .block_on(a.rounds.record_requeued(AgentTurnRequeuedEvent { task_id: "task_1".into(), turn_id: "trn_1".into() }))
        .unwrap();
    let next = observation.get().unwrap();
    assert!(!Rc::ptr_eq(&next, &first));
    assert_eq!(next.status, RecordStatus::Live);
}

// ── prompt-rounds-interrupt.test.ts: the real runtime (mock harness) ──

mod interrupt {
    use super::*;
    use notefig_agents::{AgentStoreModule, AgentsModule, PromptExtras};
    use notefig_core::{Core, CreateCoreOptions, ExecutorExt, ModuleRef, Services};
    use notefig_platform::PlatformService;

    struct Live {
        exec: Rc<TestExecutor>,
        core: Core,
        ws: String,
        _dir: tempfile::TempDir,
    }

    fn boot() -> Live {
        // SAFETY: every test in this binary sets the same values.
        unsafe {
            std::env::set_var("NOTEFIG_AGENT_MOCK", "1");
            std::env::remove_var("NOTEFIG_NO_AGENTS");
        }
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let core = Core::new(
            CreateCoreOptions::new(exec.clone())
                .services(
                    Services::new()
                        .with::<PlatformService>(fake.platform.clone())
                        .with::<notefig_layout::UrlService>(notefig_layout::MemoryUrl::new("")),
                )
                .modules(vec![ModuleRef::of::<AgentsModule>(), ModuleRef::of::<PromptRoundsModule>()]),
        )
        .unwrap();
        core.boot();
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
        let live = Live { exec, core, ws, _dir: dir };
        live.until(|l| l.core.use_::<AgentsModule>().is_ready());
        live
    }

    impl Live {
        fn until(&self, cond: impl Fn(&Live) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                self.exec.run_until_parked();
                if cond(self) {
                    return;
                }
                assert!(Instant::now() < deadline, "timed out");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn wait<T: 'static>(&self, fut: futures::future::LocalBoxFuture<'static, T>) -> T {
            let slot: Rc<RefCell<Option<T>>> = Rc::default();
            let out = slot.clone();
            self.exec.spawn_local(async move {
                *out.borrow_mut() = Some(fut.await);
            });
            self.until(|_| slot.borrow().is_some());
            slot.borrow_mut().take().unwrap()
        }

        fn task(&self) -> String {
            let started = self.wait(self.core.use_::<AgentsModule>().workspace(&self.ws).start_task("claude-code")).unwrap();
            self.wait(started.started).unwrap();
            started.task_id
        }

        /// Send through the widget host's path: prompt + the round-started event.
        fn send_round(&self, task: &str, text: &str) -> String {
            let agents = self.core.use_::<AgentsModule>();
            let handle = self.wait(agents.task(task).prompt(text, PromptExtras::default())).unwrap();
            self.core.hooks().emit::<WidgetRoundStarted>(RoundStart {
                task_id: task.into(),
                turn_id: handle.turn_id.clone(),
                workspace_path: self.ws.clone(),
                document_path: format!("{}/doc.md", self.ws),
                prompt: text.into(),
                blob_id: "blob_1".into(),
                typed_prompt: text.into(),
            });
            handle.turn_id
        }

        /// What the sidebar would show for this round now.
        fn shown(&self, turn_id: &str) -> Option<TurnStatus> {
            let rounds = self.core.use_::<PromptRoundsModule>();
            let store = self.core.use_::<AgentStoreModule>();
            let turns: Vec<(String, TurnStatus)> = store
                .tasks()
                .iter()
                .flat_map(|t| store.turns(&t.task_id))
                .map(|t| (t.turn_id, t.status))
                .collect();
            let key = notefig_files::paths::workspace_key(&self.ws);
            derive_prompt_rounds(&rounds.collection().values(), &[(key, self.ws.clone())], &turns)
                .into_iter()
                .find(|r| r.turn_id == turn_id)
                .map(|r| r.status)
        }

        fn recorded(&self, turn_id: &str) -> bool {
            self.core.use_::<PromptRoundsModule>().collection().has(turn_id)
        }
    }

    const SLOW: &str = r#"@@mock:{"scenario":"slow","options":{"ms":300}} do the thing"#;

    #[test]
    fn stop_while_running_settles_the_round() {
        let l = boot();
        let task = l.task();
        let turn = l.send_round(&task, SLOW);
        l.until(|l| l.recorded(&turn) && l.shown(&turn) == Some(TurnStatus::Running));
        l.wait(l.core.use_::<AgentsModule>().task(&task).cancel()).unwrap();
        l.until(|l| l.shown(&turn) != Some(TurnStatus::Running));
        assert_eq!(l.shown(&turn), Some(TurnStatus::Cancelled));
    }

    #[test]
    fn escape_to_restore_while_running_settles_the_round() {
        let l = boot();
        let task = l.task();
        let turn = l.send_round(&task, SLOW);
        l.until(|l| l.recorded(&turn));
        // Deviation: TS's fake agent holds its answer back, so the forget
        // always applies; the mock harness answers at once, so whether this
        // forgets or only cancels is a race. Either way the round must not
        // stay running.
        l.wait(l.core.use_::<AgentsModule>().task(&task).cancel_turn_and_forget());
        l.until(|l| l.shown(&turn) != Some(TurnStatus::Running));
    }

    #[test]
    fn dismissing_a_queued_prompt_settles_the_round() {
        let l = boot();
        let task = l.task();
        l.send_round(&task, SLOW);
        let queued = l.send_round(&task, "queued one");
        l.until(|l| l.recorded(&queued));
        assert_eq!(l.shown(&queued), Some(TurnStatus::Queued));
        l.core.use_::<AgentsModule>().task(&task).remove_queued_prompt(&queued);
        l.until(|l| l.shown(&queued) != Some(TurnStatus::Running) && l.shown(&queued) != Some(TurnStatus::Queued));
    }
}
