//! The face's pure derivations: a port of the view half of
//! `@notefig/widgets` `prompt/state.ts` — the status lines, the done line,
//! a choice question's keys and answer, the queue position, the prompt
//! target, and the card chrome per phase (`blobCardClass`). The outcome
//! half (`deriveRoundOutcome`, `readWidgetResponse`) and the state machine
//! are `notefig_prompt_widgets`'.

use notefig_agent::mcp::WidgetResponse;
use notefig_agent::model::{AgentEntry, AgentTurn, EntryType, TurnStatus};
use notefig_prompt_widgets::BlobPhase;

/// The last path segment.
fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(path)
}

/// `deriveActiveToolLine`: the latest tool call still in flight, labelled by
/// its title and its primary file's basename. Never `""`.
pub fn derive_active_tool_line(entries: &[AgentEntry]) -> Option<String> {
    for entry in entries.iter().rev() {
        if entry.kind != EntryType::ToolCall {
            continue;
        }
        let Some(call) = entry.tool_call_view() else { continue };
        let status = call.status.as_deref().unwrap_or("pending");
        if status != "pending" && status != "in_progress" {
            continue;
        }
        let title = call.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let file = call.locations.first().map(|p| basename(p).trim()).filter(|f| !f.is_empty());
        return match (title, file) {
            (Some(t), Some(f)) => Some(format!("{t} · {f}")),
            (Some(t), None) => Some(t.to_string()),
            (None, Some(f)) => Some(f.to_string()),
            (None, None) => None,
        };
    }
    None
}

/// `deriveLatestAssistantLine`.
pub fn derive_latest_assistant_line(entries: &[AgentEntry]) -> Option<String> {
    let entry = entries.iter().rev().find(|e| e.kind == EntryType::Assistant)?;
    let text = entry.text.as_deref()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `deriveQueuePosition`: how many queued turns run before mine (turn ids
/// ascend).
pub fn derive_queue_position(task_turns: &[AgentTurn], my_turn_id: &str) -> usize {
    task_turns
        .iter()
        .filter(|t| t.status == TurnStatus::Queued && t.turn_id.as_str() < my_turn_id)
        .count()
}

/// `isChoiceKind`.
pub fn is_choice_kind(kind: &str) -> bool {
    kind == "single_choice" || kind == "multiple_choice"
}

/// What `deriveDoneLine` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoneLine {
    pub summary: String,
    pub body: Option<String>,
    pub kind: String,
}

/// Resolved labels (this module stays i18n-free).
pub struct DoneLabels<'a> {
    pub done: &'a str,
    pub stopped: &'a str,
    pub issue: &'a str,
}

/// `deriveDoneLine`: collapsed, the line is the outcome itself — response
/// title, else markdown, else the last assistant text, else Done/Stopped;
/// expanded, only the heading. A choice question is its own heading, whole.
pub fn derive_done_line(
    response: Option<&WidgetResponse>,
    fallback_text: Option<&str>,
    cancelled: bool,
    expanded: bool,
    labels: &DoneLabels,
) -> DoneLine {
    if let Some(r) = response
        && is_choice_kind(&r.kind)
    {
        return DoneLine { summary: r.markdown.clone(), body: None, kind: r.kind.clone() };
    }
    let kind = response.map(|r| r.kind.clone()).unwrap_or_else(|| "answer".into());
    let body = response.map(|r| r.markdown.clone()).or_else(|| fallback_text.map(str::to_string));
    let done = if cancelled { labels.stopped } else { labels.done };
    let kind_label = if kind == "issue" { labels.issue } else { done };
    let title = response.and_then(|r| r.title.clone());
    let summary = if expanded {
        title.unwrap_or_else(|| kind_label.to_string())
    } else {
        title.or_else(|| body.clone()).unwrap_or_else(|| done.to_string())
    };
    DoneLine { summary, body, kind }
}

/// `composeChoiceAnswer`: the picks (one plainly, several as a list), then
/// the typed note.
pub fn compose_choice_answer(picked: &[String], note: &str) -> String {
    let typed = note.trim();
    let choice = if picked.len() <= 1 {
        picked.first().cloned().unwrap_or_default()
    } else {
        picked.iter().map(|o| format!("- {o}")).collect::<Vec<_>>().join("\n")
    };
    [choice.as_str(), typed].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// Not a key: the caret just came down into the widget from above.
pub const ENTERED_FROM_ABOVE: &str = "EnteredFromAbove";

/// `ChoiceKey`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChoiceKey {
    Focus { focus: Option<usize>, consumed: bool },
    Pick(usize),
    Send,
}

