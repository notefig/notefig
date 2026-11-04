use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Executor, ExecutorExt, Subscription, WorkspaceLifecycle};
use notefig_files::paths::{normalize, relative_tree_path, workspace_key};
use notefig_kv::PersistedCollection;
use notefig_platform::Db;
use serde::{Deserialize, Serialize};

/// The collection id, and so the db table the open set lands in.
pub const OPEN_WORKSPACES_COLLECTION_ID: &str = "open-workspaces";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceRow {
    /// `workspace_key(path)`: the row id.
    pub key: String,
    /// Normalized native spelling, for display and navigation.
    pub path: String,
    pub opened_at: u64,
    /// Last time it was brought to the front; the max is the focused one.
    pub focused_at: u64,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The open set: `core.use_::<WorkspacesModule>()`.
pub struct WorkspaceRegistry {
    rows: PersistedCollection<OpenWorkspaceRow>,
    restored: RefCell<Option<Shared<LocalBoxFuture<'static, ()>>>>,
    now: Rc<dyn Fn() -> u64>,
    executor: Rc<dyn Executor>,
}

pub fn create_workspace_registry(db: Rc<dyn Db>, executor: Rc<dyn Executor>, now: Rc<dyn Fn() -> u64>) -> WorkspaceRegistry {
    WorkspaceRegistry {
        rows: PersistedCollection::new(OPEN_WORKSPACES_COLLECTION_ID, db),
        restored: RefCell::default(),
        now,
        executor,
    }
}

impl WorkspaceRegistry {
    /// The persisted rows, live (the switcher's source).
    pub fn collection(&self) -> &PersistedCollection<OpenWorkspaceRow> {
        &self.rows
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.rows.subscribe(listener)
    }

    /// The open set, oldest-opened first (`useOpenWorkspaces`).
    pub fn open_workspaces(&self) -> Vec<OpenWorkspaceRow> {
        let mut rows = self.rows.values();
        rows.sort_by_key(|r| r.opened_at);
        rows
    }

    /// The focused workspace (`useFocusedWorkspace`).
    pub fn focused(&self) -> Option<String> {
        most_recently_focused(&self.rows.values()).map(|r| r.path.clone())
    }

    /// Resolves once the open set is hydrated and, if this root restores,
    /// its workspaces are seeded. Idempotent.
    pub fn when_ready(&self) -> LocalBoxFuture<'static, ()> {
        match self.restored.borrow().clone() {
            Some(r) => r.boxed_local(),
            None => self.rows.preload(),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.rows.is_hydrated()
    }

    /// Bring every persisted open workspace back: load the set, whose rows
    /// the mirror opens in core.
    pub fn restore(&self) -> LocalBoxFuture<'static, ()> {
        let mut restored = self.restored.borrow_mut();
        restored.get_or_insert_with(|| self.rows.preload().shared()).clone().boxed_local()
    }

    pub fn is_open(&self, workspace_path: &str) -> bool {
        self.rows.has(&workspace_key(workspace_path))
    }

    /// The open workspace whose tree contains `path` (deepest when nested),
    /// by tree membership, never by string prefix.
    pub fn workspace_of(&self, path: &str) -> Option<String> {
        workspace_of_path_in(&self.rows.values(), path)
    }

    /// The registry's half of opening or focusing, run on
    /// `workspace:focused`: join the open set, or come to the front.
    /// Resolves once durable.
    pub fn record_focus(&self, workspace_path: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let rows = self.rows.clone();
        let now = self.now.clone();
        let key = workspace_key(workspace_path);
        let native = normalize(workspace_path);
        async move {
            rows.preload().await;
            // Strictly above every other row, even within one millisecond.
            let top = rows.values().iter().map(|r| r.focused_at).max().unwrap_or(0);
            let at = now().max(top + 1);
            match rows.get(&key) {
                Some(mut row) => {
                    row.focused_at = at;
                    rows.upsert(&key, row).await
                }
                None => rows.upsert(&key, OpenWorkspaceRow { key: key.clone(), path: native, opened_at: at, focused_at: at }).await,
            }
        }
        .boxed_local()
    }

    /// Drop the row of a workspace core is closing.
    pub fn forget(&self, key: &str) {
        if self.rows.has(key) {
            // The row leaves memory at once; durability follows.
            let delete = self.rows.delete(vec![key.to_string()]);
            self.executor.spawn_local(async move {
                if let Err(err) = delete.await {
                    log::error!("forgetting a workspace failed: {err:#}");
                }
            });
        }
    }

    /// Mirror the open set into core's workspace lifecycle: present rows
    /// open now, later inserts open, deletes close.
    pub fn mirror(&self, lifecycle: WorkspaceLifecycle) -> Subscription {
        let mirrored: Rc<RefCell<HashMap<String, String>>> = Rc::default();
        let sync = {
            let rows = self.rows.clone();
            let mirrored = mirrored.clone();
            let lifecycle = lifecycle.clone();
            let executor = self.executor.clone();
            move || {
                let current: HashMap<String, String> = rows.values().into_iter().map(|r| (r.key, r.path)).collect();
                let mut m = mirrored.borrow_mut();
                for (key, path) in &current {
                    if !m.contains_key(key) {
                        let l = lifecycle.clone();
                        let p = path.clone();
                        executor.spawn_local(async move { l.open(&p).await });
                    }
                }
                for (key, path) in m.iter() {
                    if !current.contains_key(key) {
                        executor.spawn_local(lifecycle.close(path));
                    }
                }
                *m = current;
            }
        };
        sync();
        self.rows.subscribe(sync)
    }
}

pub fn most_recently_focused(rows: &[OpenWorkspaceRow]) -> Option<&OpenWorkspaceRow> {
    rows.iter().max_by_key(|r| r.focused_at)
}

pub fn workspace_of_path_in(rows: &[OpenWorkspaceRow], path: &str) -> Option<String> {
    rows.iter()
        .filter(|r| relative_tree_path(&r.path, path).is_some())
        .max_by_key(|r| r.path.len())
        .map(|r| r.path.clone())
}
