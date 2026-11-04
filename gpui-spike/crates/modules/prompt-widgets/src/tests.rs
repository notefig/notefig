//! `@notefig/widgets` `prompt/__tests__/widgets-service.test.ts`, over
//! [`crate::testing::TestPrompts`]. (`machine.test.ts` is in `machine.rs`;
//! `modules/prompt-widgets/prompt-widgets.test.ts` needs the prompt rounds
//! module and lives in `notefig-prompt-rounds`.)

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use notefig_agent::mcp::tools::WidgetResponse;
use notefig_agent::model::TurnStatus::*;
use notefig_core::testing::TestExecutor;

use crate::testing::*;
use crate::*;

fn setup() -> (Rc<TestExecutor>, TestPrompts) {
    let exec = TestExecutor::new();
    let t = TestPrompts::new(exec.clone());
    (exec, t)
}

fn send(exec: &TestExecutor, t: &TestPrompts, blob: &str, prompt: &str, task: &str, turn: &str) -> bool {
    exec.block_on(t.send(blob, prompt, task, turn))
}

const RUNNING: WidgetState = WidgetState::Working(WorkingTurn::Running);
const QUEUED: WidgetState = WidgetState::Working(WorkingTurn::Queued);
const DONE: WidgetState = WidgetState::Settled(SettledOutcome::Done);

#[test]
fn walks_a_round_from_send_to_settled_following_the_agents_rows() {
    let (exec, t) = setup();
    let seen: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let (s, p) = (seen.clone(), t.prompts.clone());
    let _sub = t.prompts.subscribe("blob", move || s.borrow_mut().push(p.get("blob").state.name()));

    assert!(send(&exec, &t, "blob", "summarize", "task_1", "trn_1"));
    let w = t.prompts.get("blob");
    assert_eq!(w.state, QUEUED);
    assert_eq!(w.bound_task_id.as_deref(), Some("task_1"));
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.last_sent_prompt, "summarize");
    assert_eq!(seen.borrow()[0], "sending");

    t.set_turn("trn_1", "task_1", Running);
    assert_eq!(t.prompts.get("blob").state, RUNNING);
    t.set_pending_permission("task_1", true);
    assert_eq!(t.prompts.get("blob").state, WidgetState::Asking(Ask::Permission));
    t.set_pending_permission("task_1", false);
    t.set_turn("trn_1", "task_1", Completed);
    assert_eq!(t.prompts.get("blob").state, DONE);
}

#[test]
fn treats_a_turn_row_that_hasnt_appeared_yet_as_queued_and_a_vanished_one_as_cancelled() {
    let (exec, t) = setup();
    exec.block_on(t.prompts.send("blob", "hi", || {
        Box::pin(async { Ok(dispatched("task_1", "trn_1", "hi")) })
    }));
    assert_eq!(t.prompts.get("blob").state, QUEUED);
    t.set_turn("trn_1", "task_1", Running);
    t.remove_turn("trn_1");
    let w = t.prompts.get("blob");
    assert_eq!(w.state, WidgetState::Settled(SettledOutcome::Cancelled));
    assert_eq!(w.bound_task_id.as_deref(), Some("task_1"));
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.last_sent_prompt, "hi");
}

#[test]
fn returns_to_composing_when_the_dispatch_fails() {
    let (exec, t) = setup();
    let sent = exec.block_on(t.prompts.send("blob", "hi", || Box::pin(async { Err("no session".to_string()) })));
    assert!(!sent);
    assert_eq!(t.prompts.get("blob").state.name(), "composing");
}

#[test]
fn wont_send_while_a_round_is_live() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "first", "task_1", "trn_1");
    let called = Rc::new(RefCell::new(false));
    let c = called.clone();
    let sent = exec.block_on(t.prompts.send("blob", "second", move || {
        *c.borrow_mut() = true;
        Box::pin(async { Ok(dispatched("task_1", "trn_2", "")) })
    }));
    assert!(!sent);
    assert!(!*called.borrow());
}

