//! The `documents` module — `core.documents`: a port of
//! `packages/desktop/src/modules/documents/` plus the per-file save
//! pipeline TS keeps in `utils/markdown-conversion.ts` (`DocumentSync`),
//! which here is this module's state rather than a module-scope map.
//!
//! - [`DocumentsApi::read`] / [`DocumentsApi::write`]: a workspace text file
//!   as the agent reads and writes it (ACP fs, history restore, blob
//!   answers). The write is the *adopting* primitive: after the disk write
//!   it brings every loaded copy forward (rows via [`LoadedContent`], and
//!   the live editor via `EditorInstance::adopt`, as ONE undoable change).
//!   A local edit pending in the editor wins (last writer wins).
//! - [`DocumentsApi::adopt_external`]: the same adoption for a change the
//!   watcher saw (another program wrote the file).
//! - [`DocumentsApi::sync`]: a file's [`DocumentSync`] — dirty and saving
//!   state, the autosave debounce, `when_clean`. The editor host feeds it.
//! - Writes to one path are serialized; [`DocumentsApi::begin_move`]
//!   redirects writes that overlap a rename to where the file settles.

mod sync;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Executor, Listeners, Module, ModuleContext, ModuleRef, Subscription};
use notefig_editors::{AdoptionSource, Attribute, EditorsApi, EditorsModule};
use notefig_platform::{FileSystem, FsError, FsErrorKind, PlatformService, content_hash};

pub use sync::{AUTOSAVE_DEBOUNCE, DocumentSync, Snapshot, Writer};

/// A holder of loaded file content that an app write must bring forward
/// (TS: `WorkspaceFiles.updateLoadedContent`). The files module implements
/// it for a workspace's files.
pub trait LoadedContent {
    fn update_loaded_content(&self, path: &str, content: &str);
}

/// The open workspaces' loaded content (a path may sit in nested ones).
pub type OpenFiles = Rc<dyn Fn() -> Vec<Rc<dyn LoadedContent>>>;

/// What documents are built from.
pub struct DocumentsDeps {
    pub fs: Rc<dyn FileSystem>,
    pub open_files: OpenFiles,
    pub editors: Rc<EditorsApi>,
    pub attribute: Option<Attribute>,
    pub executor: Rc<dyn Executor>,
}

/// `{ line, limit }` of `read`.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReadRange {
    /// 1-based.
    pub line: Option<usize>,
    pub limit: Option<usize>,
}

type MoveMap = Rc<RefCell<HashMap<String, Shared<LocalBoxFuture<'static, String>>>>>;

/// A pending move, from [`DocumentsApi::begin_move`].
pub struct Move {
    tx: Option<oneshot::Sender<String>>,
    path: String,
    moves: MoveMap,
}

impl Move {
    /// Where the file ended up (the new path, or the old one on failure).
    pub fn settle(mut self, final_path: &str) {
        self.moves.borrow_mut().remove(&self.path);
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(final_path.to_string());
        }
    }
}

type Settled = Shared<LocalBoxFuture<'static, ()>>;

struct Inner {
    deps: DocumentsDeps,
    /// Set after creation when the attributing module sits above this one
    /// in the crate graph (turn-writes depends on agents, which depends on
    /// documents); falls back to `deps.attribute`.
    attribute: RefCell<Option<Attribute>>,
    in_flight: RefCell<HashMap<String, Settled>>,
    moves: MoveMap,
    syncs: RefCell<HashMap<String, DocumentSync>>,
    changed: Listeners<()>,
}

/// `core.documents`.
#[derive(Clone)]
pub struct DocumentsApi {
    inner: Rc<Inner>,
}

fn assert_absolute(path: &str) -> Result<(), FsError> {
    if std::path::Path::new(path).is_absolute() {
        Ok(())
    } else {
        Err(FsError::new(FsErrorKind::InvalidPath, path))
    }
}

