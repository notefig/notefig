//! The chat's transcript (`Transcript`, `useTranscriptRows`,
//! `useTranscriptFollow`, `ScrollToEndButton`, `EntryView`,
//! `MessageEntry`, `QueuedBadge`, `MessageFooter` in `agent-chat-tab.tsx`).
//!
//! A virtualized list (GPUI's `list`, only the visible rows render) of
//! entries in id order, then turn-error banners. Follow mode is the list's
//! tail-follow: pinned to the live edge while the reader is at the bottom,
//! hands-off once they scroll up, re-armed when they come back; a send
//! jumps to the end. Its own entity, so composer keystrokes never re-render
//! it (MET-139).
//!
//! Deviation: the 48px re-arm threshold is GPUI's list's own (it re-arms
//! at the exact end). The user bubble is selectable like TS: its raw text
//! goes through the selectable text view with every markdown character
//! escaped ([`as_plain_markdown`]), so it shows as typed.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, Entity, FontWeight, InteractiveElement, IntoElement, ListAlignment,
    ListState, ParentElement, Pixels, Render, SharedString, StatefulInteractiveElement, Styled, Window, div,
    list, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::diff::{Diff, DiffFile, DiffState};
use gpui_kit::component::text::TextView;
use notefig_agent::model::{AgentEntry, AgentTurn, EntryType, TurnStatus, sort_entries};
use notefig_agent::prompt::split_leading_quote;
use notefig_agent::usage::TurnUsage;
use notefig_agents::{AgentStoreModule, AgentsModule};
use notefig_i18n::t as tr;
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use crate::cards::{diff_card, diff_files, diff_label, plan_view, thought_entry, tool_call_card, tool_open, turn_error};
use crate::session_usage::turn_usage_label;
use crate::style::{leading_relaxed, leading_snug, text_10};

/// One row of the list: an entry, or a turn's error banner.
#[derive(Clone, Debug, PartialEq)]
pub enum TranscriptRow {
    Entry {
        entry: AgentEntry,
        /// A user entry whose turn is still queued.
        queued: bool,
        /// On a user entry: what its turn spent, once settled.
        usage: Option<TurnUsage>,
    },
    Error { turn: AgentTurn },
}

impl TranscriptRow {
    /// `transcriptRowKey`.
    pub fn key(&self) -> String {
        match self {
            TranscriptRow::Entry { entry, .. } => entry.id.clone(),
            TranscriptRow::Error { turn } => format!("error-{}", turn.turn_id),
        }
    }
}

/// `useTranscriptRows`: entries in id order (text and tool calls
/// interleaved as they streamed), then the turns' error banners.
pub fn transcript_rows(mut entries: Vec<AgentEntry>, turns: &[AgentTurn]) -> Vec<TranscriptRow> {
    sort_entries(&mut entries);
    let queued: HashSet<&str> = turns.iter().filter(|t| t.status == TurnStatus::Queued).map(|t| t.turn_id.as_str()).collect();
    let usage: HashMap<&str, Option<TurnUsage>> =
        turns.iter().map(|t| (t.turn_id.as_str(), t.usage.clone().flatten())).collect();
    let mut rows: Vec<TranscriptRow> = entries
        .into_iter()
        .map(|entry| {
            let user = entry.kind == EntryType::User;
            TranscriptRow::Entry {
                queued: user && queued.contains(entry.turn_id.as_str()),
                usage: if user { usage.get(entry.turn_id.as_str()).cloned().flatten() } else { None },
                entry,
            }
        })
        .collect();
    rows.extend(
        turns
            .iter()
            .filter(|t| t.status == TurnStatus::Error && t.error.as_deref().is_some_and(|e| !e.is_empty()))
            .map(|turn| TranscriptRow::Error { turn: turn.clone() }),
    );
    rows
}