#[test]
fn withdraws_a_queued_turn_and_cancels_a_running_one() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "hi", "task_1", "trn_1");
    assert_eq!(t.prompts.stop("blob", &t.commands), StopResult::Withdrawn);
    assert_eq!(t.commands.removed.borrow()[0], ("task_1".into(), "trn_1".into()));
    assert_eq!(t.prompts.get("blob").bound_turn_id, None);

    send(&exec, &t, "blob", "again", "task_1", "trn_2");
    t.set_turn("trn_2", "task_1", Running);
    assert_eq!(t.prompts.stop("blob", &t.commands), StopResult::Cancelled);
    assert_eq!(t.commands.cancelled.borrow()[0], "task_1");
    assert_eq!(t.prompts.get("blob").bound_turn_id.as_deref(), Some("trn_2"));
    assert_eq!(t.prompts.stop("other", &t.commands), StopResult::None);
}

#[test]
fn restores_a_persisted_session_without_clobbering_a_live_one() {
    let (exec, t) = setup();
    t.prompts.restore("blob_restored", "task_7");
    let w = t.prompts.get("blob_restored");
    assert_eq!(w.state.name(), "composing");
    assert_eq!(w.bound_task_id.as_deref(), Some("task_7"));
    assert_eq!(w.bound_turn_id, None);

    send(&exec, &t, "blob_live", "hi", "task_1", "trn_1");
    t.prompts.restore("blob_live", "task_other");
    assert_eq!(t.prompts.get("blob_live").bound_task_id.as_deref(), Some("task_1"));
}

#[test]
fn finds_the_widget_for_a_task_preferring_the_one_watching_a_turn() {
    let (exec, t) = setup();
    send(&exec, &t, "blob_a", "a", "task_x", "trn_a");
    assert_eq!(t.prompts.find_by_task("task_x", None), None);
    t.prompts.set_document("blob_a", "/ws/a.md");
    send(&exec, &t, "blob_b", "b", "task_x", "trn_b");
    t.prompts.set_document("blob_b", "/ws/b.md");
    assert_eq!(
        t.prompts.find_by_task("task_x", Some("trn_b")),
        Some(PromptWidgetLocation {
            blob_id: "blob_b".into(),
            document_path: "/ws/b.md".into(),
            bound_turn_id: Some("trn_b".into()),
        })
    );
    assert_eq!(t.prompts.find_by_task("task_x", Some("trn_none")), None);
    assert_eq!(t.prompts.find_by_task("task_x", None).unwrap().blob_id, "blob_a");
    assert_eq!(t.prompts.find_by_task("task_other", None), None);
}

#[test]
fn is_silent_when_nothing_changed_and_keeps_a_stable_snapshot() {
    let (_exec, t) = setup();
    let calls = Rc::new(RefCell::new(0));
    let c = calls.clone();
    let _sub = t.prompts.subscribe("blob", move || *c.borrow_mut() += 1);
    t.prompts.set_document("blob", "/ws/e.md");
    t.prompts.set_document("blob", "/ws/e.md");
    assert_eq!(*calls.borrow(), 1);
    assert!(Rc::ptr_eq(&t.prompts.get("blob"), &t.prompts.get("blob")));
}

#[test]
fn withdraws_a_queued_turn_waiting_behind_a_sign_in_instead_of_cancelling_the_session() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "hi", "task_1", "trn_1");
    t.set_auth_required("task_1", true);
    assert_eq!(t.prompts.get("blob").state, WidgetState::Asking(Ask::Auth));
    assert_eq!(t.prompts.stop("blob", &t.commands), StopResult::Withdrawn);
    assert_eq!(t.commands.removed.borrow()[0], ("task_1".into(), "trn_1".into()));
    assert!(t.commands.cancelled.borrow().is_empty());
    assert!(!t.prompts.withdraw("blob", &t.commands));
}

#[test]
fn escape_belongs_to_the_newest_stoppable_turn_among_mounted_widgets() {
    let (exec, t) = setup();
    let mut releases = std::collections::HashMap::new();
    for (blob, turn, doc) in [("blob_old", "trn_1", "/ws/a.md"), ("blob_new", "trn_2", "/ws/a.md"), ("blob_other_pane", "trn_3", "/ws/b.md")] {
        t.prompts.set_document(blob, doc);
        releases.insert(blob, t.prompts.claim_escape(blob));
        send(&exec, &t, blob, "hi", "task_1", turn);
    }
    assert!(t.prompts.is_newest_stoppable("blob_other_pane"));
    assert!(!t.prompts.is_newest_stoppable("blob_new"));
    assert!(!t.prompts.is_newest_stoppable("blob_old"));
    releases.remove("blob_other_pane").unwrap().dispose();
    assert!(!t.prompts.is_newest_stoppable("blob_other_pane"));
    assert!(t.prompts.is_newest_stoppable("blob_new"));
    t.prompts.unbind("blob_new");
    assert!(t.prompts.is_newest_stoppable("blob_old"));
}