pub fn create_documents(deps: DocumentsDeps) -> DocumentsApi {
    let api = DocumentsApi {
        inner: Rc::new(Inner {
            deps,
            attribute: RefCell::new(None),
            in_flight: RefCell::default(),
            moves: Rc::default(),
            syncs: RefCell::default(),
            changed: Listeners::new(),
        }),
    };
    let weak = Rc::downgrade(&api.inner);
    api.inner.deps.editors.set_dirty_source(Rc::new(move |path| {
        weak.upgrade()
            .and_then(|inner| inner.syncs.borrow().get(path).map(|s| s.is_dirty()))
            .unwrap_or(false)
    }));
    api
}

impl DocumentsApi {
    /// A file's text from disk; `line` (1-based) and `limit` cut a range.
    pub fn read(&self, path: &str, range: ReadRange) -> LocalBoxFuture<'static, Result<String, FsError>> {
        let fs = self.inner.deps.fs.clone();
        let path = path.to_string();
        async move {
            assert_absolute(&path)?;
            let mut result = fs.read_files(vec![path]).await;
            if let Some(err) = result.failed.pop() {
                return Err(err);
            }
            let content = result.succeeded.pop().map(|(_, c)| c).unwrap_or_default();
            if range.line.is_none() && range.limit.is_none() {
                return Ok(content);
            }
            let lines: Vec<&str> = content.split('\n').collect();
            let start = range.line.unwrap_or(1).saturating_sub(1).min(lines.len());
            let end = range.limit.map_or(lines.len(), |l| (start + l).min(lines.len()));
            Ok(lines[start..end].join("\n"))
        }
        .boxed_local()
    }

    /// Write a file's text and bring every loaded copy forward: rows and an
    /// open editor (as one undoable change). Same-path writes run one after
    /// another; one overlapping a move lands where the file settled.
    pub fn write(&self, path: &str, content: &str) -> LocalBoxFuture<'static, Result<(), FsError>> {
        let this = self.clone();
        let path = path.to_string();
        let content = content.to_string();
        if let Err(e) = assert_absolute(&path) {
            return futures::future::ready(Err(e)).boxed_local();
        }
        // With no move pending, the check and the write's registration are
        // one synchronous step, so a later move's drain sees this write.
        let pending = self.inner.moves.borrow().get(&path).cloned();
        match pending {
            None => self.track_write(path, content),
            Some(mv) => async move {
                let target = mv.await;
                this.track_write(target, content).await
            }
            .boxed_local(),
        }
    }

    fn track_write(&self, target: String, content: String) -> LocalBoxFuture<'static, Result<(), FsError>> {
        let previous = self.inner.in_flight.borrow().get(&target).cloned();
        let this = self.clone();
        let t = target.clone();
        let op = async move {
            if let Some(p) = previous {
                p.await;
            }
            this.write_and_adopt(&t, content).await
        }
        .boxed_local()
        .shared();
        let settled: Settled = op.clone().map(|_| ()).boxed_local().shared();
        self.inner.in_flight.borrow_mut().insert(target.clone(), settled.clone());
        let inner = Rc::downgrade(&self.inner);
        self.inner.deps.executor.spawn(
            async move {
                settled.clone().await;
                if let Some(inner) = inner.upgrade() {
                    let mut map = inner.in_flight.borrow_mut();
                    if map.get(&target).is_some_and(|s| s.ptr_eq(&settled)) {
                        map.remove(&target);
                    }
                }
            }
            .boxed_local(),
        );
        op.boxed_local()
    }

    async fn write_to_disk(&self, path: &str, content: &str) -> Result<(), FsError> {
        let mut result = self.inner.deps.fs.write_files(vec![(path.to_string(), content.to_string())]).await;
        match result.failed.pop() {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Rows lead disk for every app write.
    fn update_loaded_rows(&self, path: &str, content: &str) {
        for files in (self.inner.deps.open_files)() {
            files.update_loaded_content(path, content);
        }
    }

    async fn write_and_adopt(&self, target: &str, content: String) -> Result<(), FsError> {
        self.write_to_disk(target, &content).await?;
        self.update_loaded_rows(target, &content);
        self.adopt_into_editor(target, content).await
    }

    /// Push `content` (already on disk) into an open editor, if one is open
    /// and has no local edits pending.
    async fn adopt_into_editor(&self, target: &str, content: String) -> Result<(), FsError> {
        let Some(editor) = self.inner.deps.editors.markdown_editor(target) else { return Ok(()) };
        if editor.is_destroyed() {
            return Ok(());
        }
        let sync = self.sync(target);
        if !sync.can_adopt() {
            return Ok(());
        }
        let hash = content_hash(&content);
        let source = AdoptionSource {
            path: target.to_string(),
            content_hash: hash.clone(),
            attribute: self.inner.attribute.borrow().clone().or_else(|| self.inner.deps.attribute.clone()),
        };
        let Some(adoption) = editor.adopt(content.clone(), source).await else { return Ok(()) };
        if adoption.reinserted_widgets == 0 {
            sync.commit_adoption(&content, &hash);
            return Ok(());
        }
        // Re-asserted widget markers exist only in the editor: repair the
        // file inside this tracked write.
        let repaired = editor.markdown().unwrap_or(content);
        self.write_to_disk(target, &repaired).await?;
        self.update_loaded_rows(target, &repaired);
        sync.commit_adoption(&repaired, &content_hash(&repaired));
        Ok(())
    }

    /// An external change the watcher saw: adopt it into an open editor
    /// when the file's state warrants it (`useEditorFileSync`'s path).
    /// Resolves whether the editor changed.
    pub fn adopt_external(&self, path: &str, content: &str) -> LocalBoxFuture<'static, bool> {
        let this = self.clone();
        let path = path.to_string();
        let content = content.to_string();
        async move {
            let hash = content_hash(&content);
            let sync = this.sync(&path);
            if this.inner.deps.editors.markdown_editor(&path).is_none() || !sync.needs_adoption(&hash, &content) {
                return false;
            }
            let before = sync.last_markdown();
            let _ = this.adopt_into_editor(&path, content).await;
            sync.last_markdown() != before
        }
        .boxed_local()
    }

    /// Which prompt round wrote some bytes (`core.turnWrites.attribute`),
    /// wired by the composition root: an adopted write it attributes lands
    /// in the editor as that round's change.
    pub fn set_attribute(&self, attribute: Attribute) {
        *self.inner.attribute.borrow_mut() = Some(attribute);
    }

    /// Resolves once every write in flight for `path` has landed or failed.
    pub fn when_writes_settled(&self, path: &str) -> LocalBoxFuture<'static, ()> {
        match self.inner.in_flight.borrow().get(path).cloned() {
            Some(s) => s.boxed_local(),
            None => futures::future::ready(()).boxed_local(),
        }
    }

    /// The file at `path` is about to move; writes to it wait and land
    /// where it settles. Errors if a move of `path` is already pending.
    pub fn begin_move(&self, path: &str) -> anyhow::Result<Move> {
        let mut moves = self.inner.moves.borrow_mut();
        if moves.contains_key(path) {
            anyhow::bail!("A move of \"{path}\" is already in progress");
        }
        let (tx, rx) = oneshot::channel::<String>();
        let fallback = path.to_string();
        let fut = rx.map(move |r| r.unwrap_or(fallback)).boxed_local().shared();
        moves.insert(path.to_string(), fut);
        Ok(Move {
            tx: Some(tx),
            path: path.to_string(),
            moves: self.inner.moves.clone(),
        })
    }

    // --- The save pipeline (TS `getDocumentSync` & co.) ----------------

    /// The sync for `path`, created on first use with a writer that writes
    /// through the platform and brings loaded rows forward.
    pub fn sync(&self, path: &str) -> DocumentSync {
        if let Some(s) = self.inner.syncs.borrow().get(path) {
            return s.clone();
        }
        let sync = DocumentSync::new(path, self.inner.deps.executor.clone(), self.inner.changed.clone());
        let weak = Rc::downgrade(&self.inner);
        let p = path.to_string();
        sync.set_writer(Some(Rc::new(move |markdown: String, _hash: String| {
            let inner = weak.upgrade();
            let p = p.clone();
            async move {
                let Some(inner) = inner else { return Ok(()) };
                let this = DocumentsApi { inner };
                this.write_to_disk(&p, &markdown).await?;
                this.update_loaded_rows(&p, &markdown);
                Ok(())
            }
            .boxed_local()
        })));
        self.inner.syncs.borrow_mut().insert(path.to_string(), sync.clone());
        sync
    }

    /// `flushDocumentSync`.
    pub fn flush(&self, path: &str) {
        let s = self.inner.syncs.borrow().get(path).cloned();
        if let Some(s) = s {
            s.flush_pending_edits();
        }
    }

    /// `whenDocumentSyncClean`.
    pub fn when_clean(&self, path: &str) -> LocalBoxFuture<'static, ()> {
        let s = self.inner.syncs.borrow().get(path).cloned();
        match s {
            Some(s) => s.when_clean(),
            None => futures::future::ready(()).boxed_local(),
        }
    }

    /// `closeDocumentSync`: the editor is disposed.
    pub fn close(&self, path: &str) {
        let s = self.inner.syncs.borrow_mut().remove(path);
        if let Some(s) = s {
            s.close();
        }
        self.inner.changed.emit();
    }

    pub fn is_dirty(&self, path: &str) -> bool {
        self.inner.syncs.borrow().get(path).is_some_and(|s| s.has_unsaved_edits())
    }

    /// Whether any open document has edits not yet on disk.
    pub fn any_unsaved(&self) -> bool {
        self.inner.syncs.borrow().values().any(|s| s.has_unsaved_edits())
    }

    /// Paths with a live sync (open documents).
    pub fn open_paths(&self) -> Vec<String> {
        self.inner.syncs.borrow().keys().cloned().collect()
    }

    /// Called when any document's dirty or saving state changes.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.changed.subscribe(move |_| listener())
    }
}

