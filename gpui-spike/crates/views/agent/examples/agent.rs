//! The Sessions tool and a chat tab over a core with the native platform:
//!
//! ```text
//! NOTEFIG_AGENT_MOCK=1 NOTEFIG_STATE_DIR=<scratch> \
//! NOTEFIG_SCRIPT='wait:1500; shot:/abs/x.png; quit' \
//!   cargo run -p notefig-view-agent --example agent --features screenshot -- <scratch-ws>
//! ```
//!
//! - `NOTEFIG_PROMPTS='first||second'`: start one session per prompt (the
//!   workspace is trusted first) and send it; the last one is shown. A
//!   prompt may carry a mock scenario prefix (`@@mock:{"scenario":"tools"}`).
//! - `NOTEFIG_START=1` with no prompts: start one empty session.
//! - `NOTEFIG_THEME=light`: the light theme.
//!
//! Never point it at real folders: the state dir and workspace must be
//! scratch paths.

use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use gpui::{
    AppContext as _, AsyncApp, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowBounds,
    WindowOptions, div, px, size,
};
use notefig_agent::model::TaskStatus;
use notefig_agents::agent_events::{AgentOpenRequested, AgentOpenRequestedEvent};
use notefig_agents::{AgentStoreModule, AgentsModule, StartResult};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services, Subscription};
use notefig_files::FilesModule;
use notefig_kv::KvModule;
use notefig_layout::{MemoryUrl, UrlService};
use notefig_platform::{AppStatus, PlatformEvent, PlatformService, PlatformUi, TextPromptOptions};
use notefig_ui::{CoreExt as _, CoreGlobal, GpuiExecutor, NotefigAssets, TabStripTab, rem, sp, tokens};
use notefig_view_agent::{ChatTab, SessionsPanel};

/// No dialogs in this harness.
struct NoUi;
impl PlatformUi for NoUi {
    fn pick_directory(&self, _: &str) -> LocalBoxFuture<'static, Option<String>> {
        futures::future::ready(None).boxed_local()
    }
    fn prompt_text(&self, _: TextPromptOptions) -> LocalBoxFuture<'static, Option<String>> {
        futures::future::ready(None).boxed_local()
    }
    fn open_external(&self, _: &str) {}
    fn reveal_in_file_manager(&self, _: &str) {}
    fn toggle_fullscreen(&self) {}
    fn publish_app_status(&self, _: AppStatus) {}
    fn subscribe(&self, _: Box<dyn Fn(&PlatformEvent)>) -> Subscription {
        Subscription::none()
    }
}

/// The shell stand-in: the sessions tool in a sidebar card, the chat tab
/// in a pane with a one-tab strip.
struct Host {
    ws: String,
    panel: Entity<SessionsPanel>,
    chat: Option<Entity<ChatTab>>,
    _open: Subscription,
}

impl Host {
    fn show(&mut self, task_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.chat.as_ref().is_some_and(|c| c.read(cx).task_id() == task_id) {
            return;
        }
        let handle = cx.core().workspace(&self.ws);
        let id = task_id.to_string();
        self.chat = Some(cx.new(|cx| ChatTab::new(handle, id, window, cx)));
        cx.notify();
    }
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let gap = t.shell_gap;
        let tab = self.chat.as_ref().map(|chat| {
            let title = chat.read(cx).title(cx);
            let label: String = if title.chars().count() > 24 {
                format!("{}…", title.chars().take(23).collect::<String>())
            } else {
                title.to_string()
            };
            TabStripTab::new("chat-tab", label, true).on_close(|_, _, _| {})
        });
        div()
            .size_full()
            .flex()
            .gap(gap)
            .p(gap)
            .bg(t.background)
            .text_color(t.foreground)
            .font_family(notefig_ui::theme::FONT_SANS)
            .child(
                notefig_ui::card(cx)
                    .w(rem(15.))
                    .flex_none()
                    .h_full()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .child(
                        div()
                            .flex_none()
                            .h(t.header_height)
                            .px(sp(2.))
                            .flex()
                            .items_center()
                            .bg(t.chrome_wash)
                            .text_size(t.text_sm)
                            .child("Sessions"),
                    )
                    .child(self.panel.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .gap(gap)
                    .child(
                        notefig_ui::card(cx)
                            .flex_none()
                            .h(t.header_height)
                            .flex()
                            .bg(t.chrome_wash)
                            .overflow_hidden()
                            .children(tab),
                    )
                    .child(div().flex_1().min_h_0().flex().children(self.chat.clone())),
            )
    }
}

