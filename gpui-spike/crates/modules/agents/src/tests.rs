//! The agents module over core, the fake platform and the mock harness:
//! ports of `__tests__/agents.test.ts` (facade, trust gate),
//! `agent-collections.test.ts` / `agent-persistence.test.ts` (rows
//! persisted to the db, reconciled on the next boot),
//! `agent-tasks-hooks.test.ts` (the `agent:*` moments) and
//! `__tests__/mock-harness.test.ts` (scenarios through the real runtime).
//! The runtime's own suite (over a scripted fake agent) is
//! `runtime/tests_fake_agent.rs`.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ExecutorExt, ModuleRef, Services, Subscription};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;

use crate::agent_events::*;
use crate::*;

struct Env {
    exec: Rc<TestExecutor>,
    core: Core,
    fake: FakePlatform,
    ws: String,
    _dir: Rc<tempfile::TempDir>,
}

fn boot_over(fake: FakePlatform, dir: Rc<tempfile::TempDir>) -> Env {
    // SAFETY: every test sets the same values.
    unsafe {
        std::env::set_var("NOTEFIG_AGENT_MOCK", "1");
        std::env::remove_var("NOTEFIG_NO_AGENTS");
    }
    let exec = TestExecutor::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()).with::<notefig_layout::UrlService>(notefig_layout::MemoryUrl::new("")))
            .modules(vec![ModuleRef::of::<AgentsModule>()]),
    )
    .unwrap();
    core.boot();
    let ws = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
    let env = Env { exec, core, fake, ws, _dir: dir };
    env.until(|e| e.agents().is_ready());
    env
}

fn boot() -> Env {
    boot_over(FakePlatform::new(), Rc::new(tempfile::tempdir().unwrap()))
}

impl Env {
    fn agents(&self) -> Rc<AgentsModuleApi> {
        self.core.use_::<AgentsModule>()
    }

    fn store(&self) -> Rc<AgentStore> {
        self.core.use_::<AgentStoreModule>()
    }

