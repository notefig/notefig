//! The `editors` module — `core.editors`: a port of
//! `packages/desktop/src/modules/editors/`. The registry of live editor
//! instances, and the handle over a document's editor whether or not its
//! surface is up yet.
//!
//! The instances are built by the views (the editor host in
//! `views/workspace` builds one per open markdown, code or image tab) and
//! register here as `Rc<dyn EditorInstance>` — the trait object stands in
//! for TS's live Tiptap/viewer instance. Everything else (tabs, documents,
//! agent tools) is handed this registry and never touches a view. There is
//! no module-scope registry: two cores hold two sets of editors.
//!
//! "Mounted" is the moment an instance can act on its surface; a
//! [`EditorsApi::go_to`] that arrives earlier waits for it (bounded).

mod editor_type;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{LocalBoxFuture, ready};
use notefig_core::{Executor, Listeners, Module, ModuleContext, Subscription};

pub use editor_type::{EditorType, can_open_file, editor_type, file_extension, is_image_file, is_text_file};

/// `SearchTarget`: a match in a file (its text, its line, and which
/// occurrence of that text it is).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchTarget {
    pub match_text: String,
    pub line_text: String,
    /// 0-based, among matches with the same text in the file.
    pub occurrence: u32,
}

/// `EditorTarget`: a search match, or a widget block by its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditorTarget {
    Search(SearchTarget),
    Block { block_id: String },
}

/// Which prompt round wrote some bytes (`core.turnWrites.attribute`):
/// `(path, content_hash) -> round id`.
pub type Attribute = Rc<dyn Fn(&str, &str) -> Option<String>>;

/// `AdoptionSource`: where adopted content came from.
#[derive(Clone)]
pub struct AdoptionSource {
    pub path: String,
    pub content_hash: String,
    pub attribute: Option<Attribute>,
}

/// What an adoption did (`adoptExternalContent`'s result).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Adoption {
    /// Prompt widgets the new content dropped that the editor kept; the
    /// file must be rewritten with them.
    pub reinserted_widgets: usize,
}

/// What every live editor instance implements (`EditorInstance` and
/// `MarkdownInstance` in TS, folded into one trait: the markdown-only
/// methods default to "not a markdown editor").
///
/// GPUI note: an implementation wraps an entity, which it can only touch
/// with an `App`. Implementations keep an `AsyncApp` and run mutations from
/// the futures they return (so they never re-enter an update), and answer
/// the sync getters from state they cache on every edit.
pub trait EditorInstance {
    fn editor_type(&self) -> EditorType;
    /// Focus, leaving the selection. `steal` marks an explicit hand-off.
    fn focus(&self, steal: bool) -> bool;
    fn dispose(&self);
    fn is_focusable(&self) -> bool;
    /// Move to a location (only called on a mounted instance).
    fn go_to(&self, target: EditorTarget) -> LocalBoxFuture<'static, bool>;
    fn selected_text(&self) -> Option<String>;

    /// The live document as markdown (markdown editors only).
    fn markdown(&self) -> Option<String> {
        None
    }
    /// The file's text as shown, for any text editor (the code viewer too):
    /// the status bar's word count.
    fn text(&self) -> Option<String> {
        self.markdown()
    }
    /// Freeze or unfreeze editing (a rename in flight).
    fn set_editable(&self, _editable: bool) {}
    /// The surface is gone (`editor.isDestroyed`).
    fn is_destroyed(&self) -> bool {
        false
    }
    /// Replace the document with `content` as ONE undoable change, keeping
    /// bound prompt widgets (`adoptExternalContent`). `None` when this is
    /// not a markdown editor or the editor rejected the content.
    fn adopt(&self, _content: String, _source: AdoptionSource) -> LocalBoxFuture<'static, Option<Adoption>> {
        ready(None).boxed_local()
    }
}

/// How long a `go_to` waits for its editor to mount.
pub const MOUNT_WAIT: Duration = Duration::from_millis(5_000);

/// `EditorHandle`: the file-tab half of a tab's API (`tab(id).editor`).
#[derive(Clone)]
pub struct EditorHandle {
    file_path: String,
    editors: Rc<Inner>,
}

