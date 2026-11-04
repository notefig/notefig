//! `usePublishAppStatus` (`hooks/use-app-status.ts`): keeps
//! `core.appStatus` told the current status, from the same state the
//! sidebar reads — the prompt rounds, the newest sessions and documents,
//! the focused workspace — republishing whenever any of them changes
//! (coalesced to one derive per turn). Publishing is cheap: a status that
//! draws the same is only a callback swap.
//!
//! Attention (the dot and the "needs attention" rows) comes from
//! `core.attention` (`useAttention()`).

use std::rc::Rc;

use gpui::{App, AsyncApp};
use notefig_agents::AgentStoreModule;
use notefig_app_status::{
    APP_STATUS_ROWS, AppStatusHost, AppStatusInputs, AppStatusModule, Attention, AttentionItem, AttentionKind,
    AttentionTarget, DocumentRow, RoundRow, SessionRow,
    derive_app_status,
};
use notefig_core::Core;
use notefig_prompt_rounds::PromptRoundsModule;
use notefig_recent_documents::RecentDocumentsModule;
use notefig_scratchpads::ScratchpadsModule;
use notefig_tabs::{OpenTabOptions, TabsModule};
use notefig_ui::CoreExt as _;
use notefig_view_agent::{TabsJumper, jump_to_round, jump_to_task};
use notefig_workspaces::WorkspacesModule;

/// What picking a row does, over the app.
struct Host {
    core: Core,
    cx: AsyncApp,
    focused: Option<String>,
}

impl Host {
    fn jumper(&self) -> TabsJumper {
        TabsJumper::new(&self.core)
    }

    fn with_window(&self, f: impl FnOnce(&mut gpui::Window, &mut App) + 'static) {
        self.cx.update(|cx| {
            if let Some(w) = cx.active_window().or_else(|| cx.windows().first().copied()) {
                let _ = w.update(cx, |_, window, cx| f(window, cx));
            }
        });
    }
}

impl AppStatusHost for Host {
    fn has_tabs(&self) -> bool {
        self.focused.is_some()
    }
    fn has_scratchpads(&self) -> bool {
        self.focused.as_ref().is_some_and(|ws| self.core.workspace(ws).get::<ScratchpadsModule>().is_ok())
    }
    fn open_document(&self, path: &str) {
        self.core.use_::<TabsModule>().open(path, OpenTabOptions::default());
    }
    fn open_agent(&self, task_id: &str) {
        self.core.use_::<TabsModule>().open_agent(task_id);
    }
    fn jump_to_round(&self, task_id: &str, turn_id: &str, document_path: &str) {
        jump_to_round(&self.jumper(), task_id, turn_id, document_path);
    }
    fn jump_to_task(&self, task_id: &str, turn_id: Option<&str>) {
        jump_to_task(&self.jumper(), task_id, turn_id);
    }
    fn new_scratchpad(&self) {
        let Some(ws) = &self.focused else { return };
        if let Ok(scratchpads) = self.core.workspace(ws).get::<ScratchpadsModule>() {
            let creating = scratchpads.create_and_open();
            self.cx.foreground_executor().spawn(creating).detach();
        }
    }
    fn open_workspace(&self) {
        let opening = notefig_view_welcome::open_project_from_picker(&self.core);
        self.cx
            .foreground_executor()
            .spawn(async move {
                opening.await;
            })
            .detach();
    }
    fn open_settings(&self) {
        self.with_window(|window, cx| notefig_view_settings::open_settings(None, window, cx));
    }
}

