//! The history agent tools' semantics (desktop/src/modules/agents/tools/
//! history-*.ts), shaped for `notefig_agent::services::AppToolCall`: the
//! agent crate validates input, contains paths and renders the MCP result
//! (`Ok(value)` → text `value.to_string()`, `Err(e)` → `isError` text `e`);
//! these return the same JSON value / error text the TS `execute` did.
//!
//! Each call initializes the repo first, like the TS `history.ready()`.
//! After `history_checkpoint` (and a turn checkpoint) the app should mark
//! its git rows stale (`git:stale`): the commit lands in the hidden gitdir,
//! which the watcher filters out.

use std::path::Path;

use serde_json::{Value, json};

use crate::{HistoryRepo, Signature, checkpoint_message};

/// One `history_log` entry (`HistoryLogEntry` in history-log.ts). Field
/// order is the TS key order: `serde_json::to_string` of these structs is
/// byte-identical to the TS text, while a `Value` (no `preserve_order`)
/// sorts keys alphabetically. Key order carries no meaning in JSON.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HistoryLogEntry {
    pub oid: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
}

/// `history_diff`'s value (`HistoryDiffResult` in history-diff.ts).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDiffResult {
    pub from: String,
    pub to: String,
    pub from_content: String,
    pub to_content: String,
}

/// `history_log { path? }` entries, newest first, unbounded; `message`
/// trimmed, `author` the author's name, `timestamp` the author time in ms.
/// `relative` is the workspace-relative path when scoped to one file.
pub fn history_log_entries(repo: &dyn HistoryRepo, relative: Option<&str>) -> Result<Vec<HistoryLogEntry>, String> {
    repo.ensure_init().map_err(|e| e.message)?;
    let commits = repo.log(None, relative).map_err(|e| e.message)?;
    Ok(commits
        .into_iter()
        .map(|c| HistoryLogEntry {
            oid: c.oid,
            message: c.message.trim().to_string(),
            author: c.author_name,
            timestamp: c.author_time * 1000,
        })
        .collect())
}

/// `history_log { path? }` → `[{oid, message, author, timestamp}]`.
pub fn history_log(repo: &dyn HistoryRepo, relative: Option<&str>) -> Result<Value, String> {
    let entries = history_log_entries(repo, relative)?;
    serde_json::to_value(entries).map_err(|e| e.to_string())
}

/// `history_diff { path, from, to }` → `{from, to, fromContent, toContent}`:
/// the document's text at both checkpoints.
pub fn history_diff(repo: &dyn HistoryRepo, relative: &str, from: &str, to: &str) -> Result<Value, String> {
    repo.ensure_init().map_err(|e| e.message)?;
    let versions = repo.file_versions(relative, from, to).map_err(|e| e.message)?;
    let result = HistoryDiffResult {
        from: from.to_string(),
        to: to.to_string(),
        from_content: versions.from_content,
        to_content: versions.to_content,
    };
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// `history_checkpoint { message }` → `{oid}` (`null` when nothing changed),
/// committed as `agent <agent@notefig.local>`.
pub fn history_checkpoint(repo: &dyn HistoryRepo, message: &str) -> Result<Value, String> {
    repo.ensure_init().map_err(|e| e.message)?;
    let oid = repo.checkpoint(message, &Signature::agent_tool()).map_err(|e| e.message)?;
    Ok(json!({ "oid": oid }))
}

/// The text `history_restore` writes back: the document at `checkpoint`.
pub fn history_restore_content(repo: &dyn HistoryRepo, relative: &str, checkpoint: &str) -> Result<String, String> {
    repo.ensure_init().map_err(|e| e.message)?;
    repo.read_text(checkpoint, relative).map_err(|e| e.message)
}

/// `history_restore { path, checkpoint }` (permission-gated by the agent
/// crate): read the content at `checkpoint` and hand it to `write`, the
/// app's adopting write (`documents.write`), so an open editor picks it up.
/// → `null` (TS: `undefined`, i.e. a text part without `text`).
pub fn history_restore(
    repo: &dyn HistoryRepo,
    relative: &str,
    absolute: &Path,
    checkpoint: &str,
    write: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<Value, String> {
    let content = history_restore_content(repo, relative, checkpoint)?;
    write(absolute, &content)?;
    Ok(Value::Null)
}

/// The checkpoint after a completed agent turn (history.ts's
/// `agent:turn-completed` listener): message = the prompt cut to 72 chars,
/// author = the harness id. Best effort in the app: log, never fail a turn.
pub fn turn_checkpoint(
    repo: &dyn HistoryRepo,
    prompt: &str,
    harness_id: &str,
) -> crate::Result<Option<String>> {
    repo.ensure_init()?;
    repo.checkpoint(&checkpoint_message(prompt), &Signature::harness(harness_id))
}