fn change(blob: &str, turn: &str, from: i64, to: i64) -> PromptChange {
    PromptChange { blob_id: blob.into(), turn_id: turn.into(), from, to }
}

#[test]
fn forgets_a_widgets_tracked_changes_when_it_binds_a_new_turn() {
    let (exec, t) = setup();
    send(&exec, &t, "blob_r", "one", "task_1", "trn_1");
    t.set_turn("trn_1", "task_1", Completed);
    t.prompts.review().set("/ws/r.md", vec![change("blob_r", "trn_1", 1, 3), change("blob_s", "trn_9", 4, 5)]);
    t.prompts.set_document("blob_r", "/ws/r.md");
    send(&exec, &t, "blob_r", "two", "task_1", "trn_2");
    assert_eq!(*t.prompts.review().changes("/ws/r.md"), vec![change("blob_s", "trn_9", 4, 5)]);
}

// ── stored rounds (MET-251) ──

fn outcome() -> RoundOutcome {
    RoundOutcome {
        response: None,
        summary: Some("Shortened it.".into()),
        error: None,
        touched_files: vec!["/ws/doc.md".into()],
    }
}

fn settled(turn: &str, task: &str) -> StoredRound {
    StoredRound {
        turn_id: turn.into(),
        task_id: task.into(),
        status: RecordStatus::Completed,
        prompt: "make it shorter\nplease".into(),
        outcome: Some(outcome()),
    }
}

#[test]
fn a_restored_widget_comes_back_as_it_was_left() {
    let (_exec, t) = setup();
    t.store_round("blob", settled("trn_1", "task_1"));
    t.prompts.restore("blob", "task_1");
    let w = t.prompts.get("blob");
    assert_eq!(w.state, DONE);
    assert_eq!(w.bound_task_id.as_deref(), Some("task_1"));
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.last_sent_prompt, "make it shorter\nplease");
    assert_eq!(w.outcome, Some(outcome()));
}

#[test]
fn adopts_a_stored_round_that_loads_after_the_restore() {
    let (_exec, t) = setup();
    t.prompts.restore("blob", "task_1");
    assert_eq!(t.prompts.get("blob").state.name(), "composing");
    t.store_round("blob", settled("trn_1", "task_1"));
    assert_eq!(t.prompts.get("blob").state, DONE);
}

#[test]
fn a_restored_round_the_last_run_never_finished_settles_when_its_record_does() {
    let (_exec, t) = setup();
    t.store_round("blob", StoredRound { status: RecordStatus::Live, outcome: None, ..settled("trn_1", "task_1") });
    t.prompts.restore("blob", "task_1");
    let w = t.prompts.get("blob");
    assert_eq!(w.state.name(), "composing");
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    t.store_round("blob", StoredRound { status: RecordStatus::Cancelled, outcome: None, ..settled("trn_1", "task_1") });
    assert_eq!(t.prompts.get("blob").state, WidgetState::Settled(SettledOutcome::Cancelled));
}

#[test]
fn doesnt_adopt_another_sessions_round_or_once_the_user_moved_on() {
    let (_exec, t) = setup();
    t.store_round("other", settled("trn_2", "task_other"));
    t.prompts.restore("other", "task_1");
    t.prompts.restore("moved", "task_1");
    t.prompts.rebind("moved", "task_1");
    t.store_round("moved", settled("trn_1", "task_1"));
    for blob in ["other", "moved"] {
        let w = t.prompts.get(blob);
        assert_eq!(w.state.name(), "composing");
        assert_eq!(w.bound_turn_id, None);
        assert_eq!(w.outcome, None);
    }
}

#[test]
fn stays_settled_when_a_session_revival_replays_its_turn_away() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "make it shorter", "task_1", "trn_1");
    t.set_turn("trn_1", "task_1", Completed);
    t.store_round("blob", settled("trn_1", "task_1"));
    assert_eq!(t.prompts.get("blob").outcome, Some(outcome()));
    t.remove_turn("trn_1");
    let w = t.prompts.get("blob");
    assert_eq!(w.state, DONE);
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(w.outcome, Some(outcome()));
}