/// `deriveChoiceKey`: what a key does to a choice question's options. Keys
/// use the DOM names (`ArrowUp`, `Enter`, `Escape`, `" "`, digits).
pub fn derive_choice_key(
    key: &str,
    focused: Option<usize>,
    count: usize,
    multiple: bool,
    picked: usize,
    draft_empty: bool,
) -> Option<ChoiceKey> {
    let Some(focused) = focused else {
        if key == ENTERED_FROM_ABOVE {
            return Some(ChoiceKey::Focus { focus: Some(0), consumed: true });
        }
        return (key == "ArrowUp" && draft_empty && count > 0)
            .then(|| ChoiceKey::Focus { focus: Some(count - 1), consumed: true });
    };
    if let Ok(digit) = key.parse::<usize>()
        && digit >= 1
        && digit <= count
    {
        return Some(ChoiceKey::Pick(digit - 1));
    }
    if key.starts_with("Arrow") {
        return Some(arrow_over_options(key, focused, count));
    }
    Some(match key {
        "Escape" => ChoiceKey::Focus { focus: None, consumed: true },
        " " => ChoiceKey::Pick(focused),
        "Enter" if multiple && picked > 0 => ChoiceKey::Send,
        "Enter" => ChoiceKey::Pick(focused),
        _ => ChoiceKey::Focus { focus: None, consumed: false },
    })
}

fn arrow_over_options(key: &str, focused: usize, count: usize) -> ChoiceKey {
    match key {
        "ArrowLeft" => ChoiceKey::Focus { focus: Some((focused + count - 1) % count), consumed: true },
        "ArrowRight" => ChoiceKey::Focus { focus: Some((focused + 1) % count), consumed: true },
        "ArrowUp" if focused > 0 => ChoiceKey::Focus { focus: Some(focused - 1), consumed: true },
        "ArrowUp" => ChoiceKey::Focus { focus: None, consumed: false },
        _ => ChoiceKey::Focus { focus: (focused + 1 < count).then_some(focused + 1), consumed: true },
    }
}

/// `toRelativePath`: the workspace-relative path, or `None` outside it (a
/// sibling with the same prefix is outside).
pub fn relative_path(workspace_path: &str, absolute: &str) -> Option<String> {
    let root = workspace_path.trim_end_matches(['/', '\\']);
    let rest = absolute.strip_prefix(root)?;
    let rest = rest.strip_prefix(['/', '\\'])?;
    (!rest.is_empty()).then(|| rest.replace('\\', "/"))
}

/// `widgetPromptTarget`'s path and position: the workspace-relative
/// document path (a path outside passes through), the anchor (end of doc
/// when the view has none).
pub fn widget_prompt_target(
    document_path: &str,
    workspace_path: &str,
    pos: Option<i64>,
    doc_content_size: i64,
) -> (String, i64) {
    let path = relative_path(workspace_path, document_path).unwrap_or_else(|| document_path.to_string());
    (path, pos.unwrap_or(doc_content_size))
}

/// The card treatment per phase (`blobCardClass`), as tokens the view
/// paints: which border, which wash, raised or resting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardTone {
    /// `border-border/60 bg-card/80` — done at rest.
    Resting,
    /// `border-warning/40 bg-card/80` — done with an issue.
    RestingIssue,
    /// `shadow-lg border-warning/40 from-warning/10` — sign-in.
    Warning,
    /// `shadow-lg border-border from-muted/40` — permission, question.
    Attention,
    /// `shadow-lg border-border bg-card` — every other phase.
    Raised,
}

pub fn card_tone(phase: BlobPhase, has_issue: bool) -> CardTone {
    match phase {
        BlobPhase::Done if has_issue => CardTone::RestingIssue,
        BlobPhase::Done => CardTone::Resting,
        BlobPhase::NeedsAuth => CardTone::Warning,
        BlobPhase::NeedsPermission | BlobPhase::NeedsAnswer => CardTone::Attention,
        _ => CardTone::Raised,
    }
}

