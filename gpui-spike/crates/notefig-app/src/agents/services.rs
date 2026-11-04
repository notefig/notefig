//! `ClientServices` answered on the UI thread: ACP `fs/*` (live editor text,
//! the adopting write), the app MCP tools and the widget-context resource.

use std::path::Path;

use gpui::{App, AppContext as _, Context, Entity};
use markdown_editor::BlockEditorModel;
use notefig_agent::prompt::WidgetContextRef;
use notefig_agent::{AppToolCall, ClientRequest};
use serde_json::{Value, json};

use super::Agents;
use crate::document::{DocKind, Document};
use crate::layout::Tab;
use crate::workspace_view::WorkspaceView;

pub fn handle(this: &mut Agents, request: ClientRequest, cx: &mut Context<Agents>) {
    match request {
        ClientRequest::ReadTextFile {
            workspace_path,
            path,
            line,
            limit,
            reply,
            ..
        } => reply.send(read_text(this, &workspace_path, &path, cx).map(|t| slice_lines(&t, line, limit))),
        ClientRequest::WriteTextFile {
            workspace_path,
            path,
            content,
            reply,
            ..
        } => reply.send(write_text(this, &workspace_path, &path, &content, cx)),
        ClientRequest::Tool {
            workspace_path,
            call,
            reply,
            ..
        } => match call {
            AppToolCall::HistoryLog { .. }
            | AppToolCall::HistoryDiff { .. }
            | AppToolCall::HistoryCheckpoint { .. }
            | AppToolCall::HistoryRestore { .. } => history_tool(this, workspace_path, call, reply, cx),
            call => reply.send(tool(this, &workspace_path, call, cx)),
        },
        ClientRequest::WidgetContext {
            workspace_path,
            reference,
            reply,
            ..
        } => reply.send(widget_context(this, &workspace_path, &reference, cx)),
    }
}

/// 1-based `line`, `limit` lines (ACP `fs/read_text_file`).
pub fn slice_lines(text: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return text.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let take = limit.map(|l| l as usize).unwrap_or(usize::MAX);
    let mut out: Vec<&str> = text.split_inclusive('\n').skip(start).take(take).collect();
    if out.is_empty() {
        out.push("");
    }
    out.concat()
}

fn open_doc(view: &Entity<WorkspaceView>, abs: &Path, cx: &App) -> Option<Entity<Document>> {
    let ws = view.read(cx);
    let rel = ws.ws.rel_of(abs)?;
    ws.doc(&rel).cloned()
}

/// The live editor's text when the file is open (unsaved edits included),
/// else disk.
pub fn read_text(this: &Agents, root: &Path, abs: &Path, cx: &App) -> Result<String, String> {
    if let Some((view, _)) = this.workspace_for(root, cx) {
        if let Some(doc) = open_doc(&view, abs, cx) {
            if let Some(text) = doc.read(cx).text(cx) {
                return Ok(text);
            }
        }
    }
    std::fs::read_to_string(abs).map_err(|e| format!("{}: {e}", abs.display()))
}

/// The adopting write: disk first (the watcher echo is suppressed), then
/// the open editor merges it as one undoable agent transaction.
pub fn write_text(
    this: &mut Agents,
    root: &Path,
    abs: &Path,
    content: &str,
    cx: &mut Context<Agents>,
) -> Result<(), String> {
    let Some((view, window)) = this.workspace_for(root, cx) else {
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        return std::fs::write(abs, content).map_err(|e| e.to_string());
    };
    let ws = view.read(cx).ws.clone();
    let rel = ws
        .rel_of(abs)
        .ok_or_else(|| format!("{} is outside the workspace", abs.display()))?;
    let hash = ws.write(&rel, content).map_err(|e| format!("{e:#}"))?;
    let (origin, round) = this.origin_for(abs, content);
    if let Some(doc) = view.read(cx).doc(&rel).cloned() {
        let content = content.to_string();
        let _ = cx.update_window(window, |_, window, cx| {
            doc.update(cx, |doc, cx| {
                // Unsaved user edits win (their save overwrites), as in TS.
                if !doc.has_unsaved_edits() {
                    doc.adopt(&content, hash, origin, round, window, cx);
                }
            })
        });
    }
    view.update(cx, |view, cx| view.rescan(cx));
    Ok(())
}

