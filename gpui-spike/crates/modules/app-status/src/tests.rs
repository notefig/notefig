//! Ports of `hooks/use-app-status.test.ts`, `app_status.rs`'s tests and the
//! Tauri adapter's publish dedup.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::*;

#[derive(Default)]
struct Host {
    tabs: bool,
    scratchpads: bool,
    calls: RefCell<Vec<String>>,
}

impl AppStatusHost for Host {
    fn has_tabs(&self) -> bool {
        self.tabs
    }
    fn has_scratchpads(&self) -> bool {
        self.scratchpads
    }
    fn open_document(&self, path: &str) {
        self.calls.borrow_mut().push(format!("open {path} replace"));
    }
    fn open_agent(&self, task_id: &str) {
        self.calls.borrow_mut().push(format!("openAgent {task_id}"));
    }
    fn jump_to_round(&self, task_id: &str, turn_id: &str, _: &str) {
        self.calls.borrow_mut().push(format!("jumpToRound {task_id} {turn_id}"));
    }
    fn jump_to_task(&self, task_id: &str, _: Option<&str>) {
        self.calls.borrow_mut().push(format!("jumpToTask {task_id}"));
    }
    fn new_scratchpad(&self) {}
    fn open_workspace(&self) {}
    fn open_settings(&self) {}
}

fn round(turn_id: &str, status: &str) -> RoundRow {
    RoundRow {
        turn_id: turn_id.into(),
        task_id: "task_a".into(),
        document_path: "/ws-a/notes.md".into(),
        prompt: format!("prompt {turn_id}"),
        status: status.into(),
    }
}

fn session(task_id: &str, status: &str) -> SessionRow {
    SessionRow {
        task_id: task_id.into(),
        workspace_path: "/ws-a".into(),
        title: format!("session {task_id}"),
        status: status.into(),
        is_running: status == "running",
        ..Default::default()
    }
}

fn document(path: &str) -> DocumentRow {
    DocumentRow { path: path.into(), workspace_path: "/ws-a".into() }
}

fn inputs(host: Rc<Host>) -> AppStatusInputs {
    AppStatusInputs {
        host,
        rounds: vec![],
        sessions: vec![],
        documents: vec![],
        attention: Attention::default(),
        t: Rc::new(|key, _| key.to_string()),
    }
}

fn focused() -> Rc<Host> {
    Rc::new(Host { tabs: true, scratchpads: true, ..Default::default() })
}

fn ids(status: &AppStatus) -> Vec<&str> {
    status.sections.iter().map(|s| s.id.as_str()).collect()
}

#[test]
fn lists_only_sections_with_rows_in_the_sidebar_order() {
    let mut i = inputs(focused());
    i.rounds = vec![round("t1", "completed")];
    i.sessions = vec![session("task_a", "idle")];
    let status = derive_app_status(&i);
    assert_eq!(ids(&status), ["prompts", "sessions"]);
    assert_eq!(status.attention, None);
}

#[test]
fn marks_rows_as_the_sidebar_does_attention_outranks_status() {
    let mut i = inputs(focused());
    i.rounds = vec![round("t1", "running"), round("t2", "error")];
    i.sessions = vec![session("task_a", "running"), session("task_b", "idle")];
    i.documents = vec![document("/ws-a/notes.md")];
    i.attention = Attention {
        items: vec![],
        overall: Some(AttentionKind::Error),
        by_round: HashMap::from([("t2".into(), AttentionKind::Error)]),
        by_task: HashMap::from([("task_b".into(), AttentionKind::Bau)]),
    };
    let status = derive_app_status(&i);
    let [prompts, documents, sessions] = &status.sections[..] else { panic!("{status:?}") };
    let marks = |s: &AppStatusSection| s.entries.iter().map(|e| e.mark.clone().unwrap()).collect::<Vec<_>>();
    let details = |s: &AppStatusSection| s.entries.iter().map(|e| e.detail.clone().unwrap()).collect::<Vec<_>>();
    assert_eq!(marks(prompts), ["running", "attention-error"]);
    assert_eq!(details(prompts), ["agentRunning", "agentFailed"]);
    assert_eq!(documents.entries[0].label, "notes.md");
    assert_eq!(documents.entries[0].mark.as_deref(), Some("running"));
    assert_eq!(marks(sessions), ["running", "attention-bau"]);
    assert_eq!(details(sessions), ["agentRunning", "ws-a"]);
    assert_eq!(status.attention.as_deref(), Some("attention-error"));
}