impl EditorHandle {
    pub fn file_path(&self) -> &str {
        &self.file_path
    }
    pub fn is_mounted(&self) -> bool {
        self.editors.instances.borrow().contains_key(&self.file_path)
    }
    /// Unsaved changes, from the documents module's sync.
    pub fn is_dirty(&self) -> bool {
        let dirty = self.editors.dirty.borrow().clone();
        dirty.is_some_and(|f| f(&self.file_path))
    }
    pub fn is_focusable(&self) -> bool {
        instance(&self.editors, &self.file_path).is_some_and(|i| i.is_focusable())
    }
    pub fn markdown_text(&self) -> Option<String> {
        instance(&self.editors, &self.file_path).and_then(|i| i.markdown())
    }
    /// The text of any text editor (markdown or code).
    pub fn text(&self) -> Option<String> {
        instance(&self.editors, &self.file_path).and_then(|i| i.text())
    }
    pub fn selected_text(&self) -> Option<String> {
        instance(&self.editors, &self.file_path).and_then(|i| i.selected_text())
    }
    pub fn go_to(&self, target: EditorTarget) -> LocalBoxFuture<'static, bool> {
        go_to(&self.editors, &self.file_path, target, MOUNT_WAIT)
    }
}

struct Inner {
    executor: Rc<dyn Executor>,
    instances: RefCell<HashMap<String, Rc<dyn EditorInstance>>>,
    mounted: RefCell<HashSet<String>>,
    waiters: RefCell<HashMap<String, Vec<oneshot::Sender<()>>>>,
    dirty: RefCell<Option<Rc<dyn Fn(&str) -> bool>>>,
    changed: Listeners<()>,
}

fn instance(inner: &Inner, path: &str) -> Option<Rc<dyn EditorInstance>> {
    inner.instances.borrow().get(path).cloned()
}

fn when_mounted(inner: &Rc<Inner>, path: &str, timeout: Duration) -> LocalBoxFuture<'static, Option<Rc<dyn EditorInstance>>> {
    if inner.mounted.borrow().contains(path) {
        return ready(instance(inner, path)).boxed_local();
    }
    let (tx, rx) = oneshot::channel();
    inner.waiters.borrow_mut().entry(path.to_string()).or_default().push(tx);
    let timer = inner.executor.timer(timeout);
    let inner = inner.clone();
    let path = path.to_string();
    async move {
        let mut rx = rx.fuse();
        let mut timer = timer.fuse();
        futures::select! {
            r = rx => if r.is_ok() { instance(&inner, &path) } else { None },
            _ = timer => None,
        }
    }
    .boxed_local()
}

fn go_to(inner: &Rc<Inner>, path: &str, target: EditorTarget, timeout: Duration) -> LocalBoxFuture<'static, bool> {
    let mounted = when_mounted(inner, path, timeout);
    async move {
        match mounted.await {
            Some(i) => i.go_to(target).await,
            None => false,
        }
    }
    .boxed_local()
}

/// `core.editors`.
pub struct EditorsApi {
    inner: Rc<Inner>,
}

/// The registry, with the executor its mount waits time out on.
pub fn create_editors(executor: Rc<dyn Executor>) -> EditorsApi {
    EditorsApi {
        inner: Rc::new(Inner {
            executor,
            instances: RefCell::default(),
            mounted: RefCell::default(),
            waiters: RefCell::default(),
            dirty: RefCell::default(),
            changed: Listeners::new(),
        }),
    }
}

impl EditorsApi {
    // --- Filled by the tab surfaces -------------------------------------

    /// A surface built an instance for the file.
    pub fn register(&self, file_path: &str, instance: Rc<dyn EditorInstance>) {
        self.inner.instances.borrow_mut().insert(file_path.to_string(), instance);
        self.inner.changed.emit();
    }

    /// Forget an instance; its surface counts as unmounted.
    pub fn unregister(&self, file_path: &str) {
        self.inner.instances.borrow_mut().remove(file_path);
        self.inner.mounted.borrow_mut().remove(file_path);
        self.inner.changed.emit();
    }

    /// The surface can act now: a `go_to` waiting for it runs.
    pub fn mark_mounted(&self, file_path: &str) {
        if !self.inner.instances.borrow().contains_key(file_path) {
            return;
        }
        self.inner.mounted.borrow_mut().insert(file_path.to_string());
        let waiters = self.inner.waiters.borrow_mut().remove(file_path).unwrap_or_default();
        for tx in waiters {
            let _ = tx.send(());
        }
        self.inner.changed.emit();
    }

