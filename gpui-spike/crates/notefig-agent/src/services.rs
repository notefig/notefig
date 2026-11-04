//! The seam for what only the app knows (ARCHITECTURE "ClientServices"):
//! ACP `fs/*` (the adopting write into a live editor), the app MCP tools
//! that need workspace/editor/history state, and widget-context payloads.
//! Each request carries a one-shot [`Reply`], so the app may answer later,
//! from its UI thread. Paths are already contained in the workspace.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::prompt::WidgetContextRef;

/// A one-shot reply. Dropping it unanswered fails the request.
pub struct Reply<T>(async_channel::Sender<T>);

impl<T> Reply<T> {
    pub fn send(self, value: T) {
        let _ = self.0.try_send(value);
    }
}

impl<T> std::fmt::Debug for Reply<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Reply")
    }
}

pub fn reply_pair<T>() -> (Reply<T>, async_channel::Receiver<T>) {
    let (tx, rx) = async_channel::bounded(1);
    (Reply(tx), rx)
}

/// A validated app MCP tool call (`widget_respond` is answered by this
/// crate and never reaches the app). Paths are absolute + contained, with
/// the workspace-relative spelling alongside.
#[derive(Debug, Clone, PartialEq)]
pub enum AppToolCall {
    /// `workspace_list_documents` → `[{path, type: "file"|"directory", title}]`.
    ListDocuments,
    /// `workspace_read_document` → the text (1-based `line` + `limit`).
    ReadDocument {
        path: PathBuf,
        relative: String,
        line: Option<u64>,
        limit: Option<u64>,
    },
    /// `workspace_open_files` → `{tabs, activeFile, hasSelection, …}`.
    OpenFiles,
    /// `document_read_range` → `{content, from, to, docSize}` (editor positions).
    DocumentReadRange {
        path: PathBuf,
        relative: String,
        from: u64,
        to: u64,
    },
    /// `history_log` → `[{oid, message, author, timestamp}]`.
    HistoryLog { path: Option<(PathBuf, String)> },
    /// `history_diff` → `{from, to, fromContent, toContent}`.
    HistoryDiff {
        path: PathBuf,
        relative: String,
        from: String,
        to: String,
    },
    /// `history_checkpoint` → `{oid}`.
    HistoryCheckpoint { message: String },
    /// `history_restore` (already permission-gated) → null.
    HistoryRestore {
        path: PathBuf,
        relative: String,
        checkpoint: String,
    },
}

impl AppToolCall {
    pub fn name(&self) -> &'static str {
        match self {
            AppToolCall::ListDocuments => "workspace_list_documents",
            AppToolCall::ReadDocument { .. } => "workspace_read_document",
            AppToolCall::OpenFiles => "workspace_open_files",
            AppToolCall::DocumentReadRange { .. } => "document_read_range",
            AppToolCall::HistoryLog { .. } => "history_log",
            AppToolCall::HistoryDiff { .. } => "history_diff",
            AppToolCall::HistoryCheckpoint { .. } => "history_checkpoint",
            AppToolCall::HistoryRestore { .. } => "history_restore",
        }
    }
}

#[derive(Debug)]
pub enum ClientRequest {
    /// ACP `fs/read_text_file` (1-based `line`, `limit` lines).
    ReadTextFile {
        task_id: String,
        workspace_path: PathBuf,
        path: PathBuf,
        line: Option<u64>,
        limit: Option<u64>,
        reply: Reply<Result<String, String>>,
    },
    /// ACP `fs/write_text_file`: write to disk and adopt into any live editor.
    WriteTextFile {
        task_id: String,
        workspace_path: PathBuf,
        path: PathBuf,
        content: String,
        reply: Reply<Result<(), String>>,
    },
    /// An app MCP tool call; reply with the tool's JSON value or an error.
    Tool {
        task_id: String,
        workspace_path: PathBuf,
        call: AppToolCall,
        reply: Reply<Result<Value, String>>,
    },
    /// MCP `resources/read` of a `notefig://widget-context?…` URI: the
    /// widget's context payload (title, outline, text around, selection…).
    WidgetContext {
        task_id: String,
        workspace_path: PathBuf,
        reference: WidgetContextRef,
        reply: Reply<Result<Value, String>>,
    },
}

/// Implemented by the app. Called on the agent thread; must not block —
/// forward the request (e.g. over a channel to the UI thread) and answer
/// through its `reply` whenever ready. See [`ChannelServices`].
pub trait ClientServices: Send + Sync + 'static {
    fn handle(&self, request: ClientRequest);
}

/// Forwards every request to a channel the app drains on its own thread.
pub struct ChannelServices(async_channel::Sender<ClientRequest>);

impl ChannelServices {
    pub fn new() -> (Arc<ChannelServices>, async_channel::Receiver<ClientRequest>) {
        let (tx, rx) = async_channel::unbounded();
        (Arc::new(ChannelServices(tx)), rx)
    }
}

impl ClientServices for ChannelServices {
    fn handle(&self, request: ClientRequest) {
        let _ = self.0.try_send(request);
    }
}

/// Plain-disk services (headless use, tests, the smoke example): fs on
/// disk, `workspace_list_documents` / `workspace_read_document` from the
/// disk, everything editor- or history-bound answered as unavailable.
pub struct DiskServices;

/// Read `limit` lines starting at 1-based `line`.
pub fn slice_lines(content: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let start = line.unwrap_or(1).saturating_sub(1) as usize;
    let lines = content.split_inclusive('\n').skip(start);
    match limit {
        Some(limit) => lines.take(limit as usize).collect(),
        None => lines.collect(),
    }
}

fn list_documents(root: &Path) -> Value {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<Value>) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        let mut items: Vec<_> = read.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            out.push(json!({"path": rel, "type": if is_dir { "directory" } else { "file" }, "title": name}));
            if is_dir {
                walk(root, &path, out);
            }
        }
    }
    let mut out = vec![];
    walk(root, root, &mut out);
    Value::Array(out)
}

impl ClientServices for DiskServices {
    fn handle(&self, request: ClientRequest) {
        match request {
            ClientRequest::ReadTextFile {
                path,
                line,
                limit,
                reply,
                ..
            } => reply.send(
                std::fs::read_to_string(&path)
                    .map(|c| slice_lines(&c, line, limit))
                    .map_err(|e| format!("{}: {e}", path.display())),
            ),
            ClientRequest::WriteTextFile {
                path,
                content,
                reply,
                ..
            } => reply.send(
                path.parent()
                    .map_or(Ok(()), std::fs::create_dir_all)
                    .and_then(|()| std::fs::write(&path, content))
                    .map_err(|e| format!("{}: {e}", path.display())),
            ),
            ClientRequest::Tool {
                workspace_path,
                call,
                reply,
                ..
            } => reply.send(match call {
                AppToolCall::ListDocuments => Ok(list_documents(&workspace_path)),
                AppToolCall::ReadDocument {
                    path, line, limit, ..
                } => std::fs::read_to_string(&path)
                    .map(|c| Value::String(slice_lines(&c, line, limit)))
                    .map_err(|e| e.to_string()),
                other => Err(format!("{} is not available without the app", other.name())),
            }),
            ClientRequest::WidgetContext { reply, .. } => reply.send(Err(
                "widget context is not available without the app".to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_lines() {
        let c = "a\nb\nc\n";
        assert_eq!(slice_lines(c, Some(2), Some(1)), "b\n");
        assert_eq!(slice_lines(c, Some(2), None), "b\nc\n");
        assert_eq!(slice_lines(c, None, None), c);
    }
}