/// `takesTyping` / `referenceRemovalArmed`.
pub fn takes_typing(phase: BlobPhase) -> bool {
    matches!(phase, BlobPhase::Composing | BlobPhase::Done | BlobPhase::Error | BlobPhase::NeedsAnswer)
}

/// `draftPlaceholderKey`.
pub fn draft_placeholder_key(phase: BlobPhase) -> &'static str {
    match phase {
        BlobPhase::Composing => "promptBlobPlaceholder",
        BlobPhase::NeedsAnswer => "promptBlobAnswer",
        _ => "promptBlobReply",
    }
}

/// How long a refused delete's hint stands (`useRecently(…, 1500)`).
pub const REMOVAL_REFUSED_HINT_MS: i64 = 1500;
/// A refusal older than this when the face renders isn't news: no shake
/// (`useShakeOn`'s mount check).
const SHAKE_NEWS_MS: i64 = 500;
/// `useShakeOn`'s animation length.
pub const SHAKE_MS: u64 = 150;

/// The refusal stamp to shake for when the face renders at `now`, if any.
/// Each refusal is its own stamp and the view keys the animation by it, so
/// every attempt shakes, not just the first in a row.
pub fn shake_due(at: Option<i64>, now: i64) -> Option<i64> {
    at.filter(|at| now - at <= SHAKE_NEWS_MS)
}

/// `useShakeOn`'s keyframes: translateX 0 → -3px → 3px → 0, evenly spaced,
/// at progress `t` (0..=1, already eased).
pub fn shake_offset(t: f32) -> f32 {
    let t = t.clamp(0., 1.) * 3.;
    if t < 1. {
        -3. * t
    } else if t < 2. {
        -3. + 6. * (t - 1.)
    } else {
        3. - 3. * (t - 2.)
    }
}

#[cfg(test)]
mod tests {
    //! The view half of `__tests__/state.test.ts`.
    use super::*;
    use serde_json::json;

    /// `prompt-widget-state.test.tsx`: "shakes on every refused attempt,
    /// not just the first" — each attempt is a new stamp, so a new shake;
    /// a refusal from before the face rendered is not news.
    #[test]
    fn shakes_on_every_refused_attempt_not_just_the_first() {
        let keys: Vec<_> = [1_000, 1_002, 1_004].iter().map(|at| shake_due(Some(*at), *at + 1)).collect();
        assert_eq!(keys, vec![Some(1_000), Some(1_002), Some(1_004)]);
        assert_eq!(shake_due(Some(1_000), 1_000 + SHAKE_NEWS_MS + 1), None);
        assert_eq!(shake_due(None, 1_000), None);
    }

    #[test]
    fn the_shake_goes_left_then_right_and_comes_home() {
        assert_eq!(shake_offset(0.), 0.);
        assert!((shake_offset(1. / 3.) + 3.).abs() < 1e-4);
        assert!((shake_offset(2. / 3.) - 3.).abs() < 1e-4);
        assert!(shake_offset(1.).abs() < 1e-4);
    }

    fn tool_entry(id: &str, call: serde_json::Value) -> AgentEntry {
        let mut call = call;
        call["toolCallId"] = json!(id);
        serde_json::from_value(json!({
            "id": id, "taskId": "task_1", "turnId": "trn_1", "type": "tool_call", "toolCall": call,
        }))
        .unwrap()
    }

    fn assistant(id: &str, text: Option<&str>) -> AgentEntry {
        serde_json::from_value(json!({
            "id": id, "taskId": "task_1", "turnId": "trn_1", "type": "assistant", "text": text,
        }))
        .unwrap()
    }

    fn turn(id: &str, status: &str) -> AgentTurn {
        serde_json::from_value(json!({
            "turnId": id, "taskId": "task_1", "sessionId": "s", "status": status, "startedAt": 0,
        }))
        .unwrap()
    }

    fn response(kind: &str, markdown: &str, title: Option<&str>, options: Option<&[&str]>) -> WidgetResponse {
        WidgetResponse {
            kind: kind.into(),
            markdown: markdown.into(),
            title: title.map(str::to_string),
            options: options.map(|o| o.iter().map(|s| s.to_string()).collect()),
        }
    }

    const LABELS: DoneLabels<'static> = DoneLabels { done: "Done", stopped: "Stopped", issue: "Issue" };