/// A workspace's files are where its loaded content lives.
impl LoadedContent for notefig_files::WorkspaceFiles {
    fn update_loaded_content(&self, path: &str, content: &str) {
        notefig_files::WorkspaceFiles::update_loaded_content(self, path, content);
    }
}

/// `documentsModule`. Per workspace, it tells that workspace's files which
/// paths have a save in flight, so a watcher event for one waits.
pub struct DocumentsModule;

impl Module for DocumentsModule {
    const NAME: &'static str = "documents";
    type Api = DocumentsApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        // TS also needs `turnWrites` for `attribute`. Here turn-writes sits
        // above documents in the crate graph, so the root wires it with
        // `set_attribute`.
        vec![
            ModuleRef::service::<PlatformService>(),
            ModuleRef::of::<EditorsModule>(),
            ModuleRef::of::<notefig_files::FilesModule>(),
        ]
    }

    fn register(ctx: &ModuleContext) -> DocumentsApi {
        let c = ctx.clone();
        create_documents(DocumentsDeps {
            fs: ctx.service::<PlatformService>().fs.clone(),
            open_files: Rc::new(move || {
                c.workspaces()
                    .list()
                    .into_iter()
                    .filter_map(|w| c.workspace_handle(&w.path).get::<notefig_files::FilesModule>().ok())
                    .map(|f| f as Rc<dyn LoadedContent>)
                    .collect()
            }),
            editors: ctx.use_::<EditorsModule>(),
            attribute: None,
            executor: ctx.executor(),
        })
    }

    fn workspace() -> Option<notefig_core::WorkspacePart<Self>> {
        Some(
            notefig_core::WorkspacePart::new(|ctx, api: &Rc<DocumentsApi>| {
                let files = ctx.use_workspace::<notefig_files::FilesModule>();
                let docs = Rc::downgrade(&api.inner);
                files.set_dirty_check(move |path| {
                    docs.upgrade().is_some_and(|inner| inner.syncs.borrow().get(path).is_some_and(|s| s.is_dirty()))
                });
                Ok(())
            })
            .needs(vec![ModuleRef::of::<notefig_files::FilesModule>()]),
        )
    }
}

#[cfg(test)]
mod tests;