/// The document model at `abs`: the live editor's (unsaved edits included),
/// else parsed from disk — the coordinate space of `document_read_range`
/// and the widget-context positions.
fn with_model<R>(
    view: Option<&Entity<WorkspaceView>>,
    abs: &Path,
    cx: &App,
    f: impl FnOnce(&BlockEditorModel) -> R,
) -> Result<R, String> {
    if let Some(doc) = view.and_then(|v| open_doc(v, abs, cx)) {
        if let DocKind::Markdown { editor, .. } = &doc.read(cx).kind {
            return Ok(f(editor.read(cx).model()));
        }
    }
    let text = std::fs::read_to_string(abs).map_err(|e| format!("{}: {e}", abs.display()))?;
    let model = BlockEditorModel::from_markdown(&text, Default::default()).map_err(|e| e.to_string())?;
    Ok(f(&model))
}

fn open_files(view: &Entity<WorkspaceView>, cx: &App) -> (Vec<Value>, Option<String>, bool) {
    let ws = view.read(cx);
    let root = ws.ws.root().to_path_buf();
    let active = ws.layout.active_tab().and_then(|t| t.rel().map(String::from));
    let mut seen = Vec::new();
    let mut tabs = Vec::new();
    for tab in ws.layout.all_tabs() {
        let Tab::File { rel } = tab else { continue };
        if seen.contains(&rel) {
            continue;
        }
        seen.push(rel.clone());
        let dirty = ws.doc(&rel).is_some_and(|d| d.read(cx).is_dirty());
        tabs.push(json!({
            "path": root.join(&rel).to_string_lossy(),
            "active": active.as_deref() == Some(rel.as_str()),
            "dirty": dirty,
        }));
    }
    let has_selection = ws
        .active_doc()
        .and_then(|d| match &d.read(cx).kind {
            DocKind::Markdown { editor, .. } => {
                Some(!editor.read(cx).selection().is_collapsed())
            }
            _ => None,
        })
        .unwrap_or(false);
    let active_abs = active.map(|r| root.join(r).to_string_lossy().into_owned());
    (tabs, active_abs, has_selection)
}

pub fn tool(this: &mut Agents, root: &Path, call: AppToolCall, cx: &mut Context<Agents>) -> Result<Value, String> {
    let view = this.workspace_for(root, cx).map(|(v, _)| v);
    match call {
        AppToolCall::ListDocuments => {
            let tree = match &view {
                Some(v) => v.read(cx).tree().clone(),
                None => notefig_workspace::Workspace::open(root)
                    .and_then(|w| w.scan())
                    .map_err(|e| format!("{e:#}"))?,
            };
            Ok(Value::Array(
                tree.values()
                    .map(|e| {
                        json!({
                            "path": e.rel,
                            "type": if e.is_dir() { "directory" } else { "file" },
                            "title": e.name(),
                        })
                    })
                    .collect(),
            ))
        }
        AppToolCall::ReadDocument { path, line, limit, .. } => {
            read_text(this, root, &path, cx).map(|t| Value::String(slice_lines(&t, line, limit)))
        }
        AppToolCall::OpenFiles => {
            let (tabs, active, has_selection) = match &view {
                Some(v) => open_files(v, cx),
                None => (vec![], None, false),
            };
            Ok(json!({"tabs": tabs, "activeFile": active, "hasSelection": has_selection}))
        }
        AppToolCall::DocumentReadRange { path, from, to, .. } => {
            let range = with_model(view.as_ref(), &path, cx, |m| {
                m.document_read_range(from as usize, to as usize)
            })?;
            Ok(json!({"content": range.content, "from": range.from, "to": range.to, "docSize": range.doc_size}))
        }
        call => Err(format!("{} runs asynchronously", call.name())),
    }
}