#[test]
fn lists_what_the_recency_cut_leaves_out_under_needs_attention() {
    let unlisted = AttentionItem {
        target: AttentionTarget::Task("task_z".into()),
        kind: AttentionKind::Error,
        task_id: "task_z".into(),
        turn_id: None,
        workspace_key: "/ws-a".into(),
        task_title: Some("session task_z".into()),
    };
    let listed = AttentionItem { target: AttentionTarget::Task("task_a".into()), task_id: "task_a".into(), ..unlisted.clone() };
    let mut i = inputs(focused());
    i.sessions = vec![session("task_a", "idle")];
    i.attention = Attention {
        items: vec![listed, unlisted],
        overall: Some(AttentionKind::Error),
        by_round: HashMap::new(),
        by_task: HashMap::from([("task_a".into(), AttentionKind::Error), ("task_z".into(), AttentionKind::Error)]),
    };
    let status = derive_app_status(&i);
    assert_eq!(status.attention.as_deref(), Some("attention-error"));
    assert_eq!(ids(&status), ["attention", "sessions"]);
    assert_eq!(status.sections[0].entries[0].label, "session task_z");
    assert_eq!(status.sections[0].entries[0].id, "attention:task_z:null");
}

#[test]
fn reads_a_documents_running_mark_off_every_live_round() {
    let mut i = inputs(focused());
    i.rounds = ["t1", "t2", "t3", "t4"]
        .iter()
        .map(|id| RoundRow { document_path: format!("/ws-a/{id}.md"), ..round(id, "running") })
        .collect();
    i.documents = vec![document("/ws-a/t4.md")];
    let status = derive_app_status(&i);
    assert_eq!(status.sections[0].entries.len(), 3);
    assert_eq!(status.sections[1].entries[0].mark.as_deref(), Some("running"));
}

#[test]
fn names_the_document_for_a_completed_prompt() {
    let mut i = inputs(focused());
    i.rounds = vec![round("t1", "completed")];
    assert_eq!(derive_app_status(&i).sections[0].entries[0].detail.as_deref(), Some("notes.md"));
}

#[test]
fn opens_entries_where_the_sidebar_would() {
    let host = focused();
    let mut i = inputs(host.clone());
    i.sessions = vec![session("task_a", "idle")];
    i.documents = vec![document("/ws-a/a.md")];
    let derived = derive_app_status(&i);
    assert_eq!(derived.sections[0].entries[0].mark.as_deref(), Some("document"));
    let api = create_app_status(None);
    api.publish(derived);
    assert!(api.activate("documents:/ws-a/a.md"));
    assert!(api.activate("sessions:task_a"));
    assert!(!api.activate("sessions:gone"));
    assert_eq!(*host.calls.borrow(), ["open /ws-a/a.md replace", "openAgent task_a"]);
}

#[test]
fn keeps_labels_short_and_ids_unique() {
    let mut i = inputs(focused());
    i.rounds = vec![RoundRow { prompt: "x".repeat(80), ..round("t1", "completed") }];
    i.sessions = vec![session("t1", "idle")];
    let status = derive_app_status(&i);
    assert_eq!(status.sections[0].entries[0].label.chars().count(), 48);
    let mut all: Vec<&str> = status.sections.iter().flat_map(|s| s.entries.iter().map(|e| e.id.as_str())).collect();
    all.extend(status.actions.iter().map(|a| a.id.as_str()));
    let unique: std::collections::HashSet<_> = all.iter().collect();
    assert_eq!(unique.len(), all.len());
}

#[test]
fn offers_a_scratchpad_only_with_a_workspace_and_no_rows_without_tabs() {
    let mut i = inputs(focused());
    i.rounds = vec![round("t1", "completed")];
    let actions: Vec<String> = derive_app_status(&i).actions.into_iter().map(|a| a.id).collect();
    assert_eq!(actions, ["open-workspace", "new-scratchpad", "settings"]);

    let mut welcome = inputs(Rc::new(Host::default()));
    welcome.rounds = vec![round("t1", "completed")];
    welcome.attention.overall = Some(AttentionKind::Bau);
    let status = derive_app_status(&welcome);
    assert!(status.sections.is_empty());
    assert_eq!(status.attention, None);
    let actions: Vec<String> = status.actions.into_iter().map(|a| a.id).collect();
    assert_eq!(actions, ["open-workspace", "settings"]);
}