    #[test]
    fn active_tool_line_picks_latest_in_flight_call_with_file() {
        let entries = [
            tool_entry("evt_1", json!({"title": "Read file", "status": "completed"})),
            tool_entry("evt_2", json!({"title": "Edit", "status": "in_progress", "locations": [{"path": "/ws/docs/pricing.md"}]})),
        ];
        assert_eq!(derive_active_tool_line(&entries).as_deref(), Some("Edit · pricing.md"));
    }

    #[test]
    fn active_tool_line_is_never_empty() {
        assert_eq!(derive_active_tool_line(&[tool_entry("evt_1", json!({"title": "  ", "status": "in_progress"}))]), None);
    }

    #[test]
    fn active_tool_line_falls_back_to_title_then_none() {
        assert_eq!(
            derive_active_tool_line(&[tool_entry("evt_1", json!({"title": "Search", "status": "pending"}))]).as_deref(),
            Some("Search")
        );
        assert_eq!(derive_active_tool_line(&[tool_entry("evt_1", json!({"title": "Search", "status": "completed"}))]), None);
        assert_eq!(derive_active_tool_line(&[]), None);
    }

    #[test]
    fn latest_assistant_line() {
        assert_eq!(
            derive_latest_assistant_line(&[assistant("a", Some("first")), assistant("b", Some("  second  "))]).as_deref(),
            Some("second")
        );
        assert_eq!(derive_latest_assistant_line(&[assistant("a", Some("first")), assistant("b", Some("  "))]), None);
        assert_eq!(derive_latest_assistant_line(&[]), None);
    }

    #[test]
    fn queue_position_counts_queued_turns_ahead() {
        let turns = [turn("trn_1", "running"), turn("trn_2", "queued"), turn("trn_3", "queued"), turn("trn_4", "queued")];
        assert_eq!(derive_queue_position(&turns, "trn_4"), 2);
        assert_eq!(derive_queue_position(&turns, "trn_2"), 0);
    }

    #[test]
    fn prompt_target_paths_and_positions() {
        assert_eq!(widget_prompt_target("/ws/docs/pricing.md", "/ws", Some(42), 100), ("docs/pricing.md".into(), 42));
        assert_eq!(widget_prompt_target("/elsewhere/a.md", "/ws", Some(1), 5).0, "/elsewhere/a.md");
        assert_eq!(widget_prompt_target("/ws-other/a.md", "/ws", Some(1), 5).0, "/ws-other/a.md");
        assert_eq!(widget_prompt_target("/ws/a.md", "/ws", None, 77), ("a.md".into(), 77));
    }

    #[test]
    fn done_line_collapsed_prefers_title_markdown_fallback_label() {
        let line = |r: Option<WidgetResponse>, fb: Option<&str>, cancelled: bool| {
            derive_done_line(r.as_ref(), fb, cancelled, false, &LABELS).summary
        };
        assert_eq!(line(Some(response("answer", "Full text.", Some("Summary"), None)), None, false), "Summary");
        assert_eq!(line(Some(response("answer", "Full text.", None, None)), None, false), "Full text.");
        assert_eq!(line(None, Some("last words"), false), "last words");
        assert_eq!(line(None, None, false), "Done");
        assert_eq!(line(None, None, true), "Stopped");
    }

    #[test]
    fn done_line_expanded_shows_heading_only() {
        let line = |r: WidgetResponse| derive_done_line(Some(&r), None, false, true, &LABELS).summary;
        assert_eq!(line(response("answer", "Full text.", None, None)), "Done");
        assert_eq!(line(response("issue", "A blocker.", None, None)), "Issue");
        assert_eq!(line(response("issue", "A blocker.", Some("Bad ref"), None)), "Bad ref");
    }

    #[test]
    fn done_line_body_and_kind() {
        let r = response("answer", "md", None, None);
        assert_eq!(derive_done_line(Some(&r), Some("chat"), false, false, &LABELS).body.as_deref(), Some("md"));
        assert_eq!(derive_done_line(None, Some("chat"), false, false, &LABELS).body.as_deref(), Some("chat"));
        assert_eq!(derive_done_line(None, None, false, false, &LABELS).body, None);
        assert_eq!(derive_done_line(Some(&response("issue", "x", None, None)), None, false, false, &LABELS).kind, "issue");
        assert_eq!(
            derive_done_line(Some(&response("single_choice", "x", None, Some(&["a", "b"]))), None, false, false, &LABELS).kind,
            "single_choice"
        );
        assert_eq!(derive_done_line(None, None, false, false, &LABELS).kind, "answer");
    }

