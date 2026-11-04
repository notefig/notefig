//! The chat tab (`agent-chat-tab.tsx`): a virtualized transcript (user
//! bubbles with queued badge and per-turn usage, assistant markdown,
//! collapsible thoughts, plans, tool-call cards with diffs), the permission,
//! auth and unavailable cards, and the composer with the session config bar
//! and context-fill indicator.

use std::collections::HashSet;
use std::path::PathBuf;

use gpui::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, Entity, EventEmitter,
    InteractiveElement, IntoElement, ListAlignment, ListState, ParentElement, Render,
    SharedString, StatefulInteractiveElement as _, Styled, Subscription, Window, div, list,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use notefig_agent::harness::ResumeShellDialect;
use notefig_agent::usage::TurnUsage;
use notefig_agent::{
    AgentTaskRow, EntryType, PermissionOutcome, PermissionRequestRow, PlanView, TaskStatus,
    ToolCallContentView, ToolCallView, TurnStatus, content_block_text,
};

use super::Agents;
use super::composer::{Composer, ComposerEvent, compose_message};
use super::glyph;
use crate::theme::BrandColors;

pub enum ChatEvent {
    /// Open a file the transcript points at (absolute path).
    OpenFile(PathBuf),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChatItem {
    User {
        id: String,
        turn_id: String,
        text: String,
        queued: bool,
        usage: Option<String>,
    },
    Assistant {
        id: String,
        text: String,
    },
    Thought {
        id: String,
        text: String,
    },
    Tool {
        id: String,
        call: ToolCallView,
    },
    Plan {
        id: String,
        plan: PlanView,
    },
    TurnError {
        turn_id: String,
        text: String,
    },
    Permission(PermissionRequestRow),
    Auth,
    Unavailable,
    Working,
}

pub struct ChatView {
    pub task_id: String,
    agents: Entity<Agents>,
    root: PathBuf,
    pub composer: Entity<Composer>,
    list: ListState,
    pub items: Vec<ChatItem>,
    row: Option<AgentTaskRow>,
    seen_version: u64,
    expanded: HashSet<String>,
    last_sent: Option<String>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ChatEvent> for ChatView {}

/// "1.2k tok · $0.03" for a turn.
pub fn usage_line(usage: &TurnUsage) -> Option<String> {
    let tokens = usage.total.tokens.total();
    if tokens <= 0.0 && usage.total.cost.is_none() {
        return None;
    }
    let mut out = format!("{} tok", compact(tokens));
    if let Some(cost) = &usage.total.cost {
        out.push_str(&format!(" · ${:.2}", cost.amount));
    }
    Some(out)
}

pub fn compact(n: f64) -> String {
    if n >= 1_000_000.0 {
        format!("{:.1}M", n / 1_000_000.0)
    } else if n >= 1000.0 {
        format!("{:.1}k", n / 1000.0)
    } else {
        format!("{n:.0}")
    }
}

impl ChatView {
    pub fn new(
        task_id: String,
        agents: Entity<Agents>,
        root: PathBuf,
        files: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let composer = cx.new(|cx| {
            let mut c = Composer::new("Ask the agent… (@ to mention a file)", window, cx);
            c.set_files(files);
            c
        });
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        list.set_follow_mode(gpui::FollowMode::Tail);
        let subs = vec![
            cx.observe(&agents, |this: &mut Self, agents, cx| {
                if agents.read(cx).task_version(&this.task_id) != this.seen_version {
                    cx.notify();
                }
            }),
            cx.subscribe_in(&composer, window, |this, _, event, window, cx| match event {
                ComposerEvent::Submit => this.send(window, cx),
                ComposerEvent::Cancel => this.escape(window, cx),
                ComposerEvent::Changed => {}
            }),
        ];
        let mut this = Self {
            task_id,
            agents,
            root,
            composer,
            list,
            items: Vec::new(),
            row: None,
            seen_version: u64::MAX,
            expanded: HashSet::new(),
            last_sent: None,
            _subs: subs,
        };
        this.refresh(cx);
        this
    }

    pub fn title(&self, cx: &App) -> SharedString {
        let row = self.agents.read(cx).handle.task(&self.task_id);
        match row {
            Some(row) if !row.title.trim().is_empty() => row.title.into(),
            Some(row) => self.agents.read(cx).handle.harness_label(&row.harness_id).into(),
            None => "Session".into(),
        }
    }

