//! Port of `utils/__tests__/attention.test.ts`.

use std::collections::{HashMap, HashSet};

use notefig_agent::model::{AgentTaskRow, PermissionRequestRow};
use notefig_prompt_rounds::PromptRoundRow;
use notefig_seen::{SeenTarget, seen_key};
use serde_json::{Value, json};

use crate::*;

fn merge(mut base: Value, overrides: Value) -> Value {
    for (k, v) in overrides.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn task(overrides: Value) -> AgentTaskRow {
    let id = overrides["taskId"].clone();
    serde_json::from_value(merge(
        json!({"taskId": id, "workspacePath": "/ws-a", "title": id, "status": "idle", "harnessId": "claude-code", "createdAt": 1, "updatedAt": 2}),
        overrides,
    ))
    .unwrap()
}

fn round(overrides: Value) -> PromptRoundRow {
    serde_json::from_value(merge(
        json!({"turnId": "", "taskId": "task_w", "workspaceKey": "/ws-a", "documentPath": "/ws-a/doc.md", "prompt": "p",
               "status": "completed", "startedAt": 1, "settledAt": 10}),
        overrides,
    ))
    .unwrap()
}

fn permission(id: &str, task_id: &str) -> PermissionRequestRow {
    serde_json::from_value(json!({"id": id, "taskId": task_id, "sessionId": "s", "title": format!("allow {id}"), "options": [], "status": "pending"}))
        .unwrap()
}

fn seen_at(entries: &[(SeenTarget, i64)]) -> HashMap<String, i64> {
    entries.iter().map(|(t, at)| (seen_key(t), *at)).collect()
}

fn settled(turn: &str, at: i64, status: &str) -> Value {
    json!({"turnId": turn, "at": at, "status": status})
}

fn t(id: &str) -> SeenTarget {
    SeenTarget::Task(id.into())
}

/// `{ ...EMPTY, ... }`.
#[derive(Default)]
struct Rows {
    tasks: Vec<AgentTaskRow>,
    rounds: Vec<PromptRoundRow>,
    running: Vec<(String, String)>,
    open: Option<HashSet<String>>,
    pending: Vec<PermissionRequestRow>,
    seen: HashMap<String, i64>,
}

fn derive(rows: Rows) -> Attention {
    let open = rows.open.unwrap_or_else(|| HashSet::from(["/ws-a".to_string()]));
    let key = |p: &str| notefig_files::paths::workspace_key(p);
    derive_attention(&AttentionRows {
        tasks: &rows.tasks,
        rounds: &rows.rounds,
        running_turns: &rows.running,
        open_workspace_keys: &open,
        pending_permissions: &rows.pending,
        seen: &rows.seen,
        workspace_key: &key,
    })
}

use AttentionKind::{Bau, Error};

fn by_task(a: &Attention) -> Vec<(String, AttentionKind)> {
    a.by_task.iter().map(|(k, v)| (k.clone(), *v)).collect()
}

#[test]
fn is_empty_with_nothing_to_show() {
    let a = derive(Rows::default());
    assert!(a.items.is_empty());
    assert_eq!(a.overall, None);
}

#[test]
fn a_finished_turn_is_bau_a_failed_one_is_error_and_looking_clears_both() {
    let tasks = || {
        vec![
            task(json!({"taskId": "task_done", "lastSettled": settled("t1", 10, "completed")})),
            task(json!({"taskId": "task_bad", "status": "error", "lastSettled": settled("t2", 10, "error")})),
        ]
    };
    let unseen = derive(Rows { tasks: tasks(), ..Default::default() });
    assert_eq!(unseen.by_task["task_done"], Bau);
    assert_eq!(unseen.by_task["task_bad"], Error);
    assert_eq!(unseen.overall, Some(Error));
    let seen = derive(Rows { tasks: tasks(), seen: seen_at(&[(t("task_done"), 10), (t("task_bad"), 11)]), ..Default::default() });
    assert!(seen.items.is_empty());
}

#[test]
fn a_finished_turn_is_not_news_once_the_session_has_started_another() {
    let a = derive(Rows {
        tasks: vec![
            task(json!({"taskId": "task_moved_on", "status": "running", "lastSettled": settled("t1", 10, "completed")})),
            task(json!({"taskId": "task_reviving", "status": "starting", "lastSettled": settled("t1", 10, "completed")})),
            task(json!({"taskId": "task_retrying", "status": "running", "lastSettled": settled("t1", 10, "error")})),
        ],
        ..Default::default()
    });
    assert_eq!(by_task(&a), vec![("task_retrying".to_string(), Error)]);
}

#[test]
fn a_new_message_puts_the_session_back_into_running_the_next_settle_marks_it_again() {
    let a = settled("tA", 10, "completed");
    let b = settled("tB", 20, "completed");
    let mark = |status: &str, last: &Value| {
        derive(Rows {
            tasks: vec![task(json!({"taskId": "task_1", "status": status, "lastSettled": last}))],
            seen: seen_at(&[(t("task_1"), 5)]),
            ..Default::default()
        })
        .by_task
        .get("task_1")
        .copied()
    };
    assert_eq!(mark("idle", &a), Some(Bau));
    assert_eq!(mark("running", &a), None);
    assert_eq!(mark("idle", &b), Some(Bau));
    assert_eq!(mark("cancelled", &a), Some(Bau));
    let opened = derive(Rows {
        tasks: vec![task(json!({"taskId": "task_1", "lastSettled": b}))],
        seen: seen_at(&[(t("task_1"), 25)]),
        ..Default::default()
    });
    assert!(opened.items.is_empty());
}

#[test]
fn a_widget_round_marks_its_document_never_its_session() {
    let a = derive(Rows {
        tasks: vec![task(json!({"taskId": "task_w", "lastSettled": settled("t_w", 10, "completed")}))],
        rounds: vec![round(json!({"turnId": "t_w"}))],
        ..Default::default()
    });
    assert!(!a.by_task.contains_key("task_w"));
    assert_eq!(a.by_round["t_w"], Bau);
    assert_eq!(a.overall, Some(Bau));
}

#[test]
fn an_error_no_turn_produced_is_marked_from_the_moment_it_was_entered() {
    let a = derive(Rows {
        tasks: vec![
            task(json!({"taskId": "task_died", "status": "error", "updatedAt": 200, "lastSettled": settled("t_old", 5, "completed")})),
            task(json!({"taskId": "task_widget_died", "status": "error", "updatedAt": 200, "lastSettled": settled("t_w", 5, "completed")})),
        ],
        rounds: vec![round(json!({"turnId": "t_w"}))],
        seen: seen_at(&[(t("task_died"), 100)]),
        ..Default::default()
    });
    assert_eq!(a.by_task["task_died"], Error);
    assert_eq!(a.by_task["task_widget_died"], Error);
    let turn_failed = derive(Rows {
        tasks: vec![task(json!({"taskId": "task_bad", "status": "error", "lastSettled": settled("t", 5, "error")}))],
        seen: seen_at(&[(t("task_bad"), 100)]),
        ..Default::default()
    });
    assert!(turn_failed.items.is_empty());
}

#[test]
fn a_round_is_seen_through_its_document_a_later_round_on_the_same_document_is_not() {
    let a = derive(Rows {
        rounds: vec![
            round(json!({"turnId": "t_old", "settledAt": 5})),
            round(json!({"turnId": "t_new", "settledAt": 20, "status": "error"})),
        ],
        seen: seen_at(&[(SeenTarget::Document("/ws-a/doc.md".into()), 10)]),
        ..Default::default()
    });
    assert_eq!(a.by_round.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(), vec![("t_new", Error)]);
    assert_eq!(a.overall, Some(Error));
}

#[test]
fn cancelled_and_still_live_rounds_and_rounds_of_closed_workspaces_say_nothing() {
    let a = derive(Rows {
        rounds: vec![
            round(json!({"turnId": "t_cancel", "status": "cancelled"})),
            round(json!({"turnId": "t_live", "status": "live", "settledAt": null})),
            round(json!({"turnId": "t_closed", "workspaceKey": "/ws-closed"})),
        ],
        ..Default::default()
    });
    assert!(a.items.is_empty());
}

#[test]
fn a_harness_that_never_came_up_is_an_error_that_looking_clears_and_failing_again_re_marks() {
    let failed = || task(json!({"taskId": "task_spawn", "status": "error", "updatedAt": 50}));
    let gone = || task(json!({"taskId": "task_gone", "status": "unavailable", "updatedAt": 50}));
    let fresh = derive(Rows { tasks: vec![failed(), gone()], ..Default::default() });
    assert_eq!(fresh.by_task.values().copied().collect::<Vec<_>>(), vec![Error, Error]);
    let looked = || seen_at(&[(t("task_spawn"), 60), (t("task_gone"), 60)]);
    assert!(derive(Rows { tasks: vec![failed(), gone()], seen: looked(), ..Default::default() }).items.is_empty());
    let mut again = failed();
    again.updated_at = 70;
    assert_eq!(derive(Rows { tasks: vec![again], seen: looked(), ..Default::default() }).by_task["task_spawn"], Error);
}

#[test]
fn asks_are_errors_that_looking_does_not_clear() {
    let a = derive(Rows {
        tasks: vec![
            task(json!({"taskId": "task_perm", "status": "running"})),
            task(json!({"taskId": "task_auth", "authRequired": true})),
        ],
        running: vec![("task_perm".into(), "t_asking".into())],
        pending: vec![permission("p2", "task_perm"), permission("p1", "task_perm")],
        seen: seen_at(&[(t("task_perm"), 1_000), (t("task_auth"), 1_000)]),
        ..Default::default()
    });
    assert_eq!(a.by_task.values().copied().collect::<Vec<_>>(), vec![Error, Error]);
    let asks: Vec<_> = a.asks.iter().map(|i| (i.task_id.as_str(), i.ask, i.turn_id.as_deref())).collect();
    assert_eq!(
        asks,
        vec![("task_perm", Some(AttentionAsk::Permission), Some("t_asking")), ("task_auth", Some(AttentionAsk::Auth), None)]
    );
    assert_eq!(a.asks[0].permission.as_ref().unwrap().id, "p1");
}

#[test]
fn a_widget_round_that_ended_on_a_choice_question_asks_from_its_document_until_looked_at() {
    let question = || {
        round(json!({"turnId": "t_q", "outcome": {
            "response": {"kind": "single_choice", "markdown": "Pro or Team?", "options": ["Pro", "Team"]},
            "summary": null, "error": null, "touchedFiles": []
        }}))
    };
    let a = derive(Rows { rounds: vec![question()], ..Default::default() });
    assert_eq!(a.by_round["t_q"], Error);
    let asks: Vec<_> = a.asks.iter().map(|i| (i.ask, i.question.as_deref(), i.turn_id.as_deref())).collect();
    assert_eq!(asks, vec![(Some(AttentionAsk::Question), Some("Pro or Team?"), Some("t_q"))]);
    let looked = seen_at(&[(SeenTarget::Document("/ws-a/doc.md".into()), 20)]);
    assert!(derive(Rows { rounds: vec![question()], seen: looked, ..Default::default() }).items.is_empty());
}

#[test]
fn a_restored_session_is_quiet_until_it_is_revived() {
    let restored = task(json!({"taskId": "task_restored", "status": "restored", "lastSettled": settled("t1", 10, "completed")}));
    assert!(derive(Rows { tasks: vec![restored.clone()], ..Default::default() }).items.is_empty());
    let mut revived = restored;
    revived.status = notefig_agent::model::TaskStatus::Idle;
    assert_eq!(derive(Rows { tasks: vec![revived], ..Default::default() }).by_task["task_restored"], Bau);
}

#[test]
fn the_sidebar_dot_is_an_error_when_anything_is_else_bau() {
    assert_eq!(most_pressing(None, None), None);
    assert_eq!(most_pressing(Some(Bau), None), Some(Bau));
    assert_eq!(most_pressing(Some(Bau), Some(Error)), Some(Error));
    let a = derive(Rows {
        tasks: vec![task(json!({"taskId": "task_done", "lastSettled": settled("t1", 10, "completed")}))],
        rounds: vec![round(json!({"turnId": "t_bad", "status": "error"}))],
        ..Default::default()
    });
    assert_eq!(a.by_task["task_done"], Bau);
    assert_eq!(a.by_round["t_bad"], Error);
    assert_eq!(a.overall, Some(Error));
}

#[test]
fn counts_errors_per_workspace_key_for_the_rail_newest_first_overall() {
    let a = derive(Rows {
        open: Some(HashSet::from(["/ws-a".to_string(), "/ws-b".to_string()])),
        tasks: vec![
            task(json!({"taskId": "task_a", "workspacePath": "/ws-a", "status": "unavailable", "updatedAt": 3})),
            task(json!({"taskId": "task_b", "workspacePath": "/ws-b/", "lastSettled": settled("t", 9, "completed")})),
        ],
        rounds: vec![round(json!({"turnId": "t_b", "workspaceKey": "/ws-b", "status": "error", "settledAt": 7}))],
        ..Default::default()
    });
    assert_eq!(
        a.by_workspace.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(),
        vec![("/ws-a", 1), ("/ws-b", 1)]
    );
    assert_eq!(a.items.iter().map(|i| i.since).collect::<Vec<_>>(), vec![9, 7, 3]);
}
