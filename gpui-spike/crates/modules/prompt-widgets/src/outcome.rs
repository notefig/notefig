//! What a settled round leaves behind: a port of the outcome half of
//! `@notefig/widgets` `prompt/state.ts` (`deriveRoundOutcome`,
//! `readWidgetResponse`, `deriveTouchedFiles`). The face's other
//! derivations (status lines, choice keys) are the view's.
//!
//! This is where a `widget_respond` call lands: the MCP tool only validates
//! and acknowledges (`{"recorded": true}`, in `notefig-agent`'s MCP layer);
//! the record is the call's `tool_call` transcript entry, and the round's
//! outcome reads the response back from it when the round settles.

use notefig_agent::mcp::tools::{ToolInput, WIDGET_RESPOND_TOOL_NAME, WidgetResponse, validate};
use notefig_agent::model::{AgentEntry, EntryType, ToolCallContentView, ToolCallView, sort_entries};
use serde::{Deserialize, Serialize};

/// What a settled round leaves behind, snapshotted when it settles.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundOutcome {
    pub response: Option<WidgetResponse>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub touched_files: Vec<String>,
}

/// `isMutatingToolCall`.
pub fn is_mutating_tool_call(call: &ToolCallView) -> bool {
    call.is_mutating()
}

/// One call's response: a `widget_respond` call whose input validates.
pub fn read_widget_response(call: &ToolCallView) -> Option<WidgetResponse> {
    if call.title.as_deref() != Some(WIDGET_RESPOND_TOOL_NAME) {
        return None;
    }
    match validate(WIDGET_RESPOND_TOOL_NAME, call.raw_input.as_ref()?) {
        Ok(ToolInput::WidgetRespond(r)) => Some(r),
        _ => None,
    }
}

/// `deriveWidgetResponse`: the last valid `widget_respond` (entries in order).
pub fn derive_widget_response(entries: &[AgentEntry]) -> Option<WidgetResponse> {
    entries
        .iter()
        .rev()
        .filter(|e| e.kind == EntryType::ToolCall)
        .find_map(|e| read_widget_response(&e.tool_call_view()?))
}

/// `deriveLatestAssistantLine`: the last assistant entry's text, trimmed;
/// `None` when it is empty.
pub fn derive_latest_assistant_line(entries: &[AgentEntry]) -> Option<String> {
    let entry = entries.iter().rev().find(|e| e.kind == EntryType::Assistant)?;
    let text = entry.text.as_deref()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Collapse `.` and `..` segments (`normalizeSlashPath`).
fn normalize_slash_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        if segment == "." {
            continue;
        }
        if segment == ".." && out.len() > 1 {
            out.pop();
        } else if segment != ".." {
            out.push(segment);
        }
    }
    out.join("/")
}

/// `deriveTouchedFiles`: documents the turn changed. Locations first; diff
/// items (resolved against the workspace when relative) when a call has none.
pub fn derive_touched_files(entries: &[AgentEntry], workspace_path: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    let mut add = |p: String| {
        if !paths.contains(&p) {
            paths.push(p);
        }
    };
    for entry in entries.iter().filter(|e| e.kind == EntryType::ToolCall) {
        let Some(call) = entry.tool_call_view() else { continue };
        if !call.is_mutating() {
            continue;
        }
        for location in &call.locations {
            add(location.clone());
        }
        if call.locations.is_empty() {
            for item in &call.content {
                if let ToolCallContentView::Diff { path, .. } = item {
                    let full = if path.starts_with('/') {
                        path.clone()
                    } else {
                        format!("{}/{path}", workspace_path.strip_suffix('/').unwrap_or(workspace_path))
                    };
                    add(normalize_slash_path(&full));
                }
            }
        }
    }
    paths
}

/// `deriveRoundOutcome`: entries in any order.
pub fn derive_round_outcome(entries: &[AgentEntry], error: Option<String>, workspace_path: &str) -> RoundOutcome {
    let mut sorted = entries.to_vec();
    sort_entries(&mut sorted);
    RoundOutcome {
        response: derive_widget_response(&sorted),
        summary: derive_latest_assistant_line(&sorted),
        error,
        touched_files: derive_touched_files(&sorted, workspace_path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn entry(id: &str, kind: EntryType, text: Option<&str>, tool: Option<Value>) -> AgentEntry {
        AgentEntry {
            id: id.into(),
            task_id: "t".into(),
            turn_id: "r".into(),
            kind,
            text: text.map(Into::into),
            tool_call_id: None,
            tool_call: tool,
            plan: None,
            raw: None,
            created_at: None,
        }
    }

    #[test]
    fn reads_the_widget_response_the_summary_and_the_files_in_id_order() {
        let entries = vec![
            entry("4", EntryType::ToolCall, None, Some(json!({"toolCallId": "c", "content": [{"type": "diff", "path": "./b.md", "newText": "x"}]}))),
            entry("1", EntryType::ToolCall, None, Some(json!({"toolCallId": "a", "title": "Write", "kind": "edit", "locations": [{"path": "/w/a.md"}]}))),
            entry("2", EntryType::Assistant, Some(" done \n"), None),
            entry("3", EntryType::ToolCall, None, Some(json!({"toolCallId": "b", "title": "widget_respond", "rawInput": {"kind": "answer", "markdown": "ok"}}))),
            entry("5", EntryType::ToolCall, None, Some(json!({"toolCallId": "d", "kind": "read", "locations": [{"path": "/w/c.md"}]}))),
        ];
        let o = derive_round_outcome(&entries, None, "/w/");
        assert_eq!(o.response.unwrap().markdown, "ok");
        assert_eq!(o.summary.as_deref(), Some("done"));
        assert_eq!(o.touched_files, vec!["/w/a.md".to_string(), "/w/b.md".to_string()]);
    }

    #[test]
    fn skips_a_malformed_response_and_an_empty_last_assistant_line() {
        let entries = vec![
            entry("1", EntryType::Assistant, Some("earlier"), None),
            entry("2", EntryType::ToolCall, None, Some(json!({"toolCallId": "b", "title": "widget_respond", "rawInput": {"kind": "answer"}}))),
            entry("3", EntryType::Assistant, Some("   "), None),
        ];
        let o = derive_round_outcome(&entries, Some("boom".into()), "/w");
        assert_eq!(o.response, None);
        assert_eq!(o.summary, None);
        assert_eq!(o.error.as_deref(), Some("boom"));
    }

    #[test]
    fn normalizes_dot_segments() {
        assert_eq!(normalize_slash_path("/w/./a/../b.md"), "/w/b.md");
        assert_eq!(normalize_slash_path("/../x"), "/x");
    }
}
