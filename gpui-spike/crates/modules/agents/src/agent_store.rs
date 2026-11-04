//! The agent collections: a port of `agent-collections.ts` +
//! `agent-persistence.ts` — `core.agentStore`.
//!
//! Task rows and harness rows are persisted in the platform db
//! (`agent-tasks`, `harnesses`, as the TS TanStack collections); turns,
//! entries and permission requests are memory-only, as in TS.
//!
//! Deviation (Rust forces it): the agent runtime runs on its own thread
//! (its ACP pumps, timers and child processes must not stall the UI
//! thread, and its rows are shared across that boundary behind a mutex).
//! The store therefore reads the runtime's live state, and the runtime's
//! durable snapshots come back here to be written to the db on the main
//! thread. Readers see the same rows the TS collections hold and subscribe
//! the same way (`subscribe`, `subscribe_task`).

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agent::harness::HarnessRow;
use notefig_agent::model::{AgentEntry, AgentTaskRow, AgentTurn, PermissionRequestRow};
use notefig_core::{Listeners, Subscription};
use notefig_platform::Db;
use serde_json::Value;

use crate::runtime::events::AgentEvent;
use crate::runtime::host::AgentHandle;
use crate::runtime::store::PersistedState;

/// The db collection of task rows.
pub const TASKS_COLLECTION: &str = "agent-tasks";
/// The db collection of harness rows.
pub const HARNESSES_COLLECTION: &str = "harnesses";

/// `AgentStore`.
pub struct AgentStore {
    db: Rc<dyn Db>,
    handle: RefCell<Option<AgentHandle>>,
    changed: Listeners<()>,
    task_changed: Listeners<String>,
    harnesses_changed: Listeners<()>,
    saved_tasks: RefCell<BTreeMap<String, Value>>,
    saved_harnesses: RefCell<BTreeMap<String, Value>>,
    hydrated: Cell<bool>,
}

/// `createAgentStore(db)`.
pub fn create_agent_store(db: Rc<dyn Db>) -> AgentStore {
    AgentStore {
        db,
        handle: RefCell::default(),
        changed: Listeners::new(),
        task_changed: Listeners::new(),
        harnesses_changed: Listeners::new(),
        saved_tasks: RefCell::default(),
        saved_harnesses: RefCell::default(),
        hydrated: Cell::new(false),
    }
}

