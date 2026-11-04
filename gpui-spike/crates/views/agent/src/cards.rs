//! The transcript's entries and the composer overlay's cards:
//!
//! - `permission-card.tsx` → [`permission_card`]
//! - `auth-card.tsx` → [`AuthCard`]
//! - `UnavailableCard`, the turn-error banner, `PlanView`, `ThoughtEntry`,
//!   `ToolCallCard` and `ToolContentView` (all in `agent-chat-tab.tsx`)
//! - the diff-block cards an edit renders as
//!   (`packages/widgets/src/diff-block/{transcript,card,patch}.tsx`) →
//!   [`diff_card`], [`file_diff`]
//!
//! Each card is a function of its rows plus the UI state the tab keeps for
//! it (open/closed), so the prompt widget can render the same ones.
//!
//! Pierre's diff body (syntax-highlighted, side by side when the change has
//! both sides and its lines fit beside each other) is gpui-component's
//! `Diff` over the same unified patch ([`FileDiff::patch`], [`diff_mode`]).
//! Deviation: that view is virtualized, so a card body gets a height from
//! its rows ([`diff_body_height`]) up to a cap, and scrolls past it.

use std::rc::Rc;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, Context, ElementId, FontWeight, Hsla,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Transformation, Window, div, percentage, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::shimmer::ShimmerText;
use notefig_agent::model::{
    AgentTaskRow, PermissionOutcome, PermissionRequestRow, PlanView, ToolCallContentView, ToolCallView,
    content_block_text,
};
use notefig_agents::AgentsModule;
use notefig_i18n::{t as tr, t_args};
use notefig_ui::{CoreExt as _, icon, rem, sp, tokens};
use serde_json::Value;

use crate::style::{ButtonSize, ButtonVariant, button, leading_relaxed, mono, text_11, tint_over};

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// The add/remove colours of a diff (Pierre's green and red).
pub fn diff_colors(cx: &App) -> (Hsla, Hsla) {
    let dark = tokens(cx).dark;
    if dark {
        (gpui::hsla(145. / 360., 0.55, 0.52, 1.), gpui::hsla(0., 0.75, 0.62, 1.))
    } else {
        (gpui::hsla(145. / 360., 0.6, 0.32, 1.), gpui::hsla(0., 0.7, 0.45, 1.))
    }
}

/// A spinning `Loader2`.
pub fn spinner(id: impl Into<ElementId>, size: gpui::Pixels, color: Hsla) -> AnyElement {
    icon("loader-circle")
        .size(size)
        .text_color(color)
        .with_animation(id, Animation::new(std::time::Duration::from_millis(1000)).repeat(), |svg, t| {
            svg.with_transformation(Transformation::rotate(percentage(t)))
        })
        .into_any_element()
}

// ─── permission-card.tsx ─────────────────────────────────────────────────────

/// `variantForKind`: allows are filled, the rest outlined.
pub fn permission_variant(kind: &str) -> ButtonVariant {
    if kind == "allow_once" || kind == "allow_always" { ButtonVariant::Default } else { ButtonVariant::Outline }
}

/// `PermissionCard`: the head of the task's pending queue, its title and
/// the agent's options verbatim; "N more pending" under them. `bare`
/// skips the card's own frame (the prompt widget wraps it itself).
pub fn permission_card(task_id: &str, pending: &[PermissionRequestRow], bare: bool, cx: &App) -> Option<AnyElement> {
    let head = pending.first()?;
    let t = tokens(cx);
    let options = head.options.iter().map(|option| {
        let (task, req, opt) = (task_id.to_string(), head.id.clone(), option.option_id.clone());
        button(
            SharedString::from(format!("perm-{}-{}", head.id, option.option_id)),
            permission_variant(&option.kind),
            ButtonSize::Sm,
            false,
            cx,
        )
        .child(if option.name.is_empty() { option.option_id.clone() } else { option.name.clone() })
        .on_click(move |_, _, cx| {
            let pending = cx.core().use_::<AgentsModule>().task(&task).respond_permission(&req, PermissionOutcome::Selected(opt.clone()));
            cx.foreground_executor().spawn(pending).detach();
        })
    });
    let more = pending.len() - 1;
    Some(
        div()
            .id(SharedString::from(format!("permission-{}", head.id)))
            .text_size(t.text_sm)
            .when(!bare, |d| {
                d.rounded(t.radius_lg)
                    .border_1()
                    .border_color(t.border)
                    .bg(tint_over(t.background, t.muted, 0.4))
                    .p(sp(3.))
            })
            .child(div().mb(sp(2.)).font_weight(FontWeight::MEDIUM).child(head.title.clone()))
            .child(div().flex().flex_wrap().gap(sp(2.)).children(options))
            .when(more > 0, |d| {
                d.child(div().mt(sp(2.)).text_size(t.text_xs).text_color(t.muted_foreground).child(format!("{more} more pending")))
            })
            .into_any_element(),
    )
}

