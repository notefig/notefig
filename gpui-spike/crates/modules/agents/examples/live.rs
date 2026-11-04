//! A live check of the agents module against a real harness, headless:
//!
//!   cargo run -p notefig-agents --example live -- <phase> <workspace> <state-dir> [harness]
//!
//! Phases:
//! - `chat`: trust, start a session, one turn that edits `notes.md` (the
//!   write arrives as ACP `fs/write_text_file` through the tool services),
//!   then print the transcript and the session's usage.
//! - `widget`: one in-document widget round on the same session; the
//!   harness answers through the app MCP server's `widget_respond` over the
//!   stdio relay, and the round's outcome is printed.
//! - `revive`: a new launch over the same state: the row comes back
//!   `restored`, revives through `session/load`, and its transcript replays.
//!
//! Core runs on the test executor, polled; the platform is the native one
//! with its db under `<state-dir>`. Never point it at real user folders.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::future::LocalBoxFuture;
use notefig_agents::*;
use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ExecutorExt, ModuleRef, Services};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakeUi;

struct Live {
    exec: Rc<TestExecutor>,
    core: Core,
}

impl Live {
    fn until(&self, what: &str, secs: u64, cond: impl Fn(&Live) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            self.exec.run_until_parked();
            if cond(self) {
                return;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for {what}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait<T: 'static>(&self, what: &str, fut: LocalBoxFuture<'static, T>) -> T {
        let slot: Rc<RefCell<Option<T>>> = Rc::default();
        let out = slot.clone();
        self.exec.spawn_local(async move {
            *out.borrow_mut() = Some(fut.await);
        });
        self.until(what, 240, |_| slot.borrow().is_some());
        slot.borrow_mut().take().unwrap()
    }

    fn agents(&self) -> Rc<AgentsModuleApi> {
        self.core.use_::<AgentsModule>()
    }

    fn store(&self) -> Rc<AgentStore> {
        self.core.use_::<AgentStoreModule>()
    }

    fn print_transcript(&self, task: &str) {
        for e in self.store().entries(task) {
            let body = match e.kind {
                EntryType::ToolCall => e.tool_call_view().map(|t| format!("{:?} [{:?}]", t.title, t.status)).unwrap_or_default(),
                EntryType::Plan => "(plan)".into(),
                _ => e.text.clone().unwrap_or_default(),
            };
            println!("  {:?}: {}", e.kind, body.chars().take(200).collect::<String>());
        }
        if let Some(usage) = self.store().task(task).and_then(|t| t.usage) {
            println!("  session usage: {usage:?}");
        }
    }
}

fn boot(state: &str) -> Live {
    let exec = TestExecutor::new();
    let platform = notefig_platform_native::native_platform(state.into(), exec.clone(), Rc::new(FakeUi::default()));
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(Rc::new(platform)).with::<notefig_layout::UrlService>(notefig_layout::MemoryUrl::new("")))
            .modules(vec![ModuleRef::of::<AgentsModule>()]),
    )
    .expect("core");
    core.boot();
    let live = Live { exec, core };
    live.until("the runtime", 30, |l| l.agents().is_ready());
    live
}

fn session_for(live: &Live, ws: &str, harness: &str) -> String {
    if let Some(row) = live.store().tasks_for_workspace(ws).into_iter().find(|t| t.status != TaskStatus::Unavailable) {
        return row.task_id;
    }
    let handle = live.agents().workspace(ws);
    handle.trust();
    let StartResult::Started { task_id } = live.wait("start", handle.start(harness)) else {
        panic!("could not start {harness}");
    };
    live.until("the session", 120, |l| {
        l.store().task(&task_id).is_some_and(|t| t.status != TaskStatus::Starting)
    });
    let row = live.store().task(&task_id).unwrap();
    println!("session {task_id}: {:?} model={:?}", row.status, row.current_model());
    // The cheapest model the harness offers, to keep the check cheap.
    if let Some(options) = &row.config_options
        && let Some(model) = options.iter().find(|o| o.category.as_deref() == Some("model"))
        && let Some(choice) = model.choices().into_iter().find(|c| c.name.to_lowercase().contains("haiku") || c.value.contains("haiku"))
    {
        let r = live.wait("model", live.agents().task(&task_id).set_config_option(&model.id, &choice.value));
        println!("model → {}: {r:?}", choice.value);
    }
    task_id
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--mcp-stdio-relay") {
        let port = notefig_agent::mcp::relay::relay_port_from_args(&args).expect("port");
        std::process::exit(notefig_agent::mcp::relay_main(port));
    }
    let [phase, ws, state, ..] = &args[..] else {
        eprintln!("usage: live <chat|widget|revive> <workspace> <state-dir> [harness]");
        std::process::exit(2);
    };
    let harness = args.get(3).cloned().unwrap_or_else(|| "claude-code".into());
    let live = boot(state);
    match phase.as_str() {
        "chat" => {
            let task = session_for(&live, ws, &harness);
            let prompt = "Append exactly one line `- added by the live check` to the end of notes.md using your edit tool. Do nothing else and reply in one short sentence.";
            let handle = live.wait("prompt", live.agents().task(&task).prompt(prompt, PromptExtras::default())).unwrap();
            let outcome = live.wait("turn", handle.completed);
            println!("chat turn: {outcome:?}");
            live.print_transcript(&task);
            let notes = std::fs::read_to_string(format!("{ws}/notes.md")).unwrap_or_default();
            println!("notes.md now ends with: {:?}", notes.lines().last());
        }
        "widget" => {
            let task = session_for(&live, ws, &harness);
            let source = WidgetPromptSource {
                workspace_path: ws.clone(),
                path: "notes.md".into(),
                pos: 1,
                is_doc_empty: false,
                reference: None,
            };
            let handle = live
                .wait(
                    "widget prompt",
                    live.agents().task(&task).prompt_from_widget(
                        "In one sentence, what is this document about?",
                        source,
                        PromptExtras::default(),
                    ),
                )
                .unwrap();
            let outcome = live.wait("widget turn", handle.completed);
            println!("widget turn: {outcome:?}");
            live.print_transcript(&task);
            let answered = live.store().entries(&task).iter().any(|e| {
                e.tool_call_view()
                    .is_some_and(|t| t.title.as_deref().unwrap_or("").contains("widget_respond") && format!("{:?}", t.status).to_lowercase().contains("completed"))
            });
            println!("widget_respond over the relay: {}", if answered { "ok" } else { "MISSING" });
        }
        "revive" => {
            let rows = live.store().tasks_for_workspace(ws);
            let row = rows.first().expect("a persisted session");
            println!("after restart: {} {:?} entries={}", row.task_id, row.status, live.store().entries(&row.task_id).len());
            let task = row.task_id.clone();
            live.agents().task(&task).revive();
            live.until("the revival", 120, |l| {
                l.store().task(&task).is_some_and(|t| matches!(t.status, TaskStatus::Idle | TaskStatus::Unavailable | TaskStatus::Error))
            });
            println!("revived: {:?}", live.store().task(&task).unwrap().status);
            live.print_transcript(&task);
        }
        other => panic!("unknown phase {other}"),
    }
    live.wait("shutdown", live.agents().dispose_all());
    live.exec.advance(Duration::from_millis(500));
}