    pub fn set_files(&mut self, files: Vec<String>, cx: &mut Context<Self>) {
        self.composer.update(cx, |c, _| c.set_files(files));
    }

    /// Re-read the task's rows when its version moved.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let version = self.agents.read(cx).task_version(&self.task_id);
        if version == self.seen_version {
            return;
        }
        self.seen_version = version;
        let handle = self.agents.read(cx).handle.clone();
        let row = handle.task(&self.task_id);
        let entries = handle.entries(&self.task_id);
        let turns = handle.turns(&self.task_id);
        let permissions = handle.pending_permissions(&self.task_id);
        let mut items = Vec::new();
        let last_entry_of_turn = |turn_id: &str| entries.iter().rposition(|e| e.turn_id == turn_id);
        for (ix, entry) in entries.iter().enumerate() {
            let text = entry.text.clone().unwrap_or_default();
            match entry.kind {
                EntryType::User => {
                    let turn = turns.iter().find(|t| t.turn_id == entry.turn_id);
                    items.push(ChatItem::User {
                        id: entry.id.clone(),
                        turn_id: entry.turn_id.clone(),
                        text,
                        queued: turn.is_some_and(|t| t.status == TurnStatus::Queued),
                        usage: turn
                            .and_then(|t| t.usage.clone().flatten())
                            .and_then(|u| usage_line(&u)),
                    })
                }
                EntryType::Assistant if !text.trim().is_empty() => items.push(ChatItem::Assistant {
                    id: entry.id.clone(),
                    text,
                }),
                EntryType::Thought if !text.trim().is_empty() => items.push(ChatItem::Thought {
                    id: entry.id.clone(),
                    text,
                }),
                EntryType::ToolCall => {
                    if let Some(call) = entry.tool_call_view() {
                        items.push(ChatItem::Tool {
                            id: entry.id.clone(),
                            call,
                        })
                    }
                }
                EntryType::Plan => {
                    if let Some(plan) = entry.plan_view() {
                        items.push(ChatItem::Plan {
                            id: entry.id.clone(),
                            plan,
                        })
                    }
                }
                _ => {}
            }
            if last_entry_of_turn(&entry.turn_id) == Some(ix) {
                if let Some(turn) = turns.iter().find(|t| t.turn_id == entry.turn_id) {
                    if turn.status == TurnStatus::Error {
                        items.push(ChatItem::TurnError {
                            turn_id: turn.turn_id.clone(),
                            text: turn.error.clone().unwrap_or_else(|| "The turn failed.".into()),
                        });
                    }
                }
            }
        }
        if let Some(row) = &row {
            if matches!(row.status, TaskStatus::Running | TaskStatus::Starting) && permissions.is_empty() {
                items.push(ChatItem::Working);
            }
            items.extend(permissions.into_iter().take(1).map(ChatItem::Permission));
            if row.auth_required {
                items.push(ChatItem::Auth);
            }
            if row.status == TaskStatus::Unavailable {
                items.push(ChatItem::Unavailable);
            }
        }
        // Splice from the first changed item so measured heights survive.
        let first_diff = self
            .items
            .iter()
            .zip(items.iter())
            .position(|(a, b)| a != b)
            .unwrap_or(self.items.len().min(items.len()));
        let old_len = self.items.len();
        if first_diff < old_len || items.len() != old_len {
            self.list.splice(first_diff..old_len, items.len() - first_diff);
        }
        self.items = items;
        self.row = row;
    }