#[allow(dead_code)]
/// `estimateRowSize` (px at the TS 16px root; scaled by the caller).
pub fn estimate_row_size(row: &TranscriptRow) -> f32 {
    match row {
        TranscriptRow::Error { .. } => 44.,
        TranscriptRow::Entry { entry, .. } => match entry.kind {
            EntryType::ToolCall => 42.,
            EntryType::Thought => 48.,
            EntryType::User => 86.,
            EntryType::Plan => 164.,
            EntryType::Assistant => 617.,
            EntryType::Unknown => 1.,
        },
    }
}

/// `formatEntryTime`: the footer's clock time ("11:07 AM").
pub fn format_entry_time(ms: i64) -> String {
    use chrono::TimeZone as _;
    match chrono::Local.timestamp_millis_opt(ms).single() {
        Some(time) => time.format("%-I:%M %p").to_string(),
        None => String::new(),
    }
}

/// Where the transcript's UI toggles live (they outlive a row's render).
#[derive(Default)]
struct RowUi {
    /// Tool-call cards the user toggled (`override`).
    tools: HashMap<String, bool>,
    thoughts: HashSet<String>,
    /// Diff cards opened, by `<entry>:<index>`.
    diffs: HashSet<String>,
    /// The message whose Copy reads "Copied".
    copied: Option<String>,
    /// Each opened diff card's view state (made on open, dropped on close:
    /// a transcript's many edits cost their headers until someone looks).
    diff_states: HashMap<String, Entity<DiffState>>,
}

/// The transcript of one session.
pub struct Transcript {
    task_id: String,
    workspace_path: String,
    rows: Vec<TranscriptRow>,
    list: ListState,
    ui: RowUi,
    /// The floating composer's height: the scroll end clears it.
    bottom_inset: Pixels,
    pinned: bool,
    /// The list's width at the last render (diff cards pick split or unified by it).
    width: f32,
    _sub: notefig_core::Subscription,
}

impl Transcript {
    pub fn new(task_id: String, workspace_path: String, cx: &mut Context<Self>) -> Self {
        let store = cx.core().use_::<AgentStoreModule>();
        let id = task_id.clone();
        let sub = observe(cx, move |notify| store.subscribe_task(&id, move || notify()));
        let list = ListState::new(1, ListAlignment::Top, px(800.));
        list.set_follow_mode(gpui::FollowMode::Tail);
        let this = cx.entity().downgrade();
        list.set_scroll_handler(move |event, _, cx| {
            let following = event.is_following_tail;
            let _ = this.update(cx, |this, cx| {
                if this.pinned != following {
                    this.pinned = following;
                    cx.notify();
                }
            });
        });
        let mut this = Self {
            task_id,
            workspace_path,
            rows: Vec::new(),
            list,
            ui: RowUi::default(),
            bottom_inset: px(0.),
            pinned: true,
            width: 800.,
            _sub: sub,
        };
        this.refresh(cx);
        this
    }

    /// An opened diff card's body: the patch in gpui-component's diff view,
    /// highlighted, side by side when it fits the transcript's width.
    fn diff_body(&mut self, key: &str, diff: &crate::cards::FileDiff, cx: &mut Context<Self>) -> AnyElement {
        let mode = crate::cards::diff_mode(diff, self.width);
        let state = self
            .ui
            .diff_states
            .entry(key.to_string())
            .or_insert_with(|| {
                let files = DiffFile::parse(&diff.patch).unwrap_or_default();
                cx.new(|cx| DiffState::new(files, cx).with_mode(mode))
            })
            .clone();
        if state.read(cx).mode() != mode {
            state.update(cx, |s, cx| s.set_mode(mode, cx));
        }
        let split = mode == gpui_kit::component::diff::DiffMode::Split;
        div()
            .w_full()
            .h(crate::cards::diff_body_height(diff, split, cx))
            .child(
                Diff::new(&state)
                    .syntax_highlight(true)
                    .line_number(true)
                    .header_visible(false)
                    .soft_wrap(true),
            )
            .into_any_element()
    }

