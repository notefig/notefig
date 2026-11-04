//! What a task's tools and ACP fs requests reach in the app: a port of
//! `modules/agents/tools/*` and the `ToolServices` the TS agent service
//! hands each tool (`ctx.services`).
//!
//! The tool schemas, validation, workspace containment and the MCP server
//! are `notefig_agent::mcp` (as `packages/agent` in TS); a call arrives here
//! validated, as an [`AppToolCall`], and is answered on the main thread.
//!
//! `ToolServices` in TS is widened by declaration merging: each module that
//! serves tools declares its part (`history`, `files`, `documents`,
//! `layout`, `editors`). The Rust form: each part is a trait here, and the
//! module that owns it provides its implementation with
//! [`ToolServices::provide_documents`] and friends during its `boot`. Until
//! a part is provided, reads and writes go to the platform fs and the tools
//! that need it answer "not available".

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agent::prompt::WidgetContextRef;
use notefig_agent::services::{AppToolCall, ClientRequest, slice_lines};
use notefig_platform::FileSystem;
use serde_json::{Value, json};

/// `documents` (`DocumentsApi`): reading and adopting writes of a text
/// file, open in an editor or not. A write adopts into any live editor as
/// one undoable change.
pub trait DocumentsService {
    fn read(&self, path: &str) -> LocalBoxFuture<'static, Result<String, String>>;
    fn write(&self, task_id: &str, path: &str, content: String) -> LocalBoxFuture<'static, Result<(), String>>;
}

/// The shell's documents module serves reads and adopting writes.
pub(crate) struct ShellDocuments(pub Rc<notefig_documents::DocumentsApi>);

impl DocumentsService for ShellDocuments {
    fn read(&self, path: &str) -> LocalBoxFuture<'static, Result<String, String>> {
        let fut = self.0.read(path, notefig_documents::ReadRange::default());
        async move { fut.await.map_err(|e| e.to_string()) }.boxed_local()
    }

    fn write(&self, _task_id: &str, path: &str, content: String) -> LocalBoxFuture<'static, Result<(), String>> {
        let fut = self.0.write(path, &content);
        async move { fut.await.map_err(|e| e.to_string()) }.boxed_local()
    }
}

/// `editors` + `layout`: what the user has open and sees.
pub trait EditorsService {
    /// `workspace_open_files`.
    fn open_files(&self, workspace_path: &str) -> Result<Value, String>;
    /// `document_read_range` (editor positions).
    fn read_range(&self, path: &str, from: u64, to: u64) -> Result<Value, String>;
    /// The `notefig-widget://` context resource of an in-document prompt.
    fn widget_context(&self, workspace_path: &str, reference: &WidgetContextRef) -> Result<Value, String>;
}

/// `history`: the workspace's checkpoint repo.
pub trait HistoryService {
    fn call(&self, workspace_path: &str, call: AppToolCall) -> LocalBoxFuture<'static, Result<Value, String>>;
}

/// The services tools reach.
pub struct ToolServices {
    fs: Rc<dyn FileSystem>,
    documents: RefCell<Option<Rc<dyn DocumentsService>>>,
    editors: RefCell<Option<Rc<dyn EditorsService>>>,
    history: RefCell<Option<Rc<dyn HistoryService>>>,
}

impl ToolServices {
    pub(crate) fn new(fs: Rc<dyn FileSystem>) -> Self {
        Self {
            fs,
            documents: RefCell::default(),
            editors: RefCell::default(),
            history: RefCell::default(),
        }
    }

    pub fn provide_documents(&self, documents: Rc<dyn DocumentsService>) {
        *self.documents.borrow_mut() = Some(documents);
    }

    pub fn provide_editors(&self, editors: Rc<dyn EditorsService>) {
        *self.editors.borrow_mut() = Some(editors);
    }

    pub fn provide_history(&self, history: Rc<dyn HistoryService>) {
        *self.history.borrow_mut() = Some(history);
    }