// ─── auth-card.tsx ───────────────────────────────────────────────────────────

/// `AuthCard`: the task's sign-in methods; an out-of-band method that
/// fails shows its instructions instead. Its own entity: it keeps which
/// method is in flight.
pub struct AuthCard {
    task_id: String,
    bare: bool,
    busy: Option<String>,
    instructions: Option<String>,
}

impl AuthCard {
    pub fn new(task_id: String, bare: bool) -> Self {
        Self { task_id, bare, busy: None, instructions: None }
    }

    fn try_method(&mut self, method_id: String, description: Option<String>, cx: &mut Context<Self>) {
        self.busy = Some(method_id.clone());
        self.instructions = None;
        cx.notify();
        let pending = cx.core().use_::<AgentsModule>().task(&self.task_id).authenticate(&method_id);
        cx.spawn(async move |this, cx| {
            let result = pending.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                if result.is_err() {
                    let hint = cx.core().use_::<notefig_agents::AgentStoreModule>().task(&this.task_id).and_then(|r| r.auth_hint);
                    this.instructions = description.or(hint);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for AuthCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let row: Option<AgentTaskRow> = cx.core().use_::<notefig_agents::AgentStoreModule>().task(&self.task_id);
        let t = tokens(cx);
        let Some(row) = row else { return div().into_any_element() };
        let text = self.instructions.clone().or(row.auth_hint.clone());
        let busy_any = self.busy.is_some();
        let methods: Vec<AnyElement> = row
            .auth_methods
            .iter()
            .map(|m| {
                let (id, desc) = (m.id.clone(), m.description.clone());
                let busy = self.busy.as_deref() == Some(m.id.as_str());
                button(SharedString::from(format!("auth-{}", m.id)), ButtonVariant::Outline, ButtonSize::Sm, busy_any, cx)
                    .when(busy, |b| b.child(spinner(SharedString::from(format!("auth-spin-{}", m.id)), sp(3.5), t.foreground)))
                    .child(if m.name.is_empty() { m.id.clone() } else { m.name.clone() })
                    .when(!busy_any, |b| b.on_click(cx.listener(move |this, _, _, cx| this.try_method(id.clone(), desc.clone(), cx))))
                    .into_any_element()
            })
            .collect();
        let task = self.task_id.clone();
        div()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .text_size(t.text_xs)
            .when(!self.bare, |d| {
                d.rounded(t.radius_md)
                    .border_1()
                    .border_color(t.warning.opacity(0.4))
                    .bg(tint_over(t.background, t.warning, 0.1))
                    .p(sp(3.))
            })
            .child(div().font_weight(FontWeight::MEDIUM).child(tr("agentSignInRequired")))
            .when_some(text, |d, text| d.child(div().whitespace_normal().child(text)))
            .child(
                div().flex().flex_wrap().items_center().gap(sp(2.)).children(methods).child(
                    button("auth-retry", ButtonVariant::Default, ButtonSize::Sm, false, cx)
                        .child(tr("agentSignedInRetry"))
                        .on_click(move |_, _, cx| {
                            let pending = cx.core().use_::<AgentsModule>().task(&task).retry_after_auth();
                            cx.foreground_executor().spawn(pending).detach();
                        }),
                ),
            )
            .into_any_element()
    }
}

// ─── the chat tab's own cards ────────────────────────────────────────────────

/// `UnavailableCard`: revival failed; the one action is to delete.
pub fn unavailable_card(task_id: &str, cx: &App) -> AnyElement {
    let t = tokens(cx);
    let task = task_id.to_string();
    div()
        .flex()
        .items_center()
        .gap(sp(3.))
        .rounded(t.radius_lg)
        .border_1()
        .border_color(t.border)
        .bg(t.card)
        .px(sp(3.))
        .py(sp(2.))
        .text_size(t.text_sm)
        .text_color(t.muted_foreground)
        .child(div().flex_1().min_w_0().child(tr("agentSessionUnavailableNotice")))
        .child(
            button("unavailable-delete", ButtonVariant::Outline, ButtonSize::Sm, false, cx)
                .child(tr("agentDeleteSession"))
                .on_click(move |_, _, cx| {
                    let pending = cx.core().use_::<AgentsModule>().task(&task).delete();
                    cx.foreground_executor().spawn(pending).detach();
                }),
        )
        .into_any_element()
}

/// The turn-error banner: "Turn failed: <error>".
pub fn turn_error(error: &str, cx: &App) -> AnyElement {
    let t = tokens(cx);
    div()
        .rounded(t.radius_md)
        .border_1()
        .border_color(t.warning.opacity(0.4))
        .bg(t.warning.opacity(0.1))
        .px(sp(3.))
        .py(sp(2.))
        .text_size(t.text_xs)
        .text_color(t.warning)
        .child(
            div()
                .flex()
                .flex_wrap()
                .child(div().font_weight(FontWeight::MEDIUM).child(tr("agentTurnFailed")))
                .child(div().child(format!("\u{a0}{error}"))),
        )
        .into_any_element()
}

/// `PlanView`: a compact checklist; done entries struck through.
pub fn plan_view(id: &str, plan: &PlanView, cx: &App) -> Option<AnyElement> {
    if plan.entries.is_empty() {
        return None;
    }
    let t = tokens(cx);
    let rows = plan.entries.iter().enumerate().map(|(i, e)| {
        let status = e.status.as_deref();
        let mark: AnyElement = match status {
            Some("completed") => icon("check").size(sp(3.5)).text_color(t.success).into_any_element(),
            Some("in_progress") => spinner(SharedString::from(format!("plan-{id}-{i}")), sp(3.5), t.muted_foreground),
            _ => div().size(sp(3.5)).flex_none().into_any_element(),
        };
        let done = status == Some("completed");
        div()
            .flex()
            .items_center()
            .gap(sp(2.))
            .py(sp(0.5))
            .child(mark)
            .child(
                div()
                    .flex_1()
                    .when(done, |d| d.text_color(t.muted_foreground).line_through())
                    .child(e.content.clone()),
            )
    });
    Some(
        div()
            .w_full()
            .rounded(t.radius_lg)
            .border_1()
            .border_color(t.border)
            .bg(t.card)
            .px(sp(2.5))
            .py(sp(2.))
            .text_size(t.text_xs)
            .children(rows)
            .into_any_element(),
    )
}

/// `ThoughtEntry`: a coalesced thought run, collapsed by default.
pub fn thought_entry(id: &str, text: &str, open: bool, on_toggle: impl Fn(&mut Window, &mut App) + 'static, cx: &App) -> Option<AnyElement> {
    if text.is_empty() {
        return None;
    }
    let t = tokens(cx);
    Some(
        div()
            .w_full()
            .text_size(t.text_sm)
            .text_color(t.muted_foreground)
            .child(
                div()
                    .id(SharedString::from(format!("thought-{id}")))
                    .flex()
                    .items_center()
                    .gap(sp(1.5))
                    .cursor_pointer()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(
                        // The `<details>` marker.
                        div().text_size(t.text_xs).child(if open { "▼" } else { "▶" }),
                    )
                    .child(tr("agentThinking"))
                    .on_click(move |_, window, cx| on_toggle(window, cx)),
            )
            .when(open, |d| {
                d.child(div().mt(sp(1.)).text_size(t.text_xs).line_height(leading_relaxed(t.text_xs)).child(text.to_string()))
            })
            .into_any_element(),
    )
}

/// `rawInputPreview`: a `command` field, else the JSON.
pub fn raw_input_preview(raw: &Value) -> String {
    if let Some(cmd) = raw.get("command").and_then(Value::as_str) {
        return cmd.to_string();
    }
    serde_json::to_string(raw).unwrap_or_default()
}

/// `toolPreview`: the command, the primary file, else the raw input.
pub fn tool_preview(call: &ToolCallView) -> String {
    if let Some(cmd) = call.raw_input.as_ref().and_then(|r| r.get("command")).and_then(Value::as_str) {
        return cmd.to_string();
    }
    if let Some(path) = call.locations.first() {
        return path.clone();
    }
    call.raw_input.as_ref().map(raw_input_preview).unwrap_or_default()
}

/// Whether a tool call card has something to expand to.
pub fn tool_has_body(call: &ToolCallView) -> bool {
    !call.content.is_empty() || raw_input_text(call).is_some()
}

/// The raw input worth showing: not absent, not empty, not `{}`.
fn raw_input_text(call: &ToolCallView) -> Option<String> {
    let text = call.raw_input.as_ref().map(raw_input_preview)?;
    (!text.is_empty() && text != "{}" && text != "null").then_some(text)
}

/// Open by default only when failed (errors must be seen); a user toggle
/// sticks.
pub fn tool_open(call: &ToolCallView, user: Option<bool>) -> bool {
    user.unwrap_or(call.status.as_deref() == Some("failed"))
}

/// `ToolCallCard`: a flat line (bold title, muted preview) that expands in
/// place to its output or input.
pub fn tool_call_card(
    id: &str,
    call: &ToolCallView,
    open: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let t = tokens(cx);
    let status = call.status.as_deref().unwrap_or("pending");
    let title = call.title.clone().or(call.kind.clone()).unwrap_or_else(|| "other".into());
    let failed = status == "failed";
    let in_flight = status == "pending" || status == "in_progress";
    let has_body = tool_has_body(call);
    let group: SharedString = format!("tool-{id}").into();
    let title_el: AnyElement = if in_flight {
        div()
            .min_w_0()
            .flex_shrink(1.)
            .truncate()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(t.muted_foreground)
            .child(ShimmerText::new(title.clone()).id(SharedString::from(format!("tool-shimmer-{id}"))))
            .into_any_element()
    } else {
        div()
            .min_w_0()
            .flex_shrink(1.)
            .truncate()
            .font_weight(FontWeight::SEMIBOLD)
            .when(failed, |d| d.text_color(t.destructive))
            .child(title.clone())
            .into_any_element()
    };
    let chevron = has_body.then(|| {
        let c = icon("chevron-right").size(sp(3.5)).text_color(t.muted_foreground);
        if open {
            c.with_transformation(Transformation::rotate(percentage(0.25))).into_any_element()
        } else {
            div().invisible().group_hover(group.clone(), |s| s.visible()).child(c).into_any_element()
        }
    });
    let line = div()
        .id(SharedString::from(format!("tool-line-{id}")))
        .group(group.clone())
        .flex()
        .w_full()
        .items_center()
        .gap(sp(2.))
        .when(has_body, |d| d.cursor_pointer().on_click(move |_, window, cx| on_toggle(window, cx)))
        .child(title_el)
        .child(div().min_w_0().flex_1().truncate().text_color(t.muted_foreground.opacity(0.7)).child(tool_preview(call)))
        .children(chevron);
    let body = (has_body && open).then(|| {
        let mut col = div().mt(sp(1.5)).flex().flex_col().gap(sp(2.));
        for (i, item) in call.content.iter().enumerate() {
            col = col.child(tool_content(&format!("{id}-{i}"), item, cx));
        }
        if call.content.is_empty()
            && let Some(raw) = raw_input_text(call)
        {
            col = col.child(pre_block(&format!("{id}-raw"), &raw, rem(10.), t.muted_foreground, cx));
        }
        col
    });
    div().w_full().text_size(t.text_xs).child(line).children(body).into_any_element()
}

/// A `pre` box: `max-h-* overflow-auto whitespace-pre-wrap rounded-lg border
/// border-border/60 p-2 font-mono text-[0.6875rem]`.
fn pre_block(id: &str, text: &str, max_h: gpui::Pixels, color: Hsla, cx: &App) -> AnyElement {
    let t = tokens(cx);
    div()
        .id(SharedString::from(format!("pre-{id}")))
        .max_h(max_h)
        .overflow_y_scroll()
        .rounded(t.radius_lg)
        .border_1()
        .border_color(t.border.opacity(0.6))
        .p(sp(2.))
        .font_family(mono())
        .text_size(text_11())
        .text_color(color)
        .child(text.to_string())
        .into_any_element()
}

/// `ToolContentView`: one item of a tool call's output.
fn tool_content(id: &str, item: &ToolCallContentView, cx: &App) -> AnyElement {
    let t = tokens(cx);
    match item {
        ToolCallContentView::Diff { path, old_text, new_text } => {
            let added = if new_text.is_empty() { 0 } else { new_text.split('\n').count() };
            let removed = old_text.as_deref().map(|o| if o.is_empty() { 0 } else { o.split('\n').count() }).unwrap_or(0);
            let (green, red) = (t.success, t.destructive);
            div()
                .overflow_hidden()
                .rounded(crate::style::radius_default())
                .border_1()
                .border_color(t.border.opacity(0.6))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(sp(2.))
                        .bg(t.muted.opacity(0.6))
                        .px(sp(2.))
                        .py(sp(1.))
                        .font_family(mono())
                        .text_size(text_11())
                        .child(div().min_w_0().flex_1().truncate().child(path.clone()))
                        .child(div().flex_none().text_color(green).child(format!("+{added}")))
                        .when(old_text.is_some(), |d| d.child(div().flex_none().text_color(red).child(format!("−{removed}")))),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("diff-new-{id}")))
                        .max_h(rem(14.))
                        .overflow_y_scroll()
                        .p(sp(2.))
                        .font_family(mono())
                        .text_size(text_11())
                        .child(new_text.clone()),
                )
                .into_any_element()
        }
        ToolCallContentView::Terminal { terminal_id } => div()
            .font_family(mono())
            .text_size(text_11())
            .text_color(t.muted_foreground)
            .child(t_args("agentTerminal", &[("id", terminal_id)]))
            .into_any_element(),
        ToolCallContentView::Content(block) => {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                pre_block(id, content_block_text(block), rem(14.), t.foreground, cx)
            } else {
                let kind = block.get("type").and_then(Value::as_str).unwrap_or("unknown");
                div()
                    .text_size(text_11())
                    .text_color(t.muted_foreground)
                    .child(t_args("agentContentOfType", &[("type", kind)]))
                    .into_any_element()
            }
        }
        ToolCallContentView::Other(value) => {
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("unknown");
            div()
                .text_size(text_11())
                .text_color(t.muted_foreground)
                .child(t_args("agentContentOfType", &[("type", kind)]))
                .into_any_element()
        }
    }
}

