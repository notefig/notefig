//! Recent documents: the files the user has had in front of them, across
//! every open workspace, for the sidebar's Everything view and the welcome
//! screen. A port of `modules/recent-documents/`.
//!
//! Persisted: a row per path, touched whenever a file tab becomes the
//! active one (never on a keystroke). Read-side, a row counts only while
//! its workspace is open and the file still exists there.

use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Core, Module, ModuleContext, ModuleRef, Subscription};
use notefig_files::FilesModule;
use notefig_files::paths::{relative_tree_path, workspace_key};
use notefig_kv::PersistedCollection;
use notefig_platform::{Db, PlatformService};
use notefig_scratchpads::is_scratchpad_file;
use notefig_workspaces::{OpenWorkspaceRow, WorkspacesModule};
use serde::{Deserialize, Serialize};

pub const RECENT_DOCUMENTS_COLLECTION_ID: &str = "recent-documents";
/// Rows kept in storage across every workspace; views show fewer.
pub const MAX_RECENT_DOCUMENTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocumentRow {
    /// Absolute path: the row id.
    pub path: String,
    /// `workspace_key(workspace)` at touch time, for the open-set join.
    pub workspace_key: String,
    pub last_opened_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentDocument {
    pub path: String,
    pub workspace_path: String,
    pub last_opened_at: i64,
    pub is_scratchpad: bool,
}

/// `core.recentDocuments`.
pub struct RecentDocumentsApi {
    collection: PersistedCollection<RecentDocumentRow>,
    workspace_of: Rc<dyn Fn(&str) -> Option<String>>,
}

pub fn create_recent_documents(db: Rc<dyn Db>, workspace_of: Rc<dyn Fn(&str) -> Option<String>>) -> RecentDocumentsApi {
    RecentDocumentsApi { collection: PersistedCollection::new(RECENT_DOCUMENTS_COLLECTION_ID, db), workspace_of }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl RecentDocumentsApi {
    pub fn collection(&self) -> &PersistedCollection<RecentDocumentRow> {
        &self.collection
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.collection.subscribe(listener)
    }

    /// Record `path` as the document most recently in front. A path outside
    /// every open workspace is ignored. Resolves once durable.
    pub fn touch(&self, path: &str, now: i64) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let Some(workspace) = (self.workspace_of)(path) else {
            return futures::future::ready(Ok(())).boxed_local();
        };
        let collection = self.collection.clone();
        let path = path.to_string();
        async move {
            collection.preload().await;
            collection
                .upsert(&path, RecentDocumentRow { path: path.clone(), workspace_key: workspace_key(&workspace), last_opened_at: now })
                .await?;
            // Keep storage bounded: drop the oldest rows past the cap.
            let mut rows = collection.values();
            if rows.len() > MAX_RECENT_DOCUMENTS {
                rows.sort_by_key(|r| r.last_opened_at);
                let excess = rows.len() - MAX_RECENT_DOCUMENTS;
                collection.delete(rows.into_iter().take(excess).map(|r| r.path).collect()).await?;
            }
            Ok(())
        }
        .boxed_local()
    }

    /// The most recent documents across the open workspaces, newest first
    /// (`useRecentDocuments`). Hydrates on first ask.
    pub fn recent(&self, core: &Core, limit: usize) -> Vec<RecentDocument> {
        if !self.collection.is_hydrated() {
            core.executor().spawn(self.collection.preload());
        }
        let open = core.use_::<WorkspacesModule>().open_workspaces();
        derive_recent_documents(
            &self.collection.values(),
            &open,
            |ws, path| {
                core.workspace(ws).get::<FilesModule>().is_ok_and(|files| files.metadata().contains(path))
            },
            limit,
        )
    }
}

/// The stored rows joined to the open set, newest first, capped at
/// `limit`. `exists` is the file-listing check.
pub fn derive_recent_documents(
    rows: &[RecentDocumentRow],
    open: &[OpenWorkspaceRow],
    exists: impl Fn(&str, &str) -> bool,
    limit: usize,
) -> Vec<RecentDocument> {
    let mut sorted: Vec<&RecentDocumentRow> = rows.iter().collect();
    sorted.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    let mut out = Vec::new();
    for row in sorted {
        let Some(ws) = open.iter().find(|w| w.key == row.workspace_key) else { continue };
        if !exists(&ws.path, &row.path) {
            continue;
        }
        let rel = relative_tree_path(&ws.path, &row.path);
        out.push(RecentDocument {
            path: row.path.clone(),
            workspace_path: ws.path.clone(),
            last_opened_at: row.last_opened_at,
            is_scratchpad: is_scratchpad_file(rel.as_deref(), true),
        });
        if out.len() == limit {
            break;
        }
    }
    out
}

/// `recentDocumentsModule`.
pub struct RecentDocumentsModule;

impl Module for RecentDocumentsModule {
    const NAME: &'static str = "recentDocuments";
    type Api = RecentDocumentsApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>(), ModuleRef::of::<WorkspacesModule>()]
    }

    fn register(ctx: &ModuleContext) -> RecentDocumentsApi {
        let registry = ctx.use_::<WorkspacesModule>();
        create_recent_documents(ctx.service::<PlatformService>().db.clone(), Rc::new(move |p| registry.workspace_of(p)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_core::testing::TestExecutor;
    use notefig_platform::fake::FakePlatform;

    fn setup() -> (Rc<TestExecutor>, FakePlatform, RecentDocumentsApi) {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let api = create_recent_documents(fake.db.clone(), Rc::new(|p| p.starts_with("/ws/").then(|| "/ws".to_string())));
        (exec, fake, api)
    }

    #[test]
    fn stores_a_touched_document_and_moves_a_retouched_one_to_the_front() {
        let (exec, _f, api) = setup();
        exec.block_on(api.touch("/ws/a.md", 1)).unwrap();
        exec.block_on(api.touch("/ws/b.md", 2)).unwrap();
        exec.block_on(api.touch("/ws/a.md", 3)).unwrap();
        exec.block_on(api.touch("/elsewhere/c.md", 4)).unwrap();
        let open = vec![OpenWorkspaceRow { key: "/ws".into(), path: "/ws".into(), opened_at: 0, focused_at: 0 }];
        let docs = derive_recent_documents(&api.collection().values(), &open, |_, _| true, 10);
        assert_eq!(docs.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), vec!["/ws/a.md", "/ws/b.md"]);
    }

    #[test]
    fn prunes_storage_to_the_cap_oldest_first() {
        let (exec, fake, api) = setup();
        for i in 0..(MAX_RECENT_DOCUMENTS as i64 + 3) {
            exec.block_on(api.touch(&format!("/ws/{i}.md"), i)).unwrap();
        }
        let stored = fake.db.snapshot(RECENT_DOCUMENTS_COLLECTION_ID);
        assert_eq!(stored.len(), MAX_RECENT_DOCUMENTS);
        assert!(!stored.contains_key("/ws/0.md") && stored.contains_key("/ws/3.md"));
    }

    #[test]
    fn only_lists_rows_of_open_workspaces_whose_files_exist_and_tags_scratchpads() {
        let row = |p: &str, ws: &str, at| RecentDocumentRow { path: p.into(), workspace_key: ws.into(), last_opened_at: at };
        let rows = vec![row("/ws/.notefig/scratchpads/a.md", "/ws", 3), row("/ws/gone.md", "/ws", 2), row("/closed/x.md", "/closed", 1)];
        let open = vec![OpenWorkspaceRow { key: "/ws".into(), path: "/ws".into(), opened_at: 0, focused_at: 0 }];
        let docs = derive_recent_documents(&rows, &open, |_, p| p != "/ws/gone.md", 10);
        assert_eq!(docs.len(), 1);
        assert!(docs[0].is_scratchpad);
    }
}