    /// Read a text file as the agent sees it: the documents module's read.
    pub fn read(&self, path: &str) -> LocalBoxFuture<'static, Result<String, String>> {
        if let Some(documents) = self.documents.borrow().clone() {
            return documents.read(path);
        }
        let fut = self.fs.read_files(vec![path.to_string()]);
        async move {
            let mut out = fut.await;
            match out.succeeded.pop() {
                Some((_, content)) => Ok(content),
                None => Err(out.failed.pop().map(|e| e.to_string()).unwrap_or_else(|| "read failed".into())),
            }
        }
        .boxed_local()
    }

    /// The adopting write (disk, then every live editor as one undoable
    /// change): what `history_restore` and ACP `fs/write_text_file` use.
    pub fn write(&self, task_id: &str, path: &str, content: String) -> LocalBoxFuture<'static, Result<(), String>> {
        if let Some(documents) = self.documents.borrow().clone() {
            return documents.write(task_id, path, content);
        }
        let fut = self.fs.write_files(vec![(path.to_string(), content)]);
        async move {
            let mut out = fut.await;
            match out.failed.pop() {
                Some(e) => Err(e.to_string()),
                None => Ok(()),
            }
        }
        .boxed_local()
    }

    /// `workspace_list_documents`: every markdown/text file under the root.
    fn list_documents(&self, workspace_path: &str) -> LocalBoxFuture<'static, Result<Value, String>> {
        let fut = self
            .fs
            .read_directory(workspace_path, notefig_platform::ReadDirectoryOptions::all_recursive());
        let root = workspace_path.to_string();
        async move {
            let entries = fut.await.map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for entry in entries {
                let relative = entry.path.strip_prefix(&root).unwrap_or(&entry.path).trim_start_matches('/');
                if relative.split('/').any(|p| p.starts_with('.')) {
                    continue;
                }
                let is_dir = entry.kind == notefig_platform::EntryType::Directory;
                let title = Path::new(relative)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push(json!({
                    "path": relative,
                    "type": if is_dir { "directory" } else { "file" },
                    "title": title,
                }));
            }
            Ok(Value::Array(out))
        }
        .boxed_local()
    }

    /// Answer one request from the runtime.
    pub(crate) fn serve(self: &Rc<Self>, request: ClientRequest) -> LocalBoxFuture<'static, ()> {
        let this = self.clone();
        async move {
            match request {
                ClientRequest::ReadTextFile { path, line, limit, reply, .. } => {
                    let result = this.read(&path.to_string_lossy()).await;
                    reply.send(result.map(|c| slice_lines(&c, line, limit)));
                }
                ClientRequest::WriteTextFile { task_id, path, content, reply, .. } => {
                    reply.send(this.write(&task_id, &path.to_string_lossy(), content).await);
                }
                ClientRequest::Tool { workspace_path, call, reply, .. } => {
                    let ws = workspace_path.to_string_lossy().into_owned();
                    let result = match call {
                        AppToolCall::ListDocuments => this.list_documents(&ws).await,
                        AppToolCall::ReadDocument { path, line, limit, .. } => this
                            .read(&path.to_string_lossy())
                            .await
                            .map(|c| Value::String(slice_lines(&c, line, limit))),
                        AppToolCall::OpenFiles => match this.editors.borrow().clone() {
                            Some(editors) => editors.open_files(&ws),
                            None => Ok(json!({"tabs": [], "activeFile": null, "hasSelection": false})),
                        },
                        AppToolCall::DocumentReadRange { path, from, to, .. } => {
                            match this.editors.borrow().clone() {
                                Some(editors) => editors.read_range(&path.to_string_lossy(), from, to),
                                None => Err("document_read_range needs an open editor".into()),
                            }
                        }
                        call @ (AppToolCall::HistoryLog { .. }
                        | AppToolCall::HistoryDiff { .. }
                        | AppToolCall::HistoryCheckpoint { .. }
                        | AppToolCall::HistoryRestore { .. }) => {
                            let history = this.history.borrow().clone();
                            match history {
                                Some(history) => history.call(&ws, call).await,
                                None => Err(format!("{} is not available: no history for this workspace", call.name())),
                            }
                        }
                    };
                    reply.send(result);
                }
                ClientRequest::WidgetContext { workspace_path, reference, reply, .. } => {
                    let ws = workspace_path.to_string_lossy().into_owned();
                    let result = match this.editors.borrow().clone() {
                        Some(editors) => editors.widget_context(&ws, &reference),
                        None => {
                            // No live editor: the document as on disk.
                            let path = Path::new(&ws).join(&reference.path);
                            this.read(&path.to_string_lossy()).await.map(|text| {
                                json!({"path": reference.path, "pos": reference.pos, "text": text})
                            })
                        }
                    };
                    reply.send(result);
                }
            }
        }
        .boxed_local()
    }
}