    /// Re-read the task's rows; splice the list from the first change so
    /// settled rows keep their measured heights.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let store = cx.core().use_::<AgentStoreModule>();
        let rows = transcript_rows(store.entries(&self.task_id), &store.turns(&self.task_id));
        let old = self.rows.len();
        let first = self.rows.iter().zip(rows.iter()).position(|(a, b)| a != b).unwrap_or(old.min(rows.len()));
        if first < old || rows.len() != old {
            // The spacer row stays last: splice the rows before it.
            self.list.splice(first..old, rows.len() - first);
        }
        self.rows = rows;
    }

    /// The composer's live height (`bottomInset`).
    pub fn set_bottom_inset(&mut self, inset: Pixels, cx: &mut Context<Self>) {
        if (self.bottom_inset - inset).abs() > px(0.5) {
            self.bottom_inset = inset;
            let n = self.list.item_count();
            if n > 0 {
                self.list.remeasure_items(n - 1..n);
            }
            cx.notify();
        }
    }

    /// Jump to the live edge and follow it (the composer's send).
    pub fn scroll_to_end(&mut self, cx: &mut Context<Self>) {
        self.list.set_follow_mode(gpui::FollowMode::Tail);
        self.list.scroll_to_end();
        self.pinned = true;
        cx.notify();
    }

    pub fn rows(&self) -> &[TranscriptRow] {
        &self.rows
    }

    /// The spacer under the last row: `max(bottomInset, 144px)`.
    fn clearance(&self) -> Pixels {
        self.bottom_inset.max(rem(9.))
    }

    fn remeasure(&self, key: &str) {
        if let Some(ix) = self.rows.iter().position(|r| r.key() == key) {
            self.list.remeasure_items(ix..ix + 1);
        }
    }

    fn render_row(&mut self, ix: usize, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if ix >= self.rows.len() {
            return div().h(self.clearance()).into_any_element();
        }
        let row = self.rows[ix].clone();
        let body = match &row {
            TranscriptRow::Error { turn } => Some(turn_error(turn.error.as_deref().unwrap_or(""), cx)),
            TranscriptRow::Entry { entry, queued, usage } => self.render_entry(entry, *queued, usage.as_ref(), cx),
        };
        match body {
            // pb-3 baked into the row, as in TS.
            Some(body) => div().w_full().px(sp(3.)).pb(sp(3.)).when(ix == 0, |d| d.pt(sp(3.))).child(body).into_any_element(),
            None => div().w_full().when(ix == 0, |d| d.pt(sp(3.))).into_any_element(),
        }
    }

    /// `EntryView`.
    fn render_entry(&mut self, entry: &AgentEntry, queued: bool, usage: Option<&TurnUsage>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let id = entry.id.clone();
        match entry.kind {
            EntryType::ToolCall => {
                let call = entry.tool_call_view()?;
                if let Some(diffs) = diff_files(&call) {
                    let mut col = div().flex().flex_col().w_full().gap(sp(1.));
                    for (i, diff) in diffs.iter().enumerate() {
                        let key = format!("{id}:{i}");
                        let open = self.ui.diffs.contains(&key);
                        let this = cx.entity().downgrade();
                        let (k, row_key) = (key.clone(), id.clone());
                        let label = diff_label(&diff.path, &self.workspace_path);
                        let path = diff.path.clone();
                        let open_file: Option<Rc<dyn Fn(&mut Window, &mut App)>> = Some(Rc::new(move |_, cx: &mut App| {
                            open_path(&path, cx);
                        }));
                        let body = open.then(|| self.diff_body(&key, diff, cx));
                        if !open {
                            self.ui.diff_states.remove(&key);
                        }
                        col = col.child(diff_card(
                            &key,
                            diff,
                            &label,
                            open,
                            move |_, cx| {
                                let _ = this.update(cx, |this, cx| {
                                    if !this.ui.diffs.remove(&k) {
                                        this.ui.diffs.insert(k.clone());
                                    }
                                    this.remeasure(&row_key);
                                    cx.notify();
                                });
                            },
                            open_file,
                            body,
                            cx,
                        ));
                    }
                    return Some(col.into_any_element());
                }
                let open = tool_open(&call, self.ui.tools.get(&id).copied());
                let this = cx.entity().downgrade();
                let key = id.clone();
                Some(tool_call_card(
                    &id,
                    &call,
                    open,
                    move |_, cx| {
                        let _ = this.update(cx, |this, cx| {
                            this.ui.tools.insert(key.clone(), !open);
                            this.remeasure(&key);
                            cx.notify();
                        });
                    },
                    cx,
                ))
            }
            EntryType::Plan => plan_view(&id, &entry.plan_view()?, cx),
            EntryType::Thought => {
                let open = self.ui.thoughts.contains(&id);
                let this = cx.entity().downgrade();
                let key = id.clone();
                thought_entry(
                    &id,
                    entry.text.as_deref().unwrap_or(""),
                    open,
                    move |_, cx| {
                        let _ = this.update(cx, |this, cx| {
                            if !this.ui.thoughts.remove(&key) {
                                this.ui.thoughts.insert(key.clone());
                            }
                            this.remeasure(&key);
                            cx.notify();
                        });
                    },
                    cx,
                )
            }
            EntryType::Unknown => None,
            EntryType::User | EntryType::Assistant => {
                // Whitespace-only chunks around tool calls render nothing.
                let text = entry.text.as_deref().unwrap_or("").trim().to_string();
                if text.is_empty() {
                    return None;
                }
                Some(self.render_message(entry, text, queued, usage, cx))
            }
        }
    }

    /// `MessageEntry`: the user's compact bubble or the agent's flat
    /// markdown, plus the hover footer.
    fn render_message(&mut self, entry: &AgentEntry, text: String, queued: bool, usage: Option<&TurnUsage>, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let user = entry.kind == EntryType::User;
        let group: SharedString = format!("msg-{}", entry.id).into();
        let content: AnyElement = if user {
            let (quote, rest) = split_leading_quote(&text);
            div()
                .max_w(gpui::relative(0.95))
                .rounded(t.radius_lg)
                .bg(t.primary)
                .px(sp(2.))
                .py(sp(1.))
                .text_size(t.text_xs)
                .text_color(t.primary_foreground)
                .when(queued, |d| d.opacity(0.7))
                .when_some(quote, |d, q| {
                    d.child(
                        div()
                            .mb(sp(1.))
                            .border_l_2()
                            .border_color(t.primary_foreground.opacity(0.4))
                            .pl(sp(2.))
                            .text_size(text_10())
                            .line_height(leading_snug(text_10()))
                            .italic()
                            .opacity(0.85)
                            .child(q),
                    )
                })
                .child(
                    TextView::markdown(SharedString::from(format!("user-{}", entry.id)), as_plain_markdown(&rest))
                        .selectable(true),
                )
                .when(queued, |d| d.child(self.queued_badge(&entry.turn_id, cx)))
                .into_any_element()
        } else {
            div()
                .w_full()
                .max_w(gpui::relative(0.95))
                .text_size(t.text_sm)
                .line_height(leading_relaxed(t.text_sm))
                .text_color(t.foreground)
                .child(TextView::markdown(SharedString::from(format!("md-{}", entry.id)), text.clone()).selectable(true))
                .into_any_element()
        };
        div()
            .group(group.clone())
            .flex()
            .flex_col()
            .when(user, |d| d.items_end())
            .when(!user, |d| d.items_start())
            .child(content)
            .child(self.message_footer(entry, text, user, usage, group, cx))
            .into_any_element()
    }

    /// `QueuedBadge`: "queued" + withdraw ✕.
    fn queued_badge(&self, turn_id: &str, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let hover = t.primary_foreground.opacity(0.2);
        let (task, turn) = (self.task_id.clone(), turn_id.to_string());
        let label: SharedString = tr("agentRemoveFromQueue").into();
        div()
            .mt(sp(1.))
            .flex()
            .items_center()
            .justify_end()
            .gap(sp(1.5))
            .child(
                div()
                    .rounded_full()
                    .bg(t.primary_foreground.opacity(0.2))
                    .px(sp(1.5))
                    .py(sp(0.5))
                    .text_size(text_10())
                    .child(tr("agentQueuedBadge").to_uppercase()),
            )
            .child(
                div()
                    .id(SharedString::from(format!("unqueue-{turn_id}")))
                    .rounded_full()
                    .p(sp(0.5))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .child(icon("x").size(sp(3.)).text_color(t.muted_foreground))
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
                    .on_click(move |_, _, cx| cx.core().use_::<AgentsModule>().task(&task).remove_queued_prompt(&turn)),
            )
            .into_any_element()
    }

    /// `MessageFooter`: copy and time (and a prompt's turn usage), shown on
    /// hover; always laid out, so revealing it never reflows.
    fn message_footer(
        &self,
        entry: &AgentEntry,
        text: String,
        user: bool,
        usage: Option<&TurnUsage>,
        group: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = tokens(cx);
        let (muted, fg) = (t.muted_foreground, t.foreground);
        let copied = self.ui.copied.as_deref() == Some(entry.id.as_str());
        let id = entry.id.clone();
        let copy = div()
            .id(SharedString::from(format!("copy-{}", entry.id)))
            .flex()
            .flex_none()
            .items_center()
            .gap(sp(1.))
            .rounded(crate::style::radius_default())
            .p(sp(0.5))
            .text_size(text_10())
            .text_color(muted)
            .cursor_pointer()
            .hover(move |s| s.text_color(fg))
            .child(icon(if copied { "check" } else { "copy" }).size(sp(3.)).text_color(muted))
            .child(if copied { tr("copied") } else { tr("copy") })
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                this.ui.copied = Some(id.clone());
                cx.notify();
                let id = id.clone();
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(1500)).await;
                    let _ = this.update(cx, |this, cx| {
                        if this.ui.copied.as_deref() == Some(id.as_str()) {
                            this.ui.copied = None;
                            cx.notify();
                        }
                    });
                })
                .detach();
            }));
        div()
            .flex()
            .items_center()
            .gap(sp(1.5))
            .px(sp(1.))
            .pt(sp(0.5))
            .when(user, |d| d.flex_row_reverse())
            .opacity(0.)
            .group_hover(group, |s| s.opacity(1.))
            .child(copy)
            // Replayed history has no createdAt: no time beats a wrong one.
            .when_some(entry.created_at, |d, at| {
                d.child(div().text_size(text_10()).text_color(muted).child(format_entry_time(at)))
            })
            .children(turn_usage_label(SharedString::from(format!("usage-{}", entry.id)), usage, cx))
            .into_any_element()
    }

    fn render_scroll_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let active = !self.pinned;
        let label: SharedString = tr("agentScrollToEnd").into();
        let bottom = self.clearance() - px(32.);
        let (fg, muted) = (t.foreground, t.muted);
        div()
            .id("scroll-to-end")
            .absolute()
            .right(sp(3.))
            .bottom(bottom)
            .size(sp(7.))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .text_color(fg)
            .shadow_sm()
            .cursor_pointer()
            .hover(move |s| s.bg(muted))
            .when(!active, |d| d.invisible())
            .child(icon("arrow-down").size(sp(3.5)).text_color(t.foreground))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
            .on_click(cx.listener(|this, _, _, cx| this.scroll_to_end(cx)))
            .into_any_element()
    }
}