    pub fn is_busy(&self) -> bool {
        self.row
            .as_ref()
            .is_some_and(|r| matches!(r.status, TaskStatus::Running | TaskStatus::Starting))
    }

    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).text(cx);
        if text.is_empty() {
            return;
        }
        let (message, extras) = compose_message(&text, &self.root);
        self.last_sent = Some(text);
        self.composer.update(cx, |c, cx| c.clear(cx));
        let pending = self.agents.read(cx).handle.prompt(&self.task_id, &message, extras);
        cx.spawn(async move |_, _| {
            let _ = pending.recv().await;
        })
        .detach();
        self.list.scroll_to_end();
        Composer::focus(&self.composer, window, cx);
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        let pending = self.agents.read(cx).handle.cancel(&self.task_id);
        cx.spawn(async move |_, _| {
            let _ = pending.recv().await;
        })
        .detach();
    }

    /// Escape: cancel an unanswered turn and put its prompt back.
    pub fn escape(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if !self.is_busy() {
            return;
        }
        let pending = self.agents.read(cx).handle.cancel_turn_and_forget(&self.task_id);
        let restore = self.last_sent.clone();
        cx.spawn(async move |this, cx| {
            if pending.recv().await == Some(true) {
                if let Some(text) = restore {
                    let _ = this.update(cx, |this, cx| {
                        this.composer.update(cx, |c, cx| c.set_text(&text, cx));
                    });
                }
            }
        })
        .detach();
    }

    fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.expanded.remove(id) {
            self.expanded.insert(id.to_string());
        }
        if let Some(ix) = self.items.iter().position(|i| match i {
            ChatItem::Thought { id: x, .. } | ChatItem::Tool { id: x, .. } => x == id,
            _ => false,
        }) {
            self.list.remeasure_items(ix..ix + 1);
        }
        cx.notify();
    }

    fn open_path(&mut self, path: &str, cx: &mut Context<Self>) {
        let abs = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        cx.emit(ChatEvent::OpenFile(abs));
    }

    fn render_item(&mut self, ix: usize, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(item) = self.items.get(ix).cloned() else {
            return div().into_any_element();
        };
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let task = self.task_id.clone();
        let el = match item {
            ChatItem::User { id, turn_id, text, queued, usage } => {
                let handle = self.agents.read(cx).handle.clone();
                v_flex()
                    .items_end()
                    .gap_1()
                    .child(
                        div()
                            .id(SharedString::from(format!("user-{id}")))
                            .max_w(px(560.))
                            .px_3()
                            .py_2()
                            .rounded_lg()
                            .bg(theme.secondary)
                            .text_color(theme.secondary_foreground)
                            .child(TextView::markdown(SharedString::from(format!("um-{id}")), text).selectable(true)),
                    )
                    .when(queued, |this| {
                        this.child(
                            h_flex()
                                .gap_1()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Queued")
                                .child(
                                    Button::new(SharedString::from(format!("unqueue-{id}")))
                                        .icon(IconName::Close)
                                        .ghost()
                                        .xsmall()
                                        .tooltip("Remove from queue")
                                        .on_click(move |_, _, _| handle.remove_queued_prompt(&task, &turn_id)),
                                ),
                        )
                    })
                    .when_some(usage, |this, usage| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(usage))
                    })
                    .into_any_element()
            }
            ChatItem::Assistant { id, text } => div()
                .w_full()
                .child(TextView::markdown(SharedString::from(format!("am-{id}")), text).selectable(true))
                .into_any_element(),
            ChatItem::Thought { id, text } => {
                let open = self.expanded.contains(&id);
                let toggle_id = id.clone();
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .id(SharedString::from(format!("thought-{id}")))
                            .gap_1()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .cursor_pointer()
                            .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).xsmall())
                            .child("Thinking")
                            .on_click(cx.listener(move |this, _, _, cx| this.toggle(&toggle_id, cx))),
                    )
                    .when(open, |this| {
                        this.child(
                            div()
                                .pl_4()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child(TextView::markdown(SharedString::from(format!("tm-{id}")), text)),
                        )
                    })
                    .into_any_element()
            }
            ChatItem::Tool { id, call } => self.render_tool(&id, &call, cx),
            ChatItem::Plan { plan, .. } => v_flex()
                .gap_0p5()
                .p_2()
                .rounded_md()
                .border_1()
                .border_color(theme.border)
                .child(div().text_xs().text_color(theme.muted_foreground).child("Plan"))
                .children(plan.entries.into_iter().map(|e| {
                    let mark = match e.status.as_deref() {
                        Some("completed") => "✓",
                        Some("in_progress") => "◐",
                        _ => "○",
                    };
                    h_flex()
                        .gap_2()
                        .text_sm()
                        .child(mark)
                        .child(e.content)
                }))
                .into_any_element(),
            ChatItem::TurnError { text, .. } => div()
                .px_3()
                .py_2()
                .rounded_md()
                .text_sm()
                .bg(brand.warning.opacity(0.12))
                .text_color(brand.warning)
                .child(text)
                .into_any_element(),
            ChatItem::Working => h_flex()
                .gap_2()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(glyph::render(glyph::Glyph::Moving, format!("working-{}", self.task_id), cx))
                .child("Working…")
                .into_any_element(),
            ChatItem::Permission(req) => self.render_permission(req, cx),
            ChatItem::Auth => self.render_auth(cx),
            ChatItem::Unavailable => self.render_unavailable(cx),
        };
        div().w_full().px_4().py_1p5().child(el).into_any_element()
    }

    fn render_tool(&mut self, id: &str, call: &ToolCallView, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let open = self.expanded.contains(id);
        let status = call.status.as_deref().unwrap_or("pending");
        let (mark, color) = match status {
            "completed" => ("✓", brand.success),
            "failed" => ("✗", brand.warning),
            "in_progress" => ("◐", brand.brand),
            _ => ("○", theme.muted_foreground),
        };
        let title = call.title.clone().unwrap_or_else(|| "Tool call".into());
        let toggle_id = id.to_string();
        let mut body = v_flex().gap_1();
        if !call.locations.is_empty() {
            body = body.child(h_flex().flex_wrap().gap_1().children(call.locations.iter().enumerate().map(|(ix, loc)| {
                let loc2 = loc.clone();
                let label = loc
                    .strip_prefix(&format!("{}/", self.root.to_string_lossy()))
                    .unwrap_or(loc)
                    .to_string();
                div()
                    .id(SharedString::from(format!("loc-{id}-{ix}")))
                    .px_1p5()
                    .rounded_sm()
                    .text_xs()
                    .bg(theme.muted)
                    .cursor_pointer()
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| this.open_path(&loc2, cx)))
            })));
        }
        for (ix, content) in call.content.iter().enumerate() {
            match content {
                ToolCallContentView::Diff { path, old_text, new_text } => {
                    let (added, removed, preview) = diff_preview(old_text.as_deref().unwrap_or(""), new_text);
                    let path2 = path.clone();
                    let rel = path
                        .strip_prefix(&format!("{}/", self.root.to_string_lossy()))
                        .unwrap_or(path)
                        .to_string();
                    let lines = if open { preview.len() } else { preview.len().min(8) };
                    body = body.child(
                        v_flex()
                            .rounded_md()
                            .border_1()
                            .border_color(theme.border)
                            .overflow_hidden()
                            .child(
                                h_flex()
                                    .id(SharedString::from(format!("diff-{id}-{ix}")))
                                    .px_2()
                                    .py_1()
                                    .gap_2()
                                    .text_xs()
                                    .bg(theme.muted)
                                    .cursor_pointer()
                                    .child(div().flex_1().child(rel))
                                    .child(div().text_color(brand.success).child(format!("+{added}")))
                                    .child(div().text_color(brand.warning).child(format!("−{removed}")))
                                    .on_click(cx.listener(move |this, _, _, cx| this.open_path(&path2, cx))),
                            )
                            .children(preview.into_iter().take(lines).map(|(sign, line)| {
                                let bg = match sign {
                                    '+' => brand.success.opacity(0.14),
                                    '-' => brand.warning.opacity(0.12),
                                    _ => gpui::transparent_black(),
                                };
                                div()
                                    .px_2()
                                    .text_xs()
                                    .font_family(theme.mono_font_family.clone())
                                    .bg(bg)
                                    .child(format!("{sign} {line}"))
                            })),
                    );
                }
                ToolCallContentView::Content(value) => {
                    let text = content_block_text(value);
                    if !text.trim().is_empty() {
                        let shown: String = if open { text.to_string() } else { text.lines().take(6).collect::<Vec<_>>().join("\n") };
                        body = body.child(
                            div()
                                .px_2()
                                .py_1()
                                .rounded_sm()
                                .bg(theme.muted)
                                .text_xs()
                                .font_family(theme.mono_font_family.clone())
                                .child(shown),
                        );
                    }
                }
                ToolCallContentView::Terminal { terminal_id } => {
                    body = body.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!("Terminal {terminal_id} (output is shown in the harness)")),
                    );
                }
                ToolCallContentView::Other(_) => {}
            }
        }
        v_flex()
            .gap_1()
            .p_2()
            .rounded_md()
            .border_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .id(SharedString::from(format!("tool-{id}")))
                    .gap_2()
                    .text_sm()
                    .cursor_pointer()
                    .child(div().text_color(color).child(mark))
                    .child(div().flex_1().truncate().child(title))
                    .when_some(call.kind.clone(), |this, kind| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(kind))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(&toggle_id, cx))),
            )
            .child(body)
            .into_any_element()
    }

    fn render_permission(&mut self, req: PermissionRequestRow, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let handle = self.agents.read(cx).handle.clone();
        v_flex()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(brand.brand)
            .child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD).child(req.title.clone()))
            .child(h_flex().flex_wrap().gap_1().children(req.options.iter().map(|opt| {
                let handle = handle.clone();
                let (task, rid, oid) = (req.task_id.clone(), req.id.clone(), opt.option_id.clone());
                let b = Button::new(SharedString::from(format!("perm-{}-{}", req.id, opt.option_id)))
                    .label(if opt.name.is_empty() { opt.option_id.clone() } else { opt.name.clone() })
                    .small();
                let b = match opt.kind.as_str() {
                    "allow_once" => b.primary(),
                    "allow_always" => b.outline(),
                    _ => b.ghost(),
                };
                b.on_click(move |_, _, _| {
                    handle.respond_permission(&task, &rid, PermissionOutcome::Selected(oid.clone()));
                })
            })))
            .child(div().text_xs().text_color(theme.muted_foreground).child("The agent is waiting for your answer."))
            .into_any_element()
    }

    fn render_auth(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let row = self.row.clone();
        let handle = self.agents.read(cx).handle.clone();
        let task = self.task_id.clone();
        let methods = row.as_ref().map(|r| r.auth_methods.clone()).unwrap_or_default();
        let hint = row.as_ref().and_then(|r| r.auth_hint.clone());
        let retry = {
            let (handle, task) = (handle.clone(), task.clone());
            move |_: &gpui::ClickEvent, _: &mut Window, _: &mut App| {
                let _ = handle.retry_after_auth(&task);
            }
        };
        v_flex()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme.border)
            .child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD).child("Sign in to continue"))
            .when_some(hint, |this, hint| this.child(div().text_xs().text_color(theme.muted_foreground).child(hint)))
            .children(methods.into_iter().map(|m| {
                let (handle, task, mid) = (handle.clone(), task.clone(), m.id.clone());
                v_flex()
                    .gap_0p5()
                    .child(
                        Button::new(SharedString::from(format!("auth-{}", m.id)))
                            .label(if m.name.is_empty() { m.id.clone() } else { m.name.clone() })
                            .small()
                            .outline()
                            .on_click(move |_, _, _| {
                                let _ = handle.authenticate(&task, &mid);
                            }),
                    )
                    .when_some(m.description.clone(), |this, d| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(d))
                    })
            }))
            .child(Button::new("auth-retry").label("I've signed in").small().primary().on_click(retry))
            .into_any_element()
    }

    fn render_unavailable(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let handle = self.agents.read(cx).handle.clone();
        let resume = handle.resume_command(&self.task_id, ResumeShellDialect::Posix);
        let task = self.task_id.clone();
        v_flex()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme.border)
            .child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD).child("This session can't be resumed here"))
            .child(div().text_xs().text_color(theme.muted_foreground).child(
                "The transcript is read-only. You can continue it in a terminal with the resume command.",
            ))
            .child(
                h_flex()
                    .gap_1()
                    .when_some(resume, |this, cmd| {
                        this.child(Button::new("copy-resume").label("Copy resume command").small().outline().on_click(
                            move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone())),
                        ))
                    })
                    .child(Button::new("delete-session").label("Delete").small().ghost().on_click(move |_, _, _| {
                        let _ = handle.delete(&task);
                    })),
            )
            .into_any_element()
    }

    fn render_config_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let Some(row) = self.row.clone() else {
            return div().into_any_element();
        };
        if row.status == TaskStatus::Restored {
            return div().into_any_element();
        }
        let handle = self.agents.read(cx).handle.clone();
        let selects: Vec<_> = row
            .config_options
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|o| matches!(o.category.as_deref(), Some("model") | Some("thought_level")))
            .collect();
        let mut bar = h_flex().gap_1();
        for select in selects {
            let current = select.current().unwrap_or("").to_string();
            let label = select
                .choices()
                .iter()
                .find(|c| c.value == current)
                .map(|c| if c.name.is_empty() { c.value.clone() } else { c.name.clone() })
                .unwrap_or(current.clone());
            let (handle, task) = (handle.clone(), self.task_id.clone());
            let id = select.id.clone();
            let choices: Vec<(String, String)> = select
                .choices()
                .iter()
                .map(|c| (c.value.clone(), if c.name.is_empty() { c.value.clone() } else { c.name.clone() }))
                .collect();
            bar = bar.child(
                Button::new(SharedString::from(format!("cfg-{}", select.id)))
                    .label(label)
                    .ghost()
                    .xsmall()
                    .dropdown_caret(true)
                    .dropdown_menu(move |mut menu, _, _| {
                        for (value, name) in &choices {
                            let (handle, task, id, value) = (handle.clone(), task.clone(), id.clone(), value.clone());
                            menu = menu.item(
                                PopupMenuItem::new(name.clone())
                                    .checked(value == current)
                                    .on_click(move |_, _, _| {
                                        let _ = handle.set_config_option(&task, &id, &value);
                                    }),
                            );
                        }
                        menu.max_h(px(360.)).scrollable(true)
                    }),
            );
        }
        let context = row.usage.as_ref().and_then(|u| u.context);
        bar.child(div().flex_1())
            .when_some(context, |this, ctx| {
                let pct = if ctx.size > 0.0 { (ctx.used / ctx.size * 100.0).round() } else { 0.0 };
                this.child(
                    h_flex()
                        .gap_1()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(
                            div().w(px(40.)).h(px(4.)).rounded_full().bg(theme.muted).child(
                                div()
                                    .h_full()
                                    .rounded_full()
                                    .bg(BrandColors::get(cx).brand)
                                    .w(px(40. * (pct as f32 / 100.).clamp(0., 1.))),
                            ),
                        )
                        .child(format!("{pct:.0}% of {}", compact(ctx.size))),
                )
            })
            .when_some(row.usage.as_ref().and_then(|u| u.total.cost.clone()), |this, cost| {
                this.child(div().text_xs().text_color(theme.muted_foreground).child(format!("${:.2}", cost.amount)))
            })
            .into_any_element()
    }
}

