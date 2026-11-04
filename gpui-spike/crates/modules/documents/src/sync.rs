//! `DocumentSync` (`utils/markdown-conversion.ts`) plus the autosave
//! debounce of `components/editor/use-editor-file-sync.ts`: everything
//! stateful about keeping one file and one editor document in agreement.
//!
//! Save semantics, as in TS: every `push_update` ships as it comes; at most
//! one write is in flight, and edits arriving meanwhile collapse into one
//! fresh snapshot when it completes. Typing reaches the pipeline through
//! [`DocumentSync::edited`], debounced by [`AUTOSAVE_DEBOUNCE`].

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, Listeners};
use notefig_platform::content_hash;

pub const AUTOSAVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// Persists a serialization and its hash.
pub type Writer = Rc<dyn Fn(String, String) -> LocalBoxFuture<'static, anyhow::Result<()>>>;
/// Reads the live document as markdown (lazily: once per save round).
pub type Snapshot = Rc<dyn Fn() -> String>;

/// One file's sync pipeline. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct DocumentSync {
    inner: Rc<Inner>,
}

struct Inner {
    path: String,
    executor: Rc<dyn Executor>,
    saving: Cell<bool>,
    dirty: Cell<bool>,
    closed: Cell<bool>,
    /// Bumped on adoption so an in-flight serialization of a replaced
    /// document is dropped.
    generation: Cell<u64>,
    snapshot: RefCell<Option<Snapshot>>,
    last_markdown: RefCell<Option<String>>,
    last_hash: RefCell<Option<String>>,
    writer: RefCell<Option<Writer>>,
    clean_waiters: RefCell<Vec<oneshot::Sender<()>>>,
    /// The debounce window: the edit generation a pending timer will push.
    debounce: Cell<Option<u64>>,
    debounce_seq: Cell<u64>,
    last_error: RefCell<Option<String>>,
    /// Shared with the documents module: any sync's state change.
    changed: Listeners<()>,
}

impl DocumentSync {
    pub(crate) fn new(path: &str, executor: Rc<dyn Executor>, changed: Listeners<()>) -> Self {
        Self {
            inner: Rc::new(Inner {
                path: path.to_string(),
                executor,
                saving: Cell::new(false),
                dirty: Cell::new(false),
                closed: Cell::new(false),
                generation: Cell::new(0),
                snapshot: RefCell::new(None),
                last_markdown: RefCell::new(None),
                last_hash: RefCell::new(None),
                writer: RefCell::new(None),
                clean_waiters: RefCell::new(Vec::new()),
                debounce: Cell::new(None),
                debounce_seq: Cell::new(0),
                last_error: RefCell::new(None),
                changed,
            }),
        }
    }

    pub fn path(&self) -> &str {
        &self.inner.path
    }

    /// A save is pending or in flight (TS `isDirty`).
    pub fn is_dirty(&self) -> bool {
        self.inner.dirty.get() || self.inner.saving.get()
    }

    /// Edits still sit in the autosave debounce window.
    pub fn has_pending_edits(&self) -> bool {
        self.inner.debounce.get().is_some()
    }

    /// Anything not yet on disk: the debounce window, a pending or an
    /// in-flight save. The status bar's "Saving…".
    pub fn has_unsaved_edits(&self) -> bool {
        self.is_dirty() || self.has_pending_edits()
    }

    pub fn is_saving(&self) -> bool {
        self.inner.saving.get()
    }

    /// The last save's failure, cleared by the next success.
    pub fn last_error(&self) -> Option<String> {
        self.inner.last_error.borrow().clone()
    }

