//! The shared per-workspace session every in-document prompt widget queues
//! into: a port of `packages/desktop/src/modules/shared-sessions/` —
//! `core.sharedSessions`.
//!
//! Lazily started on the first widget send and reused across every widget
//! (the agent task already FIFO-queues turns). The rotate control drops it;
//! the old task is never cancelled here. Kept for the app's run.
//!
//! Deviation: TS's `startTask` hands the task id back synchronously; here
//! the runtime is another thread, so the id arrives with the first await.
//! A start in flight is kept as the session (and counts as live) so
//! concurrent sends still share one task, as in TS.

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_agent::model::{AgentTaskRow, TaskStatus};
use notefig_agents::{AgentStoreModule, AgentsModule, StartedTask};
use notefig_core::{Module, ModuleContext, ModuleRef};
use notefig_files::paths::workspace_key;

type Started = Shared<LocalBoxFuture<'static, Result<String, String>>>;

#[derive(Clone)]
struct SharedSession {
    /// Known once the task row exists.
    task_id: Rc<RefCell<Option<String>>>,
    /// Resolves with the task id once it can be prompted.
    started: Started,
}

/// What `createSharedSessions` is handed.
pub struct SharedSessionsDeps {
    /// `agents.workspace(ws).startTask(harness)`.
    pub start_task: Rc<dyn Fn(&str, &str) -> LocalBoxFuture<'static, Result<StartedTask, String>>>,
    /// `agentStore.tasks.get`.
    pub task: Rc<dyn Fn(&str) -> Option<AgentTaskRow>>,
}

struct Inner {
    deps: SharedSessionsDeps,
    sessions: RefCell<HashMap<String, SharedSession>>,
}

/// `SharedSessionsApi` — `core.sharedSessions`.
#[derive(Clone)]
pub struct SharedSessionsApi {
    inner: Rc<Inner>,
}

/// `createSharedSessions(deps)`.
pub fn create_shared_sessions(deps: SharedSessionsDeps) -> SharedSessionsApi {
    SharedSessionsApi { inner: Rc::new(Inner { deps, sessions: RefCell::default() }) }
}

impl Inner {
    /// A cached session is reusable only while its task row is live;
    /// `restored` counts (prompting it revives the session).
    fn is_live(&self, task_id: &str) -> bool {
        (self.deps.task)(task_id)
            .is_some_and(|row| !matches!(row.status, TaskStatus::Error | TaskStatus::Cancelled | TaskStatus::Unavailable))
    }

    fn session_live(&self, session: &SharedSession) -> bool {
        match session.task_id.borrow().as_deref() {
            Some(id) => self.is_live(id),
            // Still starting, unless the start already failed.
            None => !matches!(session.started.peek(), Some(Err(_))),
        }
    }
}

impl SharedSessionsApi {
    /// The session widget prompts should target, starting one if needed;
    /// resolves once it can be prompted.
    pub fn get_or_start(&self, workspace_path: &str, harness_id: &str) -> LocalBoxFuture<'static, Result<String, String>> {
        let key = workspace_key(workspace_path);
        let current = self.inner.sessions.borrow().get(&key).cloned();
        let session = match current.filter(|s| self.inner.session_live(s)) {
            Some(session) => session,
            None => {
                let task_id: Rc<RefCell<Option<String>>> = Rc::default();
                let slot = task_id.clone();
                let start = (self.inner.deps.start_task)(workspace_path, harness_id);
                let started = async move {
                    let StartedTask { task_id, started } = start.await?;
                    *slot.borrow_mut() = Some(task_id.clone());
                    started.await?;
                    Ok(task_id)
                }
                .boxed_local()
                .shared();
                let session = SharedSession { task_id, started };
                self.inner.sessions.borrow_mut().insert(key, session.clone());
                session
            }
        };
        session.started.boxed_local()
    }

    /// Forget the shared session: the next send starts a fresh one. No
    /// eager spawn; the old task is not cancelled.
    pub fn drop_session(&self, workspace_path: &str) {
        self.inner.sessions.borrow_mut().remove(&workspace_key(workspace_path));
    }

    /// Point the shared session at an existing live task (the session
    /// picker). No-op if the row is missing or terminal.
    pub fn adopt(&self, workspace_path: &str, task_id: &str) {
        if !self.inner.is_live(task_id) {
            return;
        }
        let id = task_id.to_string();
        let started = futures::future::ready(Ok(id.clone())).boxed_local().shared();
        self.inner.sessions.borrow_mut().insert(
            workspace_key(workspace_path),
            SharedSession { task_id: Rc::new(RefCell::new(Some(id))), started },
        );
    }

    /// The current shared session's task id, if one is live (rendering only).
    pub fn peek(&self, workspace_path: &str) -> Option<String> {
        let session = self.inner.sessions.borrow().get(&workspace_key(workspace_path)).cloned()?;
        let id = session.task_id.borrow().clone()?;
        self.inner.is_live(&id).then_some(id)
    }
}

/// `sharedSessionsModule`.
pub struct SharedSessionsModule;

impl Module for SharedSessionsModule {
    const NAME: &'static str = "sharedSessions";
    type Api = SharedSessionsApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<AgentsModule>(), ModuleRef::of::<AgentStoreModule>()]
    }

    fn register(ctx: &ModuleContext) -> SharedSessionsApi {
        let agents = ctx.use_::<AgentsModule>();
        let store = ctx.use_::<AgentStoreModule>();
        create_shared_sessions(SharedSessionsDeps {
            start_task: Rc::new(move |ws, harness| agents.workspace(ws).start_task(harness)),
            task: Rc::new(move |id| store.task(id)),
        })
    }
}