// ─── app_status.rs ──────────────────────────────────────────────────────────

fn entry(label: &str, detail: Option<&str>) -> AppStatusEntry {
    AppStatusEntry { id: "prompts:t1".into(), label: label.into(), detail: detail.map(String::from), ..Default::default() }
}

#[test]
fn a_row_trails_its_note_like_the_sidebar() {
    assert_eq!(entry_text(&entry("Fix the tests", Some("queued"))), "Fix the tests  ·  queued");
    assert_eq!(entry_text(&entry("Fix the tests", Some(""))), "Fix the tests");
    assert_eq!(entry_text(&entry("Fix the tests", None)), "Fix the tests");
}

#[test]
fn only_our_items_map_back_to_an_app_id() {
    assert_eq!(activated_id(&item_id("sessions:task_a")), Some("sessions:task_a"));
    assert_eq!(activated_id("quit"), None);
}

#[test]
fn deserializes_the_adapter_wire_shape() {
    let status: AppStatus = serde_json::from_str(
        r#"{"attention":"attention-bau","sections":[{"id":"prompts","title":"Prompts",
            "entries":[{"id":"prompts:t1","label":"Fix","detail":null,"mark":"done"}]}],
            "actions":[{"id":"settings","label":"Settings"}]}"#,
    )
    .unwrap();
    assert_eq!(status.attention.as_deref(), Some("attention-bau"));
    assert_eq!(status.sections[0].entries[0].mark.as_deref(), Some("done"));
    assert_eq!(status.actions[0].id, "settings");
}

#[test]
fn every_glyph_has_an_image_and_unknown_ones_draw_plain() {
    for mark in [
        "starting", "running", "queued", "idle", "done", "cancelled", "error", "unavailable", "auth", "attention-bau",
        "attention-error", "document",
    ] {
        assert!(glyph(Some(mark)).is_some(), "{mark}");
    }
    assert!(glyph(Some("not-a-mark")).is_none());
    assert!(glyph(None).is_none());
}

// ─── tauri-adapter.ts publishAppStatus ─────────────────────────────────────

#[test]
fn a_republish_that_draws_the_same_only_swaps_the_callbacks() {
    let fake = notefig_platform::fake::FakePlatform::new();
    let api = create_app_status(Some(fake.platform.clone()));
    let draws = Rc::new(RefCell::new(0));
    let d = draws.clone();
    let _sub = api.subscribe(move || *d.borrow_mut() += 1);
    let first = focused();
    let mut i = inputs(first.clone());
    i.sessions = vec![session("task_a", "idle")];
    api.publish(derive_app_status(&i));
    let second = focused();
    i.host = second.clone();
    api.publish(derive_app_status(&i));
    assert_eq!(*draws.borrow(), 1, "an identical status is not redrawn");
    api.activate("sessions:task_a");
    assert!(first.calls.borrow().is_empty(), "the newest callbacks win");
    assert_eq!(*second.calls.borrow(), ["openAgent task_a"]);
    i.sessions[0].status = "running".into();
    i.sessions[0].is_running = true;
    api.publish(derive_app_status(&i));
    assert_eq!(*draws.borrow(), 2);
    assert_eq!(api.current().unwrap().sections[0].entries[0].mark.as_deref(), Some("running"));
}

#[test]
fn describes_a_session_as_its_sidebar_row() {
    let t = |key: &str, n: Option<u32>| match n {
        Some(n) => format!("{key}:{n}"),
        None => key.to_string(),
    };
    let mut s = session("a", "running");
    assert_eq!(describe_task_meta(&s, &t).as_deref(), Some("agentRunning"));
    s.queued_count = 2;
    assert_eq!(describe_task_meta(&s, &t).as_deref(), Some("agentRunningQueued:2"));
    s.needs_auth = true;
    assert_eq!(describe_task_meta(&s, &t).as_deref(), Some("agentNeedsSignIn"));
    assert_eq!(describe_task_meta(&session("b", "restored"), &t), None);
    assert_eq!(task_mark("restored", false), "idle");
    assert_eq!(task_mark("running", true), "auth");
    assert_eq!(project_name("/Users/x/book/"), "book");
}
