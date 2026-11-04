//! The shared per-workspace session every prompt widget queues into (TS
//! `core.sharedSessions`, `modules/shared-sessions`): started lazily on the
//! first widget send with the default harness, reused across widgets (the
//! task FIFO-queues turns), dropped by "new conversation", adopted by the
//! session picker.
//!
//! Deviation: `crates/modules/shared-sessions` is not ported yet, so the
//! same rules live here as an app global over `core.agents` and
//! `core.agentStore`; move onto that module once it lands. The runtime
//! queues a prompt until its session is up, so `get_or_start` doesn't wait
//! for the handshake as TS does.

use std::collections::HashMap;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use gpui::{App, Global};
use notefig_agent::model::TaskStatus;
use notefig_agents::{AgentStoreModule, AgentsModule, StartResult};
use notefig_ui::CoreExt as _;

#[derive(Default)]
struct SharedSessions(HashMap<String, String>);
impl Global for SharedSessions {}

fn key(workspace_path: &str) -> String {
    workspace_path.trim_end_matches(['/', '\\']).to_string()
}

/// A cached session is reusable only while its row is live ("restored"
/// counts: prompting it revives it).
fn is_live(task_id: &str, cx: &App) -> bool {
    cx.core().use_::<AgentStoreModule>().task(task_id).is_some_and(|row| {
        !matches!(row.status, TaskStatus::Error | TaskStatus::Cancelled | TaskStatus::Unavailable)
    })
}

/// `peek`: the live shared session, for rendering.
pub fn peek(workspace_path: &str, cx: &App) -> Option<String> {
    let id = cx.try_global::<SharedSessions>()?.0.get(&key(workspace_path))?.clone();
    is_live(&id, cx).then_some(id)
}

/// `drop`: the next send starts a fresh session. The old one keeps running.
pub fn drop_session(workspace_path: &str, cx: &mut App) {
    cx.default_global::<SharedSessions>().0.remove(&key(workspace_path));
}

/// `adopt`: point the shared session at an existing live task.
pub fn adopt(workspace_path: &str, task_id: &str, cx: &mut App) {
    if is_live(task_id, cx) {
        cx.default_global::<SharedSessions>().0.insert(key(workspace_path), task_id.to_string());
    }
}

/// `getOrStart(ws, harness)`: the session prompts go to, started if needed.
/// The workspace's trust gate has been answered by the widget before this.
pub fn get_or_start(workspace_path: &str, harness_id: &str, cx: &mut App) -> LocalBoxFuture<'static, Result<String, String>> {
    if let Some(id) = peek(workspace_path, cx) {
        return futures::future::ready(Ok(id)).boxed_local();
    }
    let agents = cx.core().use_::<AgentsModule>();
    let ws = agents.workspace(workspace_path);
    let started = ws.start(harness_id);
    let k = key(workspace_path);
    let harness = harness_id.to_string();
    let cx = cx.to_async();
    async move {
        let task_id = match started.await {
            StartResult::Started { task_id } => task_id,
            StartResult::NeedsTrust => {
                ws.trust();
                match ws.start(&harness).await {
                    StartResult::Started { task_id } => task_id,
                    other => return Err(format!("couldn't start a session: {other:?}")),
                }
            }
            StartResult::UnknownHarness => return Err("no agent harness is available".into()),
        };
        let id = task_id.clone();
        let _ = cx.update(move |cx| {
            cx.default_global::<SharedSessions>().0.insert(k, id);
        });
        Ok(task_id)
    }
    .boxed_local()
}