// ─── diff blocks ─────────────────────────────────────────────────────────────

/// One drawn line of a diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffLine {
    Context { old: usize, new: usize, text: String },
    Removed { old: usize, text: String },
    Added { new: usize, text: String },
    /// A gap between hunks.
    Separator,
}

/// A file edit as the card draws it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileDiff {
    pub path: String,
    pub lines: Vec<DiffLine>,
    pub added: usize,
    pub removed: usize,
    /// The unified patch (`--- a/<path>`, `+++ b/<path>`, hunks), what the
    /// diff view parses.
    pub patch: String,
}

/// `patchOf` + Pierre's parse: the change between `before` (None for a
/// new file) and `after`, with 3 lines of context, numbered from `line`
/// (where an excerpt starts in its file).
pub fn file_diff(path: &str, before: Option<&str>, after: &str, line: usize) -> FileDiff {
    let old = before.unwrap_or("");
    // An excerpt (neither side ending its line) is lines out of a file:
    // ended alike so no "no newline at end of file" shows.
    let excerpt = !old.ends_with('\n') && !after.ends_with('\n');
    let end = |s: &str| if excerpt && !s.is_empty() { format!("{s}\n") } else { s.to_string() };
    let (old, new) = (end(old), end(after));
    let diff = similar::TextDiff::from_lines(&old, &new);
    let shift = line.saturating_sub(1);
    let mut lines = Vec::new();
    let (mut added, mut removed) = (0, 0);
    for (gi, group) in diff.grouped_ops(3).iter().enumerate() {
        if gi > 0 {
            lines.push(DiffLine::Separator);
        }
        for op in group {
            for change in diff.iter_changes(op) {
                let text = change.value().trim_end_matches('\n').to_string();
                match change.tag() {
                    similar::ChangeTag::Equal => lines.push(DiffLine::Context {
                        old: change.old_index().unwrap_or(0) + 1 + shift,
                        new: change.new_index().unwrap_or(0) + 1 + shift,
                        text,
                    }),
                    similar::ChangeTag::Delete => {
                        removed += 1;
                        lines.push(DiffLine::Removed { old: change.old_index().unwrap_or(0) + 1 + shift, text })
                    }
                    similar::ChangeTag::Insert => {
                        added += 1;
                        lines.push(DiffLine::Added { new: change.new_index().unwrap_or(0) + 1 + shift, text })
                    }
                }
            }
        }
    }
    let name = path.trim_start_matches('/');
    let patch = diff
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{name}"), &format!("b/{name}"))
        .to_string();
    let patch = renumber_patch(&patch, shift);
    FileDiff { path: path.to_string(), lines, added, removed, patch }
}