/// `(added, removed, rows)` of a line diff (common prefix/suffix trimmed;
/// the middle shown as removed then added).
pub fn diff_preview(old: &str, new: &str) -> (usize, usize, Vec<(char, String)>) {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let removed = &a[prefix..a.len() - suffix];
    let added = &b[prefix..b.len() - suffix];
    let mut rows = Vec::new();
    if prefix > 0 {
        rows.push((' ', a[prefix - 1].to_string()));
    }
    rows.extend(removed.iter().map(|l| ('-', l.to_string())));
    rows.extend(added.iter().map(|l| ('+', l.to_string())));
    (added.len(), removed.len(), rows)
}

impl Render for ChatView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refresh(cx);
        let theme = cx.theme().clone();
        let view = cx.entity().downgrade();
        let busy = self.is_busy();
        let read_only = self.row.as_ref().is_some_and(|r| r.status == TaskStatus::Unavailable);
        let transcript = list(self.list.clone(), move |ix, window, cx| {
            view.upgrade()
                .map(|v| v.update(cx, |this, cx| this.render_item(ix, window, cx)))
                .unwrap_or_else(|| div().into_any_element())
        })
        .size_full();
        let empty = self.items.is_empty();
        v_flex()
            .size_full()
            .bg(theme.background)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(transcript)
                    .when(empty, |this| {
                        this.child(
                            v_flex()
                                .absolute()
                                .inset_0()
                                .items_center()
                                .justify_center()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child(self.title(cx))
                                .child("Ask anything about this workspace."),
                        )
                    }),
            )
            .when(!read_only, |this| {
                this.child(
                    v_flex()
                        .p_3()
                        .gap_1()
                        .border_t_1()
                        .border_color(theme.border)
                        .child(
                            h_flex()
                                .gap_2()
                                .items_end()
                                .child(
                                    div()
                                        .flex_1()
                                        .rounded_md()
                                        .border_1()
                                        .border_color(theme.input)
                                        .child(self.composer.clone()),
                                )
                                .when(busy, |this| {
                                    this.child(Button::new("chat-stop").label("Stop").small().outline().on_click(
                                        cx.listener(|this, _, _, cx| this.stop(cx)),
                                    ))
                                })
                                .child(
                                    Button::new("chat-send")
                                        .label(if busy { "Queue" } else { "Send" })
                                        .small()
                                        .primary()
                                        .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                                ),
                        )
                        .child(self.render_config_bar(cx)),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::diff_preview;

    #[test]
    fn diff_rows() {
        let (a, r, rows) = diff_preview("x\ny\nz\n", "x\nY\nz\n");
        assert_eq!((a, r), (1, 1));
        assert_eq!(rows, vec![(' ', "x".into()), ('-', "y".into()), ('+', "Y".into())]);
    }
}