/// `history_*` on the background executor; `history_restore` writes the
/// old content back through the adopting write (an open editor merges it).
fn history_tool(
    this: &mut Agents,
    root: std::path::PathBuf,
    call: AppToolCall,
    reply: notefig_agent::Reply<Result<Value, String>>,
    cx: &mut Context<Agents>,
) {
    use notefig_history::tools;
    let repo = this.history.get(&root);
    cx.spawn(async move |this, cx| {
        let restore = matches!(call, AppToolCall::HistoryRestore { .. });
        let result = cx
            .background_executor()
            .spawn({
                let call = call.clone();
                async move {
                    match &call {
                        AppToolCall::HistoryLog { path } => {
                            tools::history_log(&*repo, path.as_ref().map(|(_, rel)| rel.as_str()))
                        }
                        AppToolCall::HistoryDiff { relative, from, to, .. } => {
                            tools::history_diff(&*repo, relative, from, to)
                        }
                        AppToolCall::HistoryCheckpoint { message } => tools::history_checkpoint(&*repo, message),
                        AppToolCall::HistoryRestore { relative, checkpoint, .. } => {
                            tools::history_restore_content(&*repo, relative, checkpoint).map(Value::String)
                        }
                        _ => Err("not a history tool".into()),
                    }
                }
            })
            .await;
        let result = match (restore, result, call) {
            (true, Ok(Value::String(content)), AppToolCall::HistoryRestore { path, .. }) => this
                .update(cx, |this, cx| write_text(this, &root, &path, &content, cx))
                .unwrap_or_else(|_| Err("the app closed".into()))
                .map(|()| Value::Null),
            (_, result, _) => result,
        };
        reply.send(result);
    })
    .detach();
}

/// `notefig://widget-context?…`: the widget's surroundings, computed fresh
/// (the TS `buildWidgetContextPayload`).
fn widget_context(this: &Agents, root: &Path, r: &WidgetContextRef, cx: &App) -> Result<Value, String> {
    let view = this.workspace_for(root, cx).map(|(v, _)| v);
    let abs = root.join(&r.path);
    let pos = r.pos.max(0) as usize;
    let (outline, heading, surrounding) = with_model(view.as_ref(), &abs, cx, |m| {
        (
            m.outline(),
            m.nearest_preceding_heading(pos).map(|h| h.text),
            m.window_around_pos(pos, 2000),
        )
    })?;
    let selected_text = view
        .as_ref()
        .and_then(|v| open_doc(v, &abs, cx))
        .and_then(|d| match &d.read(cx).kind {
            DocKind::Markdown { editor, .. } => {
                let model = editor.read(cx).model();
                let (from, to) = model.pm_selection()?;
                (from != to).then(|| model.pm_text_between(from, to, "\n", None))
            }
            _ => None,
        });
    let other_open: Vec<Value> = match &view {
        Some(v) => open_files(v, cx)
            .0
            .into_iter()
            .filter(|t| t["path"].as_str() != Some(&abs.to_string_lossy()))
            .collect(),
        None => vec![],
    };
    let title = outline
        .first()
        .map(|h| h.text.clone())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| notefig_workspace::file_name(&r.path).to_string());
    Ok(json!({
        "documentTitle": title,
        "documentPath": r.path,
        "outline": outline.iter().map(|h| json!({"level": h.level, "text": h.text})).collect::<Vec<_>>(),
        "position": {"headingText": heading},
        "surroundingText": surrounding,
        "selectedText": selected_text,
        "selectedRange": r.selected_range.map(|s| json!({"from": s.from, "to": s.to})),
        "otherOpenFiles": other_open,
    }))
}

#[cfg(test)]
mod tests {
    use super::slice_lines;

    #[test]
    fn slices_lines() {
        let t = "a\nb\nc\n";
        assert_eq!(slice_lines(t, None, None), t);
        assert_eq!(slice_lines(t, Some(2), Some(1)), "b\n");
        assert_eq!(slice_lines(t, Some(2), None), "b\nc\n");
        assert_eq!(slice_lines(t, Some(9), None), "");
    }
}