    pub fn mark_unmounted(&self, file_path: &str) {
        self.inner.mounted.borrow_mut().remove(file_path);
    }

    // --- Read by everything else ----------------------------------------

    pub fn instance(&self, file_path: &str) -> Option<Rc<dyn EditorInstance>> {
        instance(&self.inner, file_path)
    }

    /// The live markdown editor of a document, if one is open.
    pub fn markdown_editor(&self, file_path: &str) -> Option<Rc<dyn EditorInstance>> {
        self.instance(file_path).filter(|i| i.editor_type() == EditorType::Markdown)
    }

    pub fn paths(&self) -> Vec<String> {
        self.inner.instances.borrow().keys().cloned().collect()
    }

    pub fn is_mounted(&self, file_path: &str) -> bool {
        self.inner.mounted.borrow().contains(file_path)
    }

    pub fn selected_text(&self, file_path: &str) -> Option<String> {
        self.instance(file_path).and_then(|i| i.selected_text())
    }

    /// The instance once mounted (now if it is), or `None` after `timeout`.
    pub fn when_mounted(&self, file_path: &str, timeout: Duration) -> LocalBoxFuture<'static, Option<Rc<dyn EditorInstance>>> {
        when_mounted(&self.inner, file_path, timeout)
    }

    /// Move a file's editor to `target`, waiting for it to mount.
    pub fn go_to(&self, file_path: &str, target: EditorTarget) -> LocalBoxFuture<'static, bool> {
        go_to(&self.inner, file_path, target, MOUNT_WAIT)
    }

    /// The handle over a file's editor, mounted or not.
    pub fn get(&self, file_path: &str) -> EditorHandle {
        EditorHandle {
            file_path: file_path.to_string(),
            editors: self.inner.clone(),
        }
    }

    /// Where `EditorHandle::is_dirty` reads from. The documents module sets
    /// this at registration: TS reads a module-scope sync registry here,
    /// which the Rust port keeps as state of the module that owns it.
    pub fn set_dirty_source(&self, dirty: Rc<dyn Fn(&str) -> bool>) {
        *self.inner.dirty.borrow_mut() = Some(dirty);
    }

    /// Called when an instance registers, unregisters or mounts.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.changed.subscribe(move |_| listener())
    }
}

/// `editorsModule`.
pub struct EditorsModule;

impl Module for EditorsModule {
    const NAME: &'static str = "editors";
    type Api = EditorsApi;
    type Workspace = ();

    fn register(ctx: &ModuleContext) -> EditorsApi {
        create_editors(ctx.executor())
    }
}

// ---------------------------------------------------------------------------
// One-shot editor context for agent tools.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenFileContext {
    pub path: String,
    pub dirty: bool,
    pub active: bool,
}

/// `WorkspaceEditorContext`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEditorContext {
    pub open_files: Vec<OpenFileContext>,
    pub active_file: Option<String>,
    /// Whether the active file has a non-empty selection.
    pub selection: Option<bool>,
}

/// Whether `path` is `workspace` or inside it — tree membership, not a
/// string prefix (`/ws-backup` is not in `/ws`).
pub fn is_in_tree(workspace: &str, path: &str) -> bool {
    let ws = workspace.trim_end_matches(['/', '\\']);
    path == ws || path.strip_prefix(ws).is_some_and(|rest| rest.starts_with(['/', '\\']))
}

/// `getWorkspaceEditorContext`: what the user has open in one workspace,
/// the layout's tabs joined with their editors' state. Not reactive.
pub fn workspace_editor_context(
    editors: &EditorsApi,
    open_tab_ids: &[String],
    selected_tab: Option<&str>,
    workspace_path: &str,
) -> WorkspaceEditorContext {
    let in_ws = |p: &str| is_in_tree(workspace_path, p);
    WorkspaceEditorContext {
        open_files: open_tab_ids
            .iter()
            .filter(|p| in_ws(p))
            .map(|p| OpenFileContext {
                path: p.clone(),
                dirty: editors.get(p).is_dirty(),
                active: Some(p.as_str()) == selected_tab,
            })
            .collect(),
        active_file: selected_tab.filter(|p| in_ws(p)).map(str::to_string),
        selection: selected_tab.map(|p| editors.selected_text(p).is_some()),
    }
}

#[cfg(test)]
mod tests;