    /// Run the executor (the runtime is another thread) until `cond`.
    fn until(&self, cond: impl Fn(&Env) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
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

    fn start(&self) -> String {
        let ws = self.agents().workspace(&self.ws);
        if self.wait(ws.start("claude-code")) == StartResult::NeedsTrust {
            ws.trust();
        }
        match self.wait(ws.start("claude-code")) {
            StartResult::Started { task_id } => {
                self.until(|e| e.store().task(&task_id).is_some_and(|t| t.status == TaskStatus::Idle));
                task_id
            }
            other => panic!("not started: {other:?}"),
        }
    }

    /// Prompt and wait for the turn to settle.
    fn prompt(&self, task: &str, text: &str) -> TurnOutcome {
        let handle = self.wait(self.agents().task(task).prompt(text, PromptExtras::default())).unwrap();
        self.wait(handle.completed).expect("settled")
    }

    fn texts(&self, task: &str) -> Vec<(EntryType, String)> {
        self.store()
            .entries(task)
            .into_iter()
            .map(|e| (e.kind, e.text.clone().unwrap_or_default()))
            .collect()
    }
}

#[test]
fn the_first_session_in_a_workspace_needs_trust_and_trust_persists_in_kv() {
    let env = boot();
    let ws = env.agents().workspace(&env.ws);
    assert!(!ws.is_trusted());
    assert_eq!(env.wait(ws.start("claude-code")), StartResult::NeedsTrust);
    ws.trust();
    assert!(ws.is_trusted());
    assert!(matches!(env.wait(ws.start("claude-code")), StartResult::Started { .. }));
    env.until(|e| e.fake.db.snapshot("kv:agent").keys().any(|k| k.starts_with("trust:")));
}

#[test]
fn an_unknown_harness_is_refused() {
    let env = boot();
    let ws = env.agents().workspace(&env.ws);
    ws.trust();
    assert_eq!(env.wait(ws.start("no-such-harness")), StartResult::UnknownHarness);
}

#[test]
fn an_echo_turn_streams_the_reply_and_records_session_usage() {
    let env = boot();
    let task = env.start();
    let outcome = env.prompt(&task, "hello there");
    assert!(matches!(outcome, TurnOutcome::Completed { .. }), "{outcome:?}");
    let texts = env.texts(&task);
    assert_eq!(texts[0], (EntryType::User, "hello there".into()));
    assert!(texts[1].1.contains("You said:"), "{texts:?}");
    assert!(texts[1].1.contains("Mock harness reporting in."));
    let usage = env.store().task(&task).unwrap().usage.expect("session usage on the row");
    assert!(usage.total.cost.is_some(), "cost reported: {usage:?}");
}

#[test]
fn settled_turns_announce_usage_settle_and_completion_on_the_hook_bus() {
    let env = boot();
    let seen: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let s = (seen.clone(), seen.clone(), seen.clone(), seen.clone());
    let _subs = Subscription::join(vec![
        env.core.hooks().on::<AgentTurnSettled, _>(move |_| s.0.borrow_mut().push("settled")),
        env.core.hooks().on::<AgentUsage, _>(move |_| s.1.borrow_mut().push("usage")),
        env.core.hooks().on::<AgentTurnCompleted, _>(move |_| s.2.borrow_mut().push("completed")),
        env.core.hooks().on::<AgentUsageLimits, _>(move |_| s.3.borrow_mut().push("limits")),
    ]);
    let task = env.start();
    env.prompt(&task, "hi");
    env.until(|_| seen.borrow().contains(&"settled") && seen.borrow().contains(&"usage"));
    let seen = seen.borrow();
    assert!(seen.contains(&"completed"));
    assert!(seen.contains(&"limits"), "the echo reports Claude-shaped limits");
}

#[test]
fn task_rows_persist_to_the_platform_db_and_come_back_restored() {
    let dir = Rc::new(tempfile::tempdir().unwrap());
    let fake = FakePlatform::new();
    let task = {
        let env = boot_over(clone_platform(&fake), dir.clone());
        let task = env.start();
        env.prompt(&task, "remember me");
        env.until(|e| {
            e.fake
                .db
                .snapshot(agent_store::TASKS_COLLECTION)
                .get(&task)
                .is_some_and(|row| row["sessionId"].is_string() && row.get("usage").is_some())
        });
        env.wait(env.agents().dispose_all());
        task
    };
    // A new launch over the same db.
    let env = boot_over(clone_platform(&fake), dir);
    let row = env.store().task(&task).expect("row came back");
    assert_eq!(row.status, TaskStatus::Restored);
    assert!(row.usage.is_some(), "the session total survives a restart");
}

#[test]
fn a_tools_turn_writes_through_the_tool_services_and_reports_its_calls() {
    let env = boot();
    let readme = format!("{}/README.md", env.ws);
    env.fake.fs.seed(&readme, "# Demo\n");
    let calls: Rc<RefCell<Vec<String>>> = Rc::default();
    let c = calls.clone();
    let _sub = env.core.hooks().on::<AgentToolCall, _>(move |e| {
        c.borrow_mut().push(format!(
            "{}:{}",
            e.tool_call["toolCallId"].as_str().unwrap_or(""),
            e.tool_call["status"].as_str().unwrap_or("")
        ))
    });
    let task = env.start();
    env.prompt(&task, "@@mock:{\"scenario\":\"tools\",\"options\":{\"path\":\"README.md\"}} add a note");
    assert_eq!(env.fake.fs.read(&readme).unwrap(), "# Demo\n\nAdded by the mock agent.\n");
    let types: Vec<EntryType> = env.store().entries(&task).iter().map(|e| e.kind).collect();
    assert!(types.contains(&EntryType::Thought));
    assert!(types.contains(&EntryType::Plan));
    assert!(types.contains(&EntryType::ToolCall));
    let calls = calls.borrow();
    assert!(calls.contains(&"call_edit:completed".to_string()), "{calls:?}");
}

#[test]
fn a_call_without_an_allow_option_waits_on_the_user() {
    let env = boot();
    let task = env.start();
    let handle = env
        .wait(env.agents().task(&task).prompt("@@mock:{\"scenario\":\"permission\"}", PromptExtras::default()))
        .unwrap();
    env.until(|e| !e.store().pending_permissions(&task).is_empty());
    let request = env.store().pending_permissions(&task).remove(0);
    assert_eq!(request.title, "Run rm -rf build/");
    let options: Vec<&str> = request.options.iter().map(|o| o.name.as_str()).collect();
    assert_eq!(options, vec!["Not now", "Never"]);
    env.wait(env.agents().task(&task).respond_permission(
        &request.id,
        PermissionOutcome::Selected("reject".into()),
    ))
    .unwrap();
    env.wait(handle.completed);
    assert!(env.texts(&task).last().unwrap().1.contains("I won't run it"));
    assert!(env.store().pending_permissions(&task).is_empty());
}

#[test]
fn queued_prompts_wait_and_cancel_settles_the_running_turn_and_the_queue() {
    let env = boot();
    let task = env.start();
    let agents = env.agents();
    let first = env
        .wait(agents.task(&task).prompt("@@mock:{\"scenario\":\"slow\",\"options\":{\"ms\":200}}", PromptExtras::default()))
        .unwrap();
    let second = env.wait(agents.task(&task).prompt("second", PromptExtras::default())).unwrap();
    env.until(|e| e.store().turn(&second.turn_id).is_some_and(|t| t.status == TurnStatus::Queued));
    env.wait(agents.task(&task).cancel()).unwrap();
    assert!(matches!(env.wait(first.completed), Some(TurnOutcome::Cancelled)));
    assert!(matches!(env.wait(second.completed), Some(TurnOutcome::Cancelled)));
}

#[test]
fn an_auth_failure_holds_the_prompt_until_the_user_signs_in() {
    let env = boot();
    let task = env.start();
    let handle = env
        .wait(env.agents().task(&task).prompt("@@mock:{\"scenario\":\"auth\"}", PromptExtras::default()))
        .unwrap();
    let turn = handle.turn_id.clone();
    env.until(|e| e.store().task(&task).is_some_and(|t| t.auth_required));
    env.wait(env.agents().task(&task).authenticate("mock-login")).unwrap();
    // As TS: the failed turn's handle settles with the error; the held
    // turn re-runs under the same turn id and completes.
    assert!(matches!(env.wait(handle.completed), Some(TurnOutcome::Error(_))));
    env.until(|e| e.store().turn(&turn).is_some_and(|t| t.status == TurnStatus::Completed));
    let users = env.texts(&task).iter().filter(|(k, _)| *k == EntryType::User).count();
    assert_eq!(users, 1, "the retry reuses the original transcript rows");
    assert!(!env.store().task(&task).unwrap().auth_required);
}

#[test]
fn switching_a_session_setting_reaches_the_harness_and_the_row() {
    let env = boot();
    let task = env.start();
    env.until(|e| e.store().task(&task).is_some_and(|t| t.config_options.is_some()));
    env.wait(env.agents().task(&task).set_config_option("model", "sonnet")).unwrap();
    env.until(|e| e.store().task(&task).and_then(|t| t.current_model()).as_deref() == Some("sonnet"));
}

#[test]
fn deleting_a_task_drops_its_rows_from_the_store_and_the_db() {
    let env = boot();
    let task = env.start();
    env.prompt(&task, "bye");
    env.wait(env.agents().task(&task).delete());
    assert!(env.store().task(&task).is_none());
    assert!(env.store().entries(&task).is_empty());
    env.until(|e| !e.fake.db.snapshot(agent_store::TASKS_COLLECTION).contains_key(&task));
}

/// A second launch over the same db, with a fresh fs.
fn clone_platform(fake: &FakePlatform) -> FakePlatform {
    let fresh = FakePlatform::new();
    let platform = Rc::new(notefig_platform::Platform {
        fs: fresh.platform.fs.clone(),
        db: fake.db.clone(),
        ui: fresh.platform.ui.clone(),
        updates: fresh.platform.updates.clone(),
        app_data_dir: fresh.platform.app_data_dir.clone(),
    });
    FakePlatform {
        platform,
        fs: fresh.fs,
        db: fake.db.clone(),
        ui: fresh.ui,
    }
}

#[test]
fn a_revived_widget_prompt_replays_without_its_context_link_line() {
    let env = boot();
    let task = env.start();
    let source = WidgetPromptSource {
        workspace_path: env.ws.clone(),
        path: "notes.md".into(),
        pos: 1,
        is_doc_empty: false,
        reference: None,
    };
    let handle = env
        .wait(env.agents().task(&task).prompt_from_widget("what is this?", source, PromptExtras::default()))
        .unwrap();
    env.wait(handle.completed);
    // Refresh: session/close + session/load replays the history.
    env.wait(env.agents().task(&task).refresh()).unwrap();
    env.until(|e| e.store().task(&task).is_some_and(|t| t.status == TaskStatus::Idle));
    let users: Vec<String> =
        env.texts(&task).into_iter().filter(|(k, _)| *k == EntryType::User).map(|(_, t)| t).collect();
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(!users[0].starts_with("notefig://"));
}

#[test]
fn a_widget_scenario_answers_through_the_app_mcp_server() {
    let env = boot();
    let task = env.start();
    env.prompt(&task, "@@mock:{\"scenario\":\"widget\"} what is this?");
    let calls: Vec<(Option<String>, Option<String>)> = env
        .store()
        .entries(&task)
        .iter()
        .filter_map(|e| e.tool_call_view())
        .map(|t| (t.title, t.status))
        .collect();
    let texts = env.texts(&task);
    assert!(
        calls.iter().any(|(title, status)| title.as_deref().is_some_and(|t| t.contains("widget_respond"))
            && status.as_deref() == Some("completed")),
        "{calls:?} {texts:?}"
    );
}