/// Open a file the transcript points at, through the tabs module when the
/// shell has one.
fn open_path(path: &str, cx: &mut App) {
    if let Some(tabs) = cx.core().try_use::<notefig_tabs::TabsModule>() {
        tabs.open(path, Default::default());
    }
}

impl Render for Transcript {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refresh(cx);
        // Read before the list renders: its rows render inside its borrow.
        let width = f32::from(self.list.viewport_bounds().size.width);
        if width > 0. {
            self.width = width;
        }
        let view = cx.entity().downgrade();
        let rows = list(self.list.clone(), move |ix, window, cx| {
            view.upgrade()
                .map(|v| v.update(cx, |this, cx| this.render_row(ix, window, cx)))
                .unwrap_or_else(|| div().into_any_element())
        })
        .size_full();
        div()
            .relative()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .overflow_hidden()
            .font_weight(FontWeight::NORMAL)
            .child(rows)
            .child(self.render_scroll_button(cx))
    }
}

/// `text` as markdown that renders exactly as typed: every ASCII
/// punctuation character backslash-escaped (all valid CommonMark escapes),
/// every line break a hard break, leading spaces kept.
pub(crate) fn as_plain_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push_str("\\\n");
        }
        let indent = line.len() - line.trim_start_matches(' ').len();
        out.push_str(&"\u{a0}".repeat(indent));
        for ch in line[indent..].chars() {
            if ch.is_ascii_punctuation() {
                out.push('\\');
            }
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, turn: &str, kind: &str, text: &str) -> AgentEntry {
        serde_json::from_value(json!({"id": id, "taskId": "t", "turnId": turn, "type": kind, "text": text})).unwrap()
    }

    fn turn(id: &str, status: &str, error: Option<&str>) -> AgentTurn {
        serde_json::from_value(json!({"turnId": id, "taskId": "t", "sessionId": "s", "status": status,
            "startedAt": 0, "error": error, "usage": {"total": {"tokens": {"input": 10, "cacheRead": 0, "cacheWrite": 0, "output": 5, "thought": 0}, "cost": null}, "byModel": []}}))
        .unwrap()
    }

    #[test]
    fn rows_are_entries_in_id_order_then_errors() {
        let entries = vec![entry("e2", "trn_1", "assistant", "hi"), entry("e1", "trn_1", "user", "q")];
        let turns = vec![turn("trn_1", "error", Some("boom"))];
        let rows = transcript_rows(entries, &turns);
        let keys: Vec<String> = rows.iter().map(|r| r.key()).collect();
        assert_eq!(keys, ["e1", "e2", "error-trn_1"]);
    }

    #[test]
    fn user_rows_carry_queued_and_usage() {
        let entries = vec![entry("e1", "trn_1", "user", "q"), entry("e2", "trn_2", "user", "later")];
        let turns = vec![turn("trn_1", "completed", None), turn("trn_2", "queued", None)];
        let rows = transcript_rows(entries, &turns);
        match (&rows[0], &rows[1]) {
            (
                TranscriptRow::Entry { queued: false, usage: Some(u), .. },
                TranscriptRow::Entry { queued: true, .. },
            ) => assert_eq!(u.total.tokens.total(), 15.),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn errors_without_text_get_no_banner() {
        let rows = transcript_rows(vec![], &[turn("trn_1", "error", None), turn("trn_2", "error", Some(""))]);
        assert!(rows.is_empty());
    }

    #[test]
    fn estimates_follow_the_entry_type() {
        let rows = transcript_rows(vec![entry("e1", "t", "unknown", ""), entry("e2", "t", "plan", "")], &[]);
        assert_eq!(estimate_row_size(&rows[0]), 1.);
        assert_eq!(estimate_row_size(&rows[1]), 164.);
    }

    #[test]
    fn entry_time_is_hour_minute() {
        let s = format_entry_time(0);
        assert!(s.ends_with("AM") || s.ends_with("PM"), "{s}");
        assert!(s.contains(':'));
    }

    #[test]
    fn plain_markdown_escapes_everything_and_keeps_lines() {
        assert_eq!(as_plain_markdown("**hi** `x`"), "\\*\\*hi\\*\\* \\`x\\`");
        assert_eq!(as_plain_markdown("a\n  b"), "a\\\n\u{a0}\u{a0}b");
        assert_eq!(as_plain_markdown("# 1. [x](y)"), "\\# 1\\. \\[x\\]\\(y\\)");
    }
}