impl AgentStore {
    /// Load the persisted collections (what the runtime reconciles at boot).
    pub(crate) fn load(self: &Rc<Self>) -> LocalBoxFuture<'static, PersistedState> {
        let this = self.clone();
        async move {
            let mut state = PersistedState::default();
            match this.db.load(TASKS_COLLECTION).await {
                Ok(rows) => state.tasks = rows.into_iter().collect(),
                Err(err) => log::error!("agents: loading {TASKS_COLLECTION} failed: {err:#}"),
            }
            match this.db.load(HARNESSES_COLLECTION).await {
                Ok(rows) => state.harnesses = rows.into_iter().collect(),
                Err(err) => log::error!("agents: loading {HARNESSES_COLLECTION} failed: {err:#}"),
            }
            *this.saved_tasks.borrow_mut() = state.tasks.clone();
            *this.saved_harnesses.borrow_mut() = state.harnesses.clone();
            state
        }
        .boxed_local()
    }

    pub(crate) fn attach(&self, handle: AgentHandle) {
        *self.handle.borrow_mut() = Some(handle);
        self.hydrated.set(true);
        self.changed.emit();
        self.harnesses_changed.emit();
    }

    /// Whether the persisted rows are loaded and reconciled.
    pub fn is_hydrated(&self) -> bool {
        self.hydrated.get()
    }

    /// Write what changed in a durable snapshot through to the db.
    pub(crate) fn persist(&self, snapshot: &PersistedState) -> LocalBoxFuture<'static, ()> {
        let writes = diff(&mut self.saved_tasks.borrow_mut(), &snapshot.tasks)
            .into_iter()
            .map(|w| (TASKS_COLLECTION, w))
            .chain(
                diff(&mut self.saved_harnesses.borrow_mut(), &snapshot.harnesses)
                    .into_iter()
                    .map(|w| (HARNESSES_COLLECTION, w)),
            )
            .collect::<Vec<_>>();
        let db = self.db.clone();
        async move {
            for (collection, (key, value)) in writes {
                let result = match value {
                    Some(v) => db.put(collection, &key, v).await,
                    None => db.delete(collection, &key).await,
                };
                if let Err(err) = result {
                    log::error!("agents: writing {collection}/{key} failed: {err:#}");
                }
            }
        }
        .boxed_local()
    }

    /// A batch of runtime row events landed: tell whoever reads them.
    pub(crate) fn apply(&self, batch: &[AgentEvent]) {
        let mut tasks: Vec<&str> = Vec::new();
        let mut harnesses = false;
        for event in batch {
            let task = match event {
                AgentEvent::TaskChanged(row) => Some(row.task_id.as_str()),
                AgentEvent::TaskRemoved { task_id }
                | AgentEvent::TurnRemoved { task_id, .. }
                | AgentEvent::EntryRemoved { task_id, .. }
                | AgentEvent::TranscriptReplaced { task_id } => Some(task_id.as_str()),
                AgentEvent::TurnChanged(turn) => Some(turn.task_id.as_str()),
                AgentEvent::EntryChanged(entry) => Some(entry.task_id.as_str()),
                AgentEvent::PermissionChanged(row) => Some(row.task_id.as_str()),
                AgentEvent::HarnessesChanged => {
                    harnesses = true;
                    None
                }
                _ => None,
            };
            if let Some(task) = task
                && !tasks.contains(&task)
            {
                tasks.push(task);
            }
        }
        for task in tasks {
            self.task_changed.notify(&task.to_string());
        }
        if harnesses {
            self.harnesses_changed.emit();
        }
        self.changed.emit();
    }

    /// Any row changed.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    /// Rows of one task changed (its row, turns, entries, permissions).
    pub fn subscribe_task(&self, task_id: &str, listener: impl Fn() + 'static) -> Subscription {
        let id = task_id.to_string();
        self.task_changed.subscribe(move |changed| {
            if *changed == id {
                listener()
            }
        })
    }

    /// Harness rows changed (settings, install verdicts, catalogs).
    pub fn subscribe_harnesses(&self, listener: impl Fn() + 'static) -> Subscription {
        self.harnesses_changed.subscribe(move |_| listener())
    }

    fn read<T: Default>(&self, f: impl FnOnce(&AgentHandle) -> T) -> T {
        self.handle.borrow().as_ref().map(f).unwrap_or_default()
    }

    pub fn task(&self, task_id: &str) -> Option<AgentTaskRow> {
        self.read(|h| h.task(task_id))
    }

    /// Every task row.
    pub fn tasks(&self) -> Vec<AgentTaskRow> {
        self.read(|h| h.tasks())
    }

    /// A workspace's task rows, most recently updated first (the sessions
    /// panel's order).
    pub fn tasks_for_workspace(&self, workspace_path: &str) -> Vec<AgentTaskRow> {
        let mut rows = self.read(|h| h.tasks_for_workspace(workspace_path));
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.task_id.cmp(&b.task_id)));
        rows
    }

    /// `turnsForTask`, in id order.
    pub fn turns(&self, task_id: &str) -> Vec<AgentTurn> {
        self.read(|h| h.turns(task_id))
    }

    pub fn turn(&self, turn_id: &str) -> Option<AgentTurn> {
        self.read(|h| h.state().turns.get(turn_id).cloned())
    }

    /// `entriesForTask`: id order is render order.
    pub fn entries(&self, task_id: &str) -> Vec<AgentEntry> {
        self.read(|h| h.entries(task_id))
    }

    pub fn permission_requests(&self, task_id: &str) -> Vec<PermissionRequestRow> {
        self.read(|h| h.permission_requests(task_id))
    }

    /// The task's pending permission requests, oldest first.
    pub fn pending_permissions(&self, task_id: &str) -> Vec<PermissionRequestRow> {
        self.read(|h| h.pending_permissions(task_id))
    }

    pub fn harness_rows(&self) -> Vec<HarnessRow> {
        self.read(|h| h.state().harnesses.values().cloned().collect())
    }
}

/// The puts (`Some`) and deletes (`None`) that bring `saved` to `next`.
fn diff(saved: &mut BTreeMap<String, Value>, next: &BTreeMap<String, Value>) -> Vec<(String, Option<Value>)> {
    let mut writes = Vec::new();
    for (key, value) in next {
        if saved.get(key) != Some(value) {
            writes.push((key.clone(), Some(value.clone())));
        }
    }
    for key in saved.keys() {
        if !next.contains_key(key) {
            writes.push((key.clone(), None));
        }
    }
    *saved = next.clone();
    writes
}