#[test]
fn a_live_round_ends_when_its_record_does_never_before_what_it_left_is_written() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "make it shorter", "task_1", "trn_1");
    t.store_round("blob", StoredRound { status: RecordStatus::Live, outcome: None, ..settled("trn_1", "task_1") });
    t.set_turn("trn_1", "task_1", Running);
    t.set_turn_with("trn_1", "task_1", Completed, true);
    let w = t.prompts.get("blob");
    assert_eq!(w.state, RUNNING);
    assert_eq!(w.outcome, None);
    t.store_round("blob", settled("trn_1", "task_1"));
    let w = t.prompts.get("blob");
    assert_eq!(w.state, DONE);
    assert_eq!(w.outcome, Some(outcome()));
}

#[test]
fn a_round_that_ends_on_a_question_asks_for_the_answer_which_is_the_next_send() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "draft the pricing section", "task_1", "trn_1");
    t.set_turn("trn_1", "task_1", Completed);
    let question = RoundOutcome {
        response: Some(WidgetResponse {
            kind: "single_choice".into(),
            markdown: "Pro or Enterprise?".into(),
            title: None,
            options: Some(vec!["Pro".into(), "Enterprise".into()]),
        }),
        ..outcome()
    };
    t.store_round("blob", StoredRound { outcome: Some(question.clone()), ..settled("trn_1", "task_1") });
    let w = t.prompts.get("blob");
    assert_eq!(w.state, WidgetState::Asking(Ask::Question));
    assert_eq!(w.outcome, Some(question));
    assert_eq!(
        capabilities_of(w.state, false),
        WidgetCapabilities { field_editable: true, removable: true, escape: Escape::Leave, live_draft: true }
    );
    assert!(send(&exec, &t, "blob", "Enterprise", "task_1", "trn_2"));
    let w = t.prompts.get("blob");
    assert_eq!(w.state, QUEUED);
    assert_eq!(w.bound_turn_id.as_deref(), Some("trn_2"));
}

#[test]
fn an_errored_turn_waiting_on_a_sign_in_still_asks_for_it_while_its_record_catches_up() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "make it shorter", "task_1", "trn_1");
    t.store_round("blob", StoredRound { status: RecordStatus::Live, outcome: None, ..settled("trn_1", "task_1") });
    t.set_auth_required("task_1", true);
    t.set_turn("trn_1", "task_1", Error);
    assert_eq!(t.prompts.get("blob").state, WidgetState::Asking(Ask::Auth));
}

#[test]
fn runs_a_retried_round_again_before_its_record_reopens() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "make it shorter", "task_1", "trn_1");
    t.set_auth_required("task_1", true);
    t.set_turn("trn_1", "task_1", Error);
    t.set_auth_required("task_1", false);
    t.set_turn("trn_1", "task_1", Queued);
    assert_eq!(t.prompts.get("blob").state, QUEUED);
    assert_eq!(capabilities_of(t.prompts.get("blob").state, false).escape, Escape::Stop);
}

#[test]
fn a_restored_round_was_seen_one_that_ends_this_run_is_new_until_marked_seen() {
    let (exec, t) = setup();
    t.store_round("restored", settled("trn_1", "task_1"));
    t.prompts.restore("restored", "task_1");
    assert_eq!(t.prompts.get("restored").seen_turn_id.as_deref(), Some("trn_1"));

    send(&exec, &t, "blob", "make it shorter", "task_1", "trn_1");
    t.set_turn("trn_1", "task_1", Completed);
    assert_eq!(t.prompts.get("blob").seen_turn_id, None);
    t.prompts.mark_seen("blob");
    assert_eq!(t.prompts.get("blob").seen_turn_id.as_deref(), Some("trn_1"));
}

#[test]
fn shows_only_the_outcome_of_the_round_it_is_bound_to() {
    let (exec, t) = setup();
    send(&exec, &t, "blob", "first", "task_1", "trn_1");
    t.set_turn("trn_1", "task_1", Completed);
    t.store_round("blob", settled("trn_1", "task_1"));
    send(&exec, &t, "blob", "second", "task_1", "trn_2");
    assert_eq!(t.prompts.get("blob").outcome, None);
    t.prompts.unbind("blob");
    assert_eq!(t.prompts.get("blob").outcome, None);
}