/// Shift every hunk header's line numbers by `shift` (an excerpt's start).
fn renumber_patch(patch: &str, shift: usize) -> String {
    if shift == 0 {
        return patch.to_string();
    }
    let bump = |range: &str| -> String {
        let (start, rest) = range.split_once(',').map(|(a, b)| (a, Some(b))).unwrap_or((range, None));
        let start = start.parse::<usize>().map(|n| if n == 0 { 0 } else { n + shift }).unwrap_or(0);
        match rest {
            Some(count) => format!("{start},{count}"),
            None => start.to_string(),
        }
    };
    patch
        .lines()
        .map(|line| {
            let Some(body) = line.strip_prefix("@@ -").and_then(|l| l.split_once(" @@")) else {
                return line.to_string();
            };
            let (ranges, tail) = body;
            let Some((old, new)) = ranges.split_once(" +") else { return line.to_string() };
            format!("@@ -{} +{} @@{tail}", bump(old), bump(new))
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// What a code character takes at the card's size, near enough for a
/// layout choice (TS `CHAR_PX`), and a side's gutter (`SIDE_CHROME_PX`).
const CHAR_PX: f32 = 7.8;
const SIDE_CHROME_PX: f32 = 56.;
/// Lines longer than this wrap side by side as in one column.
const FIT_COLUMNS: usize = 80;

/// Side by side when the change has both sides and its lines fit beside
/// each other in `width`; one unified column otherwise (TS `styleAt`).
pub fn diff_mode(diff: &FileDiff, width: f32) -> gpui_kit::component::diff::DiffMode {
    use gpui_kit::component::diff::DiffMode;
    let can_split = diff.added > 0 && diff.removed > 0;
    let longest = diff
        .lines
        .iter()
        .filter_map(|l| match l {
            DiffLine::Added { text, .. } | DiffLine::Removed { text, .. } => Some(text.trim_end().chars().count()),
            _ => None,
        })
        .max()
        .unwrap_or(0)
        .min(FIT_COLUMNS);
    let fits = width / 2. - SIDE_CHROME_PX >= longest as f32 * CHAR_PX;
    if can_split && fits { DiffMode::Split } else { DiffMode::Unified }
}

/// The rows the diff view draws: a header per hunk, context lines one each;
/// a run of removals and additions its sum unified, its longer side split.
pub fn diff_rows(diff: &FileDiff, split: bool) -> usize {
    // The first hunk's header; each separator stands for the next one's.
    let (mut rows, mut removed, mut added) = (1, 0, 0);
    let flush = |rows: &mut usize, r: &mut usize, a: &mut usize| {
        *rows += if split { (*r).max(*a) } else { *r + *a };
        *r = 0;
        *a = 0;
    };
    for line in &diff.lines {
        match line {
            DiffLine::Removed { .. } => removed += 1,
            DiffLine::Added { .. } => added += 1,
            _ => {
                flush(&mut rows, &mut removed, &mut added);
                rows += 1;
            }
        }
    }
    flush(&mut rows, &mut removed, &mut added);
    rows
}

/// A card body's height: its rows at the diff view's row height (the mono
/// size × 1.6), capped.
pub fn diff_body_height(diff: &FileDiff, split: bool, cx: &App) -> gpui::Pixels {
    use gpui_kit::component::ActiveTheme as _;
    let row = px(16.) * (f32::from(cx.theme().mono_font_size) / 16.) * 1.6;
    (row * diff_rows(diff, split) as f32 + px(8.)).min(px(480.))
}

/// `renderDiffToolCall`: a tool call's file edits as diff cards, or None to
/// leave it to the generic line (it edits nothing, or failed).
pub fn diff_files(call: &ToolCallView) -> Option<Vec<FileDiff>> {
    if call.status.as_deref() == Some("failed") {
        return None;
    }
    let diffs: Vec<FileDiff> = call
        .content
        .iter()
        .filter_map(|c| match c {
            ToolCallContentView::Diff { path, old_text, new_text } => Some(file_diff(path, old_text.as_deref(), new_text, 1)),
            _ => None,
        })
        .collect();
    (!diffs.is_empty()).then_some(diffs)
}

/// The file's label: workspace-relative when it is in the workspace.
pub fn diff_label(path: &str, workspace_path: &str) -> String {
    let root = format!("{}/", workspace_path.trim_end_matches('/'));
    path.strip_prefix(&root).unwrap_or(path).to_string()
}

/// A file's type badge: its extension's first letters, as the file icon.
fn type_badge(path: &str, cx: &App) -> AnyElement {
    let t = tokens(cx);
    let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if ext.is_empty() {
        return icon("file-diff").size(sp(3.)).flex_none().text_color(t.muted_foreground).into_any_element();
    }
    let label: String = ext.chars().take(2).collect::<String>().to_uppercase();
    div()
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .size(sp(3.))
        .rounded(px(2.))
        .bg(t.muted_foreground.opacity(0.25))
        .text_size(rem(0.3))
        .font_weight(FontWeight::BOLD)
        .text_color(t.muted_foreground)
        .child(label)
        .into_any_element()
}

/// `DiffCard` (collapsible, as the transcript draws edits): a header with
/// the toggle, the type badge, `dir/` + **name**, `+N −M`; opened, the
/// diff body.
pub fn diff_card(
    id: &str,
    diff: &FileDiff,
    label: &str,
    open: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + 'static,
    on_open_file: Option<Handler>,
    body: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let t = tokens(cx);
    let (green, red) = diff_colors(cx);
    let slash = label.rfind('/').map(|i| i + 1).unwrap_or(0);
    let border = t.border.opacity(0.6);
    let fg = t.foreground;
    let name = div()
        .flex()
        .min_w_0()
        .truncate()
        .child(div().flex_none().child(label[..slash].to_string()))
        .child(div().font_weight(FontWeight::MEDIUM).text_color(fg).child(label[slash..].to_string()));
    let name: AnyElement = match on_open_file {
        Some(open_file) => div()
            .id(SharedString::from(format!("diff-file-{id}")))
            .min_w_0()
            .cursor_pointer()
            .hover(move |s| s.text_color(fg).underline())
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                open_file(window, cx)
            })
            .child(name)
            .into_any_element(),
        None => name.into_any_element(),
    };
    let chevron = icon("chevron-right").size(sp(3.)).text_color(t.muted_foreground);
    let chevron = if open { chevron.with_transformation(Transformation::rotate(percentage(0.25))) } else { chevron };
    let header = div()
        .id(SharedString::from(format!("diff-head-{id}")))
        .flex()
        .h(sp(6.))
        .items_center()
        .gap(sp(1.5))
        .pl(sp(1.))
        .pr(sp(1.))
        .text_size(text_11())
        .text_color(t.muted_foreground)
        .cursor_pointer()
        .when(open, |d| d.border_b_1().border_color(border))
        .on_click(move |_, window, cx| on_toggle(window, cx))
        .child(div().flex_none().p(sp(0.5)).rounded(crate::style::radius_default()).hover(move |s| s.text_color(fg)).child(chevron))
        .child(type_badge(label, cx))
        .child(name)
        .when(diff.added > 0, |d| d.child(div().flex_none().text_color(green).child(format!("+{}", diff.added))))
        .when(diff.removed > 0, |d| d.child(div().flex_none().text_color(red).child(format!("−{}", diff.removed))));
    div()
        .w_full()
        .overflow_hidden()
        .rounded(t.radius_lg)
        .border_1()
        .border_color(border)
        .bg(t.card.opacity(0.8))
        .text_size(t.text_xs)
        .child(header)
        .when(open, |d| d.child(body.unwrap_or_else(|| diff_body(diff, cx))))
        .into_any_element()
}

/// The diff's lines: a number gutter tinted by kind, a bar on changed
/// lines, wrapped code.
fn diff_body(diff: &FileDiff, cx: &App) -> AnyElement {
    let t = tokens(cx);
    let (green, red) = diff_colors(cx);
    let size = t.text_xs * 0.857;
    let line_h = size * 1.6667;
    let width = diff
        .lines
        .iter()
        .map(|l| match l {
            DiffLine::Context { new, .. } | DiffLine::Added { new, .. } => *new,
            DiffLine::Removed { old, .. } => *old,
            DiffLine::Separator => 0,
        })
        .max()
        .unwrap_or(1)
        .to_string()
        .len()
        .max(1);
    let rows = diff.lines.iter().map(|line| {
        let (num, text, bg, bar, num_color) = match line {
            DiffLine::Context { new, text, .. } => (new.to_string(), text.clone(), None, None, t.muted_foreground),
            DiffLine::Removed { old, text } => (old.to_string(), text.clone(), Some(red.opacity(0.16)), Some(red), red),
            DiffLine::Added { new, text } => (new.to_string(), text.clone(), Some(green.opacity(0.16)), Some(green), green),
            DiffLine::Separator => {
                return div()
                    .h(line_h)
                    .bg(t.muted.opacity(0.5))
                    .text_color(t.muted_foreground)
                    .px(sp(2.))
                    .child("⋯")
                    .into_any_element();
            }
        };
        div()
            .flex()
            .w_full()
            .min_h(line_h)
            .line_height(line_h)
            .when_some(bg, |d, bg| d.bg(bg))
            .child(div().flex_none().w(px(3.)).when_some(bar, |d, bar| d.bg(bar)))
            .child(
                div()
                    .flex_none()
                    .w(size * (0.62 * width as f32 + 1.6))
                    .pr(sp(2.))
                    .text_right()
                    .text_color(num_color)
                    .child(num),
            )
            .child(div().flex_1().min_w_0().pr(sp(2.)).whitespace_normal().child(if text.is_empty() { " ".into() } else { text }))
            .into_any_element()
    });
    div().py(sp(1.)).font_family(mono()).text_size(size).flex().flex_col().children(rows).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(v: Value) -> ToolCallView {
        ToolCallView::from_value(&v)
    }

    #[test]
    fn preview_prefers_command_then_path_then_raw() {
        assert_eq!(tool_preview(&call(json!({"toolCallId": "1", "rawInput": {"command": "ls"}}))), "ls");
        assert_eq!(
            tool_preview(&call(json!({"toolCallId": "1", "locations": [{"path": "/a.md"}], "rawInput": {"x": 1}}))),
            "/a.md"
        );
        assert_eq!(tool_preview(&call(json!({"toolCallId": "1", "rawInput": {"x": 1}}))), "{\"x\":1}");
        assert_eq!(tool_preview(&call(json!({"toolCallId": "1"}))), "");
    }

    #[test]
    fn empty_input_has_no_body() {
        assert!(!tool_has_body(&call(json!({"toolCallId": "1", "rawInput": {}}))));
        assert!(tool_has_body(&call(json!({"toolCallId": "1", "rawInput": {"a": 1}}))));
        assert!(tool_has_body(&call(json!({"toolCallId": "1", "content": [{"type": "content", "content": {"type": "text", "text": "x"}}]}))));
    }

    #[test]
    fn failed_calls_open_until_toggled() {
        let failed = call(json!({"toolCallId": "1", "status": "failed"}));
        assert!(tool_open(&failed, None));
        assert!(!tool_open(&failed, Some(false)));
        assert!(!tool_open(&call(json!({"toolCallId": "1", "status": "completed"})), None));
    }

    #[test]
    fn permission_buttons_fill_allows() {
        assert_eq!(permission_variant("allow_once"), ButtonVariant::Default);
        assert_eq!(permission_variant("allow_always"), ButtonVariant::Default);
        assert_eq!(permission_variant("reject_once"), ButtonVariant::Outline);
    }

    #[test]
    fn file_diff_numbers_and_counts() {
        let d = file_diff(
            "src/resolver.ts",
            Some("export function f(p) {\n  return p;\n}"),
            "export function f(p): R {\n  return { ok: true, path: p };\n}",
            1,
        );
        assert_eq!((d.added, d.removed), (2, 2));
        assert_eq!(d.lines[0], DiffLine::Removed { old: 1, text: "export function f(p) {".into() });
        assert_eq!(d.lines.last(), Some(&DiffLine::Context { old: 3, new: 3, text: "}".into() }));
    }

    #[test]
    fn new_file_is_all_additions_and_line_shifts() {
        let d = file_diff("a.md", None, "one\ntwo", 1);
        assert_eq!((d.added, d.removed), (2, 0));
        let shifted = file_diff("a.md", Some("x"), "y", 10);
        assert_eq!(shifted.lines[0], DiffLine::Removed { old: 10, text: "x".into() });
    }

    #[test]
    fn failed_or_diffless_calls_are_left_to_the_line() {
        let edit = json!({"toolCallId": "1", "status": "completed",
            "content": [{"type": "diff", "path": "/ws/a.md", "oldText": "a", "newText": "b"}]});
        assert_eq!(diff_files(&call(edit.clone())).map(|d| d.len()), Some(1));
        let mut failed = edit;
        failed["status"] = json!("failed");
        assert!(diff_files(&call(failed)).is_none());
        assert!(diff_files(&call(json!({"toolCallId": "1"}))).is_none());
    }

    #[test]
    fn labels_are_workspace_relative() {
        assert_eq!(diff_label("/ws/src/a.ts", "/ws"), "src/a.ts");
        assert_eq!(diff_label("/elsewhere/a.ts", "/ws/"), "/elsewhere/a.ts");
    }

    #[test]
    fn a_change_with_both_sides_splits_when_its_lines_fit() {
        use gpui_kit::component::diff::DiffMode;
        let d = file_diff("a.ts", Some("let a = 1;\nlet b = 2;\n"), "let a = 3;\nlet b = 2;\n", 1);
        assert_eq!(diff_mode(&d, 900.), DiffMode::Split);
        assert_eq!(diff_mode(&d, 120.), DiffMode::Unified);
        let added_only = file_diff("a.ts", Some("x\n"), "x\ny\n", 1);
        assert_eq!(diff_mode(&added_only, 900.), DiffMode::Unified);
        assert_eq!(diff_rows(&d, true), 3);
        assert_eq!(diff_rows(&d, false), 4);
        assert!(d.patch.starts_with("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@"), "{}", d.patch);
        let shifted = file_diff("a.md", Some("x"), "y", 10);
        assert!(shifted.patch.contains("@@ -10 +10 @@"), "{}", shifted.patch);
    }
}