fn round_status(row: &notefig_prompt_rounds::PromptRoundRow) -> String {
    serde_json::to_value(&row.status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .map(|s| if s == "live" { "running".to_string() } else { s })
        .unwrap_or_else(|| "completed".into())
}

fn task_status(status: &impl serde::Serialize) -> String {
    serde_json::to_value(status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn kind(kind: notefig_attention::AttentionKind) -> AttentionKind {
    match kind {
        notefig_attention::AttentionKind::Bau => AttentionKind::Bau,
        notefig_attention::AttentionKind::Error => AttentionKind::Error,
    }
}

/// `useAttention()`, in the shape `deriveAppStatus` reads.
fn attention(core: &Core) -> Attention {
    let a = core.use_::<notefig_attention::AttentionModule>().get();
    Attention {
        items: a
            .items
            .iter()
            .map(|item| AttentionItem {
                target: match &item.target {
                    notefig_seen::SeenTarget::Document(path) => AttentionTarget::Document(path.clone()),
                    notefig_seen::SeenTarget::Task(id) => AttentionTarget::Task(id.clone()),
                },
                kind: kind(item.kind),
                task_id: item.task_id.clone(),
                turn_id: item.turn_id.clone(),
                workspace_key: item.workspace_key.clone(),
                task_title: item.task.as_ref().map(|t| t.title.clone()),
            })
            .collect(),
        overall: a.overall.map(kind),
        by_round: a.by_round.iter().map(|(k, v)| (k.clone(), kind(*v))).collect(),
        by_task: a.by_task.iter().map(|(k, v)| (k.clone(), kind(*v))).collect(),
    }
}

/// Derive and publish once, from what the modules hold now.
fn publish(cx: &mut App) {
    let core = cx.core();
    let focused = core.use_::<WorkspacesModule>().focused();
    let mut rounds: Vec<RoundRow> = core
        .use_::<PromptRoundsModule>()
        .rounds()
        .into_iter()
        .map(|r| RoundRow {
            status: round_status(&r),
            turn_id: r.turn_id,
            task_id: r.task_id,
            document_path: r.document_path,
            prompt: r.prompt,
        })
        .collect();
    // Live first, then newest (the turn ids sort by time).
    rounds.sort_by(|a, b| b.is_live().cmp(&a.is_live()).then_with(|| b.turn_id.cmp(&a.turn_id)));
    let mut tasks = core.use_::<AgentStoreModule>().tasks();
    tasks.retain(|t| t.parent_task_id.is_none());
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let sessions = tasks
        .into_iter()
        .take(APP_STATUS_ROWS)
        .map(|t| {
            let status = task_status(&t.status);
            SessionRow {
                is_running: status == "running",
                is_error: status == "error",
                is_unavailable: status == "unavailable",
                needs_auth: t.auth_required,
                auth_required: t.auth_required,
                task_id: t.task_id,
                workspace_path: t.workspace_path,
                title: t.title,
                status,
                queued_count: 0,
            }
        })
        .collect();
    let documents = core
        .use_::<RecentDocumentsModule>()
        .recent(&core, APP_STATUS_ROWS)
        .into_iter()
        .map(|d| DocumentRow { path: d.path, workspace_path: d.workspace_path })
        .collect();
    let host = Rc::new(Host { core: core.clone(), cx: cx.to_async(), focused });
    let status = derive_app_status(&AppStatusInputs {
        host,
        rounds,
        sessions,
        documents,
        attention: attention(&core),
        t: Rc::new(|key, count| match count {
            Some(n) => notefig_i18n::t_count(key, n as i64),
            None => notefig_i18n::t(key),
        }),
    });
    // Headless runs check the menu through its model: NOTEFIG_APP_STATUS_DUMP
    // names a file each published status is written to, as JSON.
    if let Some(path) = std::env::var_os("NOTEFIG_APP_STATUS_DUMP")
        && let Ok(json) = serde_json::to_string_pretty(&status)
    {
        let _ = std::fs::write(path, json);
    }
    core.use_::<AppStatusModule>().publish(status);
}

/// Start publishing; kept for the life of the app.
pub fn start(cx: &mut App) {
    let core = cx.core();
    let (tx, rx) = async_channel::bounded::<()>(1);
    let poke = move || {
        let _ = tx.try_send(());
    };
    let subs = vec![
        core.use_::<PromptRoundsModule>().subscribe({
            let poke = poke.clone();
            move || poke()
        }),
        core.use_::<AgentStoreModule>().subscribe({
            let poke = poke.clone();
            move || poke()
        }),
        core.use_::<RecentDocumentsModule>().subscribe({
            let poke = poke.clone();
            move || poke()
        }),
        core.use_::<notefig_attention::AttentionModule>().subscribe({
            let poke = poke.clone();
            move || poke()
        }),
        core.use_::<WorkspacesModule>().subscribe({
            let poke = poke.clone();
            move || poke()
        }),
    ];
    poke();
    cx.spawn(async move |cx| {
        let _subs = subs;
        while rx.recv().await.is_ok() {
            cx.update(publish);
        }
    })
    .detach();
}