// ── review ranges (MET-251) ──

const DOC: &str = "/ws/doc.md";

fn ranges(blob: &str, turn: &str) -> SavedReviewRanges {
    SavedReviewRanges { fingerprint: "f".into(), changes: vec![change(blob, turn, 1, 4)] }
}

#[test]
fn forgets_a_widgets_saved_ranges_when_it_moves_to_a_new_round_open_document_or_not() {
    let exec = TestExecutor::new();
    let saved = TestReviewRanges::new(vec![(DOC, ranges("blob", "trn_1"))]);
    let t = TestPrompts::with_review_ranges(exec.clone(), saved.clone());
    send(&exec, &t, "blob", "one", "task_1", "trn_1");
    t.set_turn("trn_1", "task_1", Completed);
    send(&exec, &t, "blob", "two", "task_1", "trn_2");
    assert_eq!(saved.saved.borrow()[DOC].changes, vec![]);
    assert_eq!(t.prompts.review().counts("blob"), BTreeMap::new());
}

#[test]
fn keeps_them_when_a_restore_takes_up_the_round_that_made_them() {
    let exec = TestExecutor::new();
    let saved = TestReviewRanges::new(vec![(DOC, ranges("blob", "trn_1"))]);
    let t = TestPrompts::with_review_ranges(exec.clone(), saved.clone());
    exec.run_until_parked();
    t.store_round(
        "blob",
        StoredRound { turn_id: "trn_1".into(), task_id: "task_1".into(), status: RecordStatus::Completed, prompt: "one".into(), outcome: None },
    );
    t.prompts.restore("blob", "task_1");
    assert_eq!(t.prompts.get("blob").bound_turn_id.as_deref(), Some("trn_1"));
    assert_eq!(saved.saved.borrow()[DOC].changes.len(), 1);
    assert_eq!(t.prompts.review().counts("blob"), BTreeMap::from([(DOC.to_string(), 1)]));
}

#[test]
fn round_status_table() {
    use RecordStatus as R;
    let cases = [
        (Some(R::Live), Some(Queued), false, Some(Queued)),
        (Some(R::Live), Some(Running), false, Some(Running)),
        (Some(R::Live), Some(Completed), false, Some(Running)),
        (None, Some(Error), false, Some(Running)),
        (Some(R::Live), None, false, None),
        (Some(R::Live), None, true, Some(Cancelled)),
        (Some(R::Completed), None, true, Some(Completed)),
        (Some(R::Error), Some(Error), false, Some(Error)),
        (Some(R::Error), Some(Queued), false, Some(Queued)),
    ];
    for (record, turn, gone, expected) in cases {
        assert_eq!(round_status(record, turn, gone), expected, "{record:?} {turn:?} {gone}");
    }
}

/// The live draft the minimap titles a dot with (the Rust draft lives in
/// the widget view, not the document; see `PromptWidget::draft`).
#[test]
fn holds_the_live_draft_and_tells_only_when_it_changes() {
    let (_exec, t) = setup();
    let told = Rc::new(RefCell::new(0));
    let c = told.clone();
    let _sub = t.prompts.subscribe("blob", move || *c.borrow_mut() += 1);
    t.prompts.set_draft("blob", "half typed");
    assert_eq!(t.prompts.get("blob").draft, "half typed");
    t.prompts.set_draft("blob", "half typed");
    assert_eq!(*told.borrow(), 1);
    t.prompts.set_draft("blob", "");
    assert_eq!(t.prompts.get("blob").draft, "");
    assert_eq!(*told.borrow(), 2);
}

/// `refuseRemoval`: every refused attempt is stamped anew, so the face
/// shakes on each one (`prompt-widget-state.test.tsx`).
#[test]
fn stamps_each_refused_removal() {
    let (_exec, t) = setup();
    assert_eq!(t.prompts.get("blob").removal_refused_at, None);
    t.prompts.refuse_removal("blob");
    let first = t.prompts.get("blob").removal_refused_at.expect("stamped");
    std::thread::sleep(std::time::Duration::from_millis(3));
    t.prompts.refuse_removal("blob");
    assert!(t.prompts.get("blob").removal_refused_at.unwrap() > first);
}