    #[test]
    fn done_line_choice_is_its_own_heading() {
        for kind in ["single_choice", "multiple_choice"] {
            for expanded in [false, true] {
                let r = response(kind, "Which tier?", Some("Tier"), Some(&["Pro", "Team"]));
                assert_eq!(
                    derive_done_line(Some(&r), None, false, expanded, &LABELS),
                    DoneLine { summary: "Which tier?".into(), body: None, kind: kind.into() }
                );
            }
        }
    }

    #[test]
    fn choice_answer_composition() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(compose_choice_answer(&s(&["Pro"]), ""), "Pro");
        assert_eq!(compose_choice_answer(&s(&["Pro", "Team"]), ""), "- Pro\n- Team");
        assert_eq!(compose_choice_answer(&s(&["Pro"]), "  monthly only "), "Pro\n\nmonthly only");
        assert_eq!(compose_choice_answer(&[], " Neither "), "Neither");
        assert_eq!(compose_choice_answer(&[], ""), "");
    }

    #[test]
    fn card_tones() {
        assert_eq!(card_tone(BlobPhase::Done, false), CardTone::Resting);
        assert_eq!(card_tone(BlobPhase::Done, true), CardTone::RestingIssue);
        assert_eq!(card_tone(BlobPhase::Running, false), CardTone::Raised);
        assert_eq!(card_tone(BlobPhase::NeedsAuth, false), CardTone::Warning);
        assert_eq!(card_tone(BlobPhase::NeedsPermission, false), CardTone::Attention);
        assert_eq!(card_tone(BlobPhase::NeedsAnswer, false), CardTone::Attention);
        assert_eq!(card_tone(BlobPhase::Running, true), card_tone(BlobPhase::Running, false));
    }

    fn key(pressed: &str, focused: Option<usize>, multiple: bool, picked: usize, draft_empty: bool) -> Option<ChoiceKey> {
        derive_choice_key(pressed, focused, 3, multiple, picked, draft_empty)
    }
    fn focus(f: Option<usize>, consumed: bool) -> Option<ChoiceKey> {
        Some(ChoiceKey::Focus { focus: f, consumed })
    }

    #[test]
    fn choice_key_enters_from_the_field() {
        assert_eq!(key("ArrowUp", None, false, 0, true), focus(Some(2), true));
        assert_eq!(key("ArrowUp", None, false, 0, false), None);
        assert_eq!(key(ENTERED_FROM_ABOVE, None, false, 0, false), focus(Some(0), true));
        for other in ["ArrowDown", "ArrowLeft", "1", " ", "Enter"] {
            assert_eq!(key(other, None, false, 0, true), None);
        }
    }

    #[test]
    fn choice_key_steps_and_escapes() {
        assert_eq!(key("ArrowRight", Some(2), false, 0, true), focus(Some(0), true));
        assert_eq!(key("ArrowLeft", Some(0), false, 0, true), focus(Some(2), true));
        assert_eq!(key("Escape", Some(0), false, 0, true), focus(None, true));
        assert_eq!(key("ArrowUp", Some(2), false, 0, true), focus(Some(1), true));
        assert_eq!(key("ArrowDown", Some(0), false, 0, true), focus(Some(1), true));
        assert_eq!(key("ArrowDown", Some(2), false, 0, true), focus(None, true));
        assert_eq!(key("ArrowUp", Some(0), false, 0, true), focus(None, false));
        assert_eq!(key("x", Some(0), false, 0, true), focus(None, false));
        assert_eq!(key("Backspace", Some(0), false, 0, true), focus(None, false));
    }

    #[test]
    fn choice_key_picks_and_sends() {
        assert_eq!(key("3", Some(0), false, 0, true), Some(ChoiceKey::Pick(2)));
        assert_eq!(key("4", Some(0), false, 0, true), focus(None, false));
        assert_eq!(key(" ", Some(1), false, 0, true), Some(ChoiceKey::Pick(1)));
        assert_eq!(key("Enter", Some(1), false, 0, true), Some(ChoiceKey::Pick(1)));
        assert_eq!(key("Enter", Some(1), true, 0, true), Some(ChoiceKey::Pick(1)));
        assert_eq!(key("Enter", Some(0), true, 2, true), Some(ChoiceKey::Send));
    }
}