fn main() {
    env_logger_init();
    let ws = std::env::args().nth(1).expect("usage: agent <scratch-workspace>");
    let ws = std::fs::canonicalize(&ws).map(|p| p.to_string_lossy().into_owned()).unwrap_or(ws);
    let state = PathBuf::from(std::env::var("NOTEFIG_STATE_DIR").expect("set NOTEFIG_STATE_DIR to a scratch dir"));
    let prompts: Vec<String> = std::env::var("NOTEFIG_PROMPTS")
        .map(|p| p.split("||").map(str::to_string).filter(|p| !p.trim().is_empty()).collect())
        .unwrap_or_default();
    let start_empty = std::env::var_os("NOTEFIG_START").is_some();
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        let dark = std::env::var("NOTEFIG_THEME").map(|v| v != "light").unwrap_or(true);
        notefig_ui::set_appearance(Some(dark), None, cx);
        let executor = GpuiExecutor::new(cx);
        let platform = notefig_platform_native::native_platform(state.clone(), executor.clone(), Rc::new(NoUi));
        let core = Core::new(
            CreateCoreOptions::new(executor)
                .services(
                    Services::new()
                        .with::<PlatformService>(Rc::new(platform))
                        .with::<UrlService>(MemoryUrl::new("")),
                )
                .modules(vec![
                    ModuleRef::of::<KvModule>(),
                    ModuleRef::of::<FilesModule>(),
                    ModuleRef::of::<AgentsModule>(),
                    ModuleRef::of::<notefig_dictation::DictationModule>(),
                ]),
        )
        .expect("core");
        core.boot();
        cx.set_global(CoreGlobal(core));
        notefig_view_agent::init(cx);
        let open = cx.core().workspace(&ws).open();
        let ws2 = ws.clone();
        cx.spawn(async move |cx| {
            open.await.expect("open workspace");
            let host = cx
                .update(|cx| {
                    let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
                    let (window, host) = gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(bounds)),
                            // NOTEFIG_HEADLESS=1: never shown or focused; `shot:` still renders.
                            show: std::env::var_os("NOTEFIG_HEADLESS").is_none(),
                            focus: std::env::var_os("NOTEFIG_HEADLESS").is_none(),
                            ..Default::default()
                        },
                        cx,
                        |window, cx| {
                            let handle = cx.core().workspace(&ws2);
                            let panel = cx.new(|cx| SessionsPanel::new(handle, window, cx));
                            let ws3 = ws2.clone();
                            cx.new(|cx| {
                                // `task(id).open()` → show it (the shell's tabs do this).
                                let (tx, rx) = async_channel::unbounded::<String>();
                                let sub = cx.core().hooks().on::<AgentOpenRequested, _>(move |e: &AgentOpenRequestedEvent| {
                                    let _ = tx.try_send(e.task_id.clone());
                                });
                                cx.spawn_in(window, async move |this, cx| {
                                    while let Ok(task) = rx.recv().await {
                                        let _ = this.update_in(cx, |this: &mut Host, window, cx| this.show(&task, window, cx));
                                    }
                                })
                                .detach();
                                Host { ws: ws3, panel, chat: None, _open: sub }
                            })
                        },
                    )
                    .expect("window");
                    notefig_ui::driver::run_from_env(window, cx);
                    host
                });
            if prompts.is_empty() && !start_empty {
                // Show the most recent session, if any.
                let agents = cx.update(|cx| cx.core().use_::<AgentsModule>());
                agents.when_reconciled().await;
                let latest = cx.update(|cx| {
                    cx.core().use_::<AgentStoreModule>().tasks_for_workspace(&ws).first().map(|t| t.task_id.clone())
                });
                if let Some(task) = latest {
                    let _ = cx.update(|cx| cx.core().use_::<AgentsModule>().task(&task).open());
                }
                return;
            }
            let list = if prompts.is_empty() { vec![String::new()] } else { prompts };
            for prompt in list {
                if let Err(err) = start_and_prompt(cx, &ws, &prompt).await {
                    eprintln!("agent example: {err}");
                }
            }
            drop(host);
        })
        .detach();
    });
}

/// Trust the workspace, start a session on the default harness, show it,
/// and send `prompt` once the session is up.
async fn start_and_prompt(cx: &mut AsyncApp, ws: &str, prompt: &str) -> Result<(), String> {
    let agents = cx.update(|cx| cx.core().use_::<AgentsModule>());
    agents.when_reconciled().await;
    let harness = agents.default_harness(ws).ok_or("no harness")?;
    let handle = agents.workspace(ws);
    handle.trust();
    let task_id = match handle.start(&harness).await {
        StartResult::Started { task_id } => task_id,
        other => return Err(format!("start: {other:?}")),
    };
    agents.task(&task_id).open();
    if prompt.is_empty() {
        return Ok(());
    }
    // Wait for the session to come up.
    for _ in 0..200 {
        let status = cx.update(|cx| cx.core().use_::<AgentStoreModule>().task(&task_id).map(|r| r.status));
        if matches!(status, Some(TaskStatus::Idle) | Some(TaskStatus::Running)) {
            break;
        }
        cx.background_executor().timer(Duration::from_millis(50)).await;
    }
    let _ = cx.update(|cx| {
        let (text, extras) = notefig_view_agent::prompt_to_send(cx, ws, &task_id, &harness, prompt);
        let pending = cx.core().use_::<AgentsModule>().task(&task_id).prompt(&text, extras);
        cx.foreground_executor().spawn(pending).detach();
    });
    Ok(())
}

fn env_logger_init() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Warn
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("[{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    let _ = log::set_logger(&Stderr).map(|()| log::set_max_level(log::LevelFilter::Warn));
}