    /// Resolves once no save is pending or in flight. Capture it before
    /// closing: it still resolves when the final write lands.
    pub fn when_clean(&self) -> LocalBoxFuture<'static, ()> {
        if !self.is_dirty() {
            return futures::future::ready(()).boxed_local();
        }
        let (tx, rx) = oneshot::channel();
        self.inner.clean_waiters.borrow_mut().push(tx);
        rx.map(|_| ()).boxed_local()
    }

    /// Set how a serialization is persisted (the editor host's write).
    pub fn set_writer(&self, writer: Option<Writer>) {
        *self.inner.writer.borrow_mut() = writer;
    }

    /// Establish the file-content baseline once.
    pub fn ensure_baseline(&self, file_content: &str, content_hash: Option<&str>) {
        if self.inner.last_markdown.borrow().is_none() {
            *self.inner.last_markdown.borrow_mut() = Some(file_content.to_string());
            *self.inner.last_hash.borrow_mut() = content_hash.map(str::to_string);
        }
    }

    /// The markdown the file is known to contain.
    pub fn last_markdown(&self) -> Option<String> {
        self.inner.last_markdown.borrow().clone()
    }

    /// Whether file state warrants replacing the editor's document. False
    /// before a baseline exists and for hash churn over the same content
    /// (trailing whitespace aside).
    pub fn needs_adoption(&self, content_hash: &str, file_content: &str) -> bool {
        let last_hash = self.inner.last_hash.borrow().clone();
        let last_md = self.inner.last_markdown.borrow().clone();
        if last_hash.is_none() && last_md.is_none() {
            return false;
        }
        if last_hash.as_deref() == Some(content_hash) {
            return false;
        }
        if last_md.is_some_and(|m| m.trim_end() == file_content.trim_end()) {
            *self.inner.last_hash.borrow_mut() = Some(content_hash.to_string());
            return false;
        }
        true
    }

    /// `prepareAdoption`'s gate (the parse happens in the editor): false
    /// while local edits are pending — the user's typing wins and its save
    /// overwrites the external change. The debounce window counts, as in
    /// `useEditorFileSync`.
    pub fn can_adopt(&self) -> bool {
        !self.inner.saving.get() && !self.inner.dirty.get() && !self.has_pending_edits()
    }

    /// The editor now holds `file_content`.
    pub fn commit_adoption(&self, file_content: &str, content_hash: &str) {
        self.inner.generation.set(self.inner.generation.get() + 1);
        self.inner.dirty.set(false);
        *self.inner.last_markdown.borrow_mut() = Some(file_content.to_string());
        *self.inner.last_hash.borrow_mut() = Some(content_hash.to_string());
        self.inner.changed.emit();
    }

    /// The user edited: push a snapshot once typing pauses.
    pub fn edited(&self, snapshot: Snapshot) {
        if self.inner.closed.get() {
            return;
        }
        *self.inner.snapshot.borrow_mut() = Some(snapshot);
        let seq = self.inner.debounce_seq.get() + 1;
        self.inner.debounce_seq.set(seq);
        let was_pending = self.inner.debounce.replace(Some(seq)).is_some();
        let this = self.clone();
        let timer = self.inner.executor.timer(AUTOSAVE_DEBOUNCE);
        self.inner.executor.spawn(
            async move {
                timer.await;
                if this.inner.debounce.get() == Some(seq) {
                    this.inner.debounce.set(None);
                    this.push_pending();
                }
            }
            .boxed_local(),
        );
        if !was_pending {
            self.inner.changed.emit();
        }
    }

    /// Push edits still in the debounce window now (Cmd+S, tab close,
    /// rename). Must run while the editor is alive.
    pub fn flush_pending_edits(&self) {
        if self.inner.debounce.take().is_some() {
            self.push_pending();
        }
    }

    fn push_pending(&self) {
        let snapshot = self.inner.snapshot.borrow().clone();
        if let Some(s) = snapshot {
            self.push_update(s);
        }
    }

    /// Ship an editor update.
    pub fn push_update(&self, snapshot: Snapshot) {
        if self.inner.closed.get() {
            return;
        }
        *self.inner.snapshot.borrow_mut() = Some(snapshot);
        if self.inner.saving.get() {
            self.inner.dirty.set(true);
            return;
        }
        self.run_save_loop();
    }

    /// The editor is gone. A save in flight still lands.
    pub fn close(&self) {
        self.inner.closed.set(true);
        self.inner.dirty.set(false);
        self.inner.debounce.set(None);
        if !self.inner.saving.get() {
            *self.inner.writer.borrow_mut() = None;
            *self.inner.snapshot.borrow_mut() = None;
        }
    }

    fn run_save_loop(&self) {
        self.inner.saving.set(true);
        self.inner.changed.emit();
        let this = self.clone();
        self.inner.executor.spawn(
            async move {
                let inner = &this.inner;
                loop {
                    inner.dirty.set(false);
                    let generation = inner.generation.get();
                    let snapshot = inner.snapshot.borrow().clone();
                    let Some(snapshot) = snapshot else { break };
                    let markdown = snapshot();
                    if generation != inner.generation.get() {
                        if inner.dirty.get() {
                            continue;
                        }
                        break;
                    }
                    let hash = content_hash(&markdown);
                    *inner.last_markdown.borrow_mut() = Some(markdown.clone());
                    *inner.last_hash.borrow_mut() = Some(hash.clone());
                    let writer = inner.writer.borrow().clone();
                    if let Some(w) = writer {
                        match w(markdown, hash).await {
                            Ok(()) => *inner.last_error.borrow_mut() = None,
                            Err(err) => {
                                log::error!("Autosave failed for {}: {err:#}", inner.path);
                                *inner.last_error.borrow_mut() = Some(format!("{err:#}"));
                                break;
                            }
                        }
                    }
                    if !inner.dirty.get() {
                        break;
                    }
                }
                inner.saving.set(false);
                if inner.closed.get() {
                    *inner.writer.borrow_mut() = None;
                } else if inner.dirty.get() {
                    this.run_save_loop();
                    return;
                }
                if !inner.dirty.get() {
                    for tx in inner.clean_waiters.borrow_mut().drain(..) {
                        let _ = tx.send(());
                    }
                }
                inner.changed.emit();
            }
            .boxed_local(),
        );
    }
}
