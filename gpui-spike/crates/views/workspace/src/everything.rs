//! `EverythingPanel` (components/editor/everything-panel.tsx): the
//! command-center view over every open workspace — quick ways to start
//! something, then what the user worked with most recently (files and
//! scratchpads), wherever it lives.
//!
//! "Needs attention" is the card of asks the agent is blocked on (a pending
//! permission or a sign-in), each jumping to where it is answered. "Prompt
//! rounds" and "Agent sessions" are the newest across open workspaces.
//! "New session" lands on the Sessions tool, where the harness is picked.

use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Window, div, prelude::FluentBuilder as _,
};
use notefig_core::Subscription;
use notefig_recent_documents::{RecentDocument, RecentDocumentsModule};
use notefig_scratchpads::ScratchpadsModule;
use notefig_sidebar_view::{SidebarView, WorkspaceTool};
use notefig_tabs::TabsModule;
use notefig_agents::{AgentStoreModule, AgentTaskRow, TaskStatus};
use notefig_attention::{AttentionAsk, AttentionItem, AttentionKind, AttentionModule, most_pressing};
use notefig_prompt_rounds::{PromptRound, PromptRoundsModule, derive_prompt_rounds};
use notefig_i18n::{t as tr, t_args, t_count};
use notefig_ui::{CoreExt as _, icon, observe, separator, sp, tokens};
use notefig_view_agent::{
    StatusGlyphState, TabsJumper, jump_to_round, status_glyph, task_glyph_state, turn_glyph_state,
};

use crate::root::open_folder;
use crate::shell::show_view;
use crate::sidebar::project_name;

const FILES_SHOWN: usize = 6;
const SCRATCHPADS_SHOWN: usize = 4;
const RECENT_DOCUMENTS_FETCHED: usize = 30;
const ROUNDS_SHOWN: usize = 6;
const SESSIONS_SHOWN: usize = 6;
const ATTENTION_COLLAPSED_ROWS: usize = 3;

pub struct EverythingPanel {
    workspace_path: String,
    attention_expanded: bool,
    _subs: Vec<Subscription>,
}

impl EverythingPanel {
    pub fn new(workspace_path: &str, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let recent = core.use_::<RecentDocumentsModule>();
        let tabs = core.use_::<TabsModule>();
        let store = core.use_::<AgentStoreModule>();
        let rounds = core.use_::<PromptRoundsModule>();
        let attention = core.use_::<AttentionModule>();
        let subs = vec![
            observe(cx, move |notify| attention.subscribe(move || notify())),
            observe(cx, move |notify| recent.subscribe(move || notify())),
            observe(cx, move |notify| tabs.subscribe(move || notify())),
            observe(cx, move |notify| store.subscribe(move || notify())),
            observe(cx, move |notify| rounds.subscribe(move || notify())),
        ];
        Self { workspace_path: workspace_path.into(), attention_expanded: false, _subs: subs }
    }

    pub fn set_workspace(&mut self, path: &str, cx: &mut Context<Self>) {
        self.workspace_path = path.into();
        cx.notify();
    }
}

/// `NavRow` with a leading element of its own (a status glyph).
fn nav_row_with(
    id: impl Into<gpui::ElementId>,
    leading: AnyElement,
    label: impl Into<SharedString>,
    trailing: Option<String>,
    active: bool,
    emphasis: bool,
    cx: &gpui::App,
) -> gpui::Stateful<gpui::Div> {
    let t = tokens(cx);
    let hover = t.accent.opacity(0.5);
    div()
        .id(id)
        .flex()
        .w_full()
        .items_center()
        .gap(sp(2.5))
        .px(sp(2.))
        .py(sp(1.5))
        .rounded(t.radius_md)
        .text_size(t.text_xs)
        .line_height(t.leading_xs)
        .cursor_pointer()
        .when(active, |d| d.bg(t.accent))
        .when(!active, |d| d.hover(move |s| s.bg(hover)))
        .child(div().flex().flex_none().size(sp(3.)).items_center().justify_center().child(leading))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .when(emphasis, |d| d.font_weight(FontWeight::MEDIUM))
                .child(label.into()),
        )
        .when_some(trailing, |d, note| {
            d.child(div().flex_none().text_size(t.text_2xs).text_color(t.muted_foreground.opacity(0.8)).child(note))
        })
}

/// The app's jumper (`jumpToTask`/`jumpToRound`) over tabs and widgets.
fn jumper(cx: &gpui::App) -> TabsJumper {
    let core = cx.core();
    TabsJumper::new(&core)
}

/// `attentionGlyphState`.
fn attention_glyph(kind: AttentionKind) -> StatusGlyphState {
    match kind {
        AttentionKind::Bau => StatusGlyphState::AttentionBau,
        AttentionKind::Error => StatusGlyphState::AttentionError,
    }
}

/// `askLabel`: what an ask says, the request itself when there is one.
fn ask_label(item: &AttentionItem) -> String {
    if let Some(permission) = &item.permission {
        return permission.title.clone();
    }
    if let Some(question) = &item.question {
        return question.clone();
    }
    let title = item.task.as_ref().map(|t| t.title.as_str()).unwrap_or("");
    t_args("attentionAuth", &[("title", title)])
}

/// `jumpToAsk`: a widget's question is answered in its document; the
/// others through their session.
fn jump_to_ask(item: &AttentionItem, cx: &mut gpui::App) {
    let jumper = jumper(cx);
    match (&item.ask, &item.turn_id, &item.target) {
        (Some(AttentionAsk::Question), Some(turn), notefig_seen::SeenTarget::Document(doc)) => {
            jump_to_round(&jumper, &item.task_id, turn, doc)
        }
        _ => {
            notefig_view_agent::jump_to_task(&jumper, &item.task_id, item.turn_id.as_deref());
        }
    }
}

fn rounds(cx: &gpui::App) -> Vec<PromptRound> {
    let core = cx.core();
    let store = core.use_::<AgentStoreModule>();
    let rows = core.use_::<PromptRoundsModule>().collection().values();
    let open: Vec<(String, String)> = core.workspaces().list().into_iter().map(|w| (w.key, w.path)).collect();
    let turns: Vec<(String, notefig_agent::model::TurnStatus)> =
        rows.iter().filter_map(|r| store.turn(&r.turn_id).map(|t| (r.turn_id.clone(), t.status))).collect();
    let mut all = derive_prompt_rounds(&rows, &open, &turns);
    all.truncate(ROUNDS_SHOWN);
    all
}

fn sessions(cx: &gpui::App) -> Vec<AgentTaskRow> {
    let core = cx.core();
    let open: Vec<String> = core.workspaces().list().into_iter().map(|w| w.path).collect();
    let mut tasks: Vec<AgentTaskRow> = core
        .use_::<AgentStoreModule>()
        .tasks()
        .into_iter()
        .filter(|t| open.contains(&t.workspace_path) && t.parent_task_id.is_none())
        .collect();
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    tasks.truncate(SESSIONS_SHOWN);
    tasks
}

/// `NavRow`: a leading glyph, a label that truncates, a muted trailing note.
fn nav_row(
    id: impl Into<gpui::ElementId>,
    glyph: &str,
    label: impl Into<SharedString>,
    trailing: Option<String>,
    active: bool,
    cx: &gpui::App,
) -> gpui::Stateful<gpui::Div> {
    let t = tokens(cx);
    let hover = t.accent.opacity(0.5);
    div()
        .id(id)
        .flex()
        .w_full()
        .items_center()
        .gap(sp(2.5))
        .px(sp(2.))
        .py(sp(1.5))
        .rounded(t.radius_md)
        .text_size(t.text_xs)
        .line_height(t.leading_xs)
        .cursor_pointer()
        .when(active, |d| d.bg(t.accent))
        .when(!active, |d| d.hover(move |s| s.bg(hover)))
        .child(
            div()
                .flex()
                .flex_none()
                .size(sp(3.))
                .items_center()
                .justify_center()
                .text_color(t.muted_foreground)
                .child(icon(glyph).size(sp(3.)).text_color(t.muted_foreground)),
        )
        .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(label.into()))
        .when_some(trailing, |d, note| {
            d.child(div().flex_none().text_size(t.text_2xs).text_color(t.muted_foreground.opacity(0.8)).child(note))
        })
}

fn section_title(glyph: &str, title: &str, cx: &gpui::App) -> gpui::Div {
    marked_section_title(glyph, title, None, cx)
}

/// `SectionTitle` with its most pressing mark, so a glance sees it.
fn marked_section_title(glyph: &str, title: &str, attention: Option<AttentionKind>, cx: &gpui::App) -> gpui::Div {
    let t = tokens(cx);
    div()
        .flex()
        .items_center()
        .gap(sp(2.5))
        .px(sp(2.))
        .pb(sp(1.))
        .text_size(t.text_xs)
        .line_height(t.leading_xs)
        .text_color(t.muted_foreground)
        .child(icon(glyph).size(sp(3.)).text_color(t.muted_foreground))
        .child(div().overflow_hidden().whitespace_nowrap().text_ellipsis().child(title.to_string()))
        .when_some(attention, |d, kind| {
            d.child(div().flex().flex_none().child(status_glyph(attention_glyph(kind), ("section-mark", title.len()), cx)))
        })
}

/// `formatTimeAgo`, short.
fn time_ago(ms: i64) -> String {
    let now = notefig_recent_documents::now_ms();
    let s = ((now - ms) / 1000).max(0);
    match s {
        0..=59 => "now".into(),
        60..=3599 => format!("{}m", s / 60),
        3600..=86_399 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86_400),
    }
}

impl EverythingPanel {
    /// `AttentionGroup`: what the agent is blocked on, as a card; a row
    /// jumps to where it is answered.
    fn attention_card(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let items = cx.core().use_::<AttentionModule>().get().asks.clone();
        if items.is_empty() {
            return div().into_any_element();
        }
        let t = tokens(cx).clone();
        let overflow = items.len().saturating_sub(ATTENTION_COLLAPSED_ROWS);
        let shown = if self.attention_expanded { items.len() } else { ATTENTION_COLLAPSED_ROWS.min(items.len()) };
        let fg = t.foreground;
        div()
            .mx(sp(1.))
            .mt(sp(4.))
            .flex_none()
            .overflow_hidden()
            .rounded(t.radius_lg)
            .border_1()
            .border_color(t.border.opacity(0.7))
            .bg(t.card)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .p(sp(1.))
                    .pt(sp(1.5))
                    .child(section_title("circle-alert", &tr("needsAttention"), cx))
                    .children(items.iter().take(shown).enumerate().map(|(i, ask)| {
                        let item = ask.clone();
                        nav_row_with(
                            ("ask", i),
                            status_glyph(attention_glyph(ask.kind), ("ask-glyph", i), cx),
                            ask_label(ask),
                            Some(time_ago(ask.since)),
                            false,
                            false,
                            cx,
                        )
                        .on_click(move |_, _, cx| jump_to_ask(&item, cx))
                        .into_any_element()
                    })),
            )
            .when(overflow > 0, |d| {
                d.child(
                    div()
                        .id("attention-more")
                        .flex()
                        .w_full()
                        .items_center()
                        .gap(sp(2.5))
                        .px(sp(2.))
                        .py(sp(1.5))
                        .bg(t.muted.opacity(0.4))
                        .text_size(t.text_xs)
                        .text_color(t.muted_foreground)
                        .cursor_pointer()
                        .hover(move |s| s.text_color(fg))
                        .child(icon(if self.attention_expanded { "chevrons-up" } else { "chevrons-down" }).size(sp(3.)).text_color(t.muted_foreground))
                        .child(if self.attention_expanded { tr("showLess") } else { t_count("showMore", overflow as i64) })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.attention_expanded = !this.attention_expanded;
                            cx.notify();
                        })),
                )
            })
            .into_any_element()
    }
}

impl Render for EverythingPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let t_ = t.clone();
        let core = cx.core();
        let recent = core.use_::<RecentDocumentsModule>().recent(&core, RECENT_DOCUMENTS_FETCHED);
        let active = core.use_::<TabsModule>().active_tab_id();
        let files: Vec<RecentDocument> = recent.iter().filter(|d| !d.is_scratchpad).take(FILES_SHOWN).cloned().collect();
        let pads: Vec<RecentDocument> = recent.iter().filter(|d| d.is_scratchpad).take(SCRATCHPADS_SHOWN).cloned().collect();
        let ws = self.workspace_path.clone();
        // `RecentDocumentRow`: a ring marker (filled in brand for the
        // document in front), the name, and its workspace's name.
        let row = |prefix: &'static str, i: usize, d: &RecentDocument, _glyph: &str, cx: &gpui::App| -> AnyElement {
            let path = d.path.clone();
            let name = std::path::Path::new(&d.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let is_active = active.as_deref() == Some(d.path.as_str());
            let marker = div()
                .size(sp(1.5))
                .rounded_full()
                .when(is_active, |m| m.bg(t_.brand))
                .when(!is_active, |m| m.border_1().border_color(t_.muted_foreground.opacity(0.7)))
                .into_any_element();
            nav_row_with((prefix, i), marker, name, Some(project_name(&d.workspace_path)), is_active, false, cx)
                .on_click(move |_, _, cx| {
                    cx.core().use_::<TabsModule>().open(&path, Default::default());
                })
                .into_any_element()
        };
        let mut sections: Vec<AnyElement> = Vec::new();
        let attention = core.use_::<AttentionModule>().get();
        let round_rows = rounds(cx);
        let round_marks: Vec<Option<AttentionKind>> =
            round_rows.iter().map(|r| attention.by_round.get(&r.turn_id).copied()).collect();
        if !round_rows.is_empty() {
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .pt(sp(4.))
                    .child(marked_section_title(
                        "message-square-text",
                        &tr("promptRounds"),
                        round_marks.iter().copied().fold(None, most_pressing),
                        cx,
                    ))
                    .children(round_rows.iter().enumerate().map(|(i, r)| {
                        let (task, turn, doc) = (r.task_id.clone(), r.turn_id.clone(), r.document_path.clone());
                        let label = if r.prompt.trim().is_empty() { "Prompt".to_string() } else { r.prompt.clone() };
                        let mark = round_marks[i];
                        let state = mark.map(attention_glyph).unwrap_or_else(|| turn_glyph_state(r.status));
                        nav_row_with(
                            ("round", i),
                            status_glyph(state, ("round-glyph", i), cx),
                            label,
                            Some(time_ago(r.started_at)),
                            active.as_deref() == Some(r.document_path.as_str()),
                            mark.is_some(),
                            cx,
                        )
                        .on_click(move |_, _, cx| jump_to_round(&jumper(cx), &task, &turn, &doc))
                        .into_any_element()
                    }))
                    .into_any_element(),
            );
        }
        let session_rows = sessions(cx);
        let session_marks: Vec<Option<AttentionKind>> =
            session_rows.iter().map(|t| attention.by_task.get(&t.task_id).copied()).collect();
        if !session_rows.is_empty() {
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .pt(sp(4.))
                    .child(marked_section_title(
                        WorkspaceTool::Sessions.icon(),
                        &tr("agentSessions"),
                        session_marks.iter().copied().fold(None, most_pressing),
                        cx,
                    ))
                    .children(session_rows.iter().enumerate().map(|(i, task)| {
                        let id = task.task_id.clone();
                        let tab = notefig_tabs::agent_tab_id(&task.task_id);
                        let running = matches!(task.status, TaskStatus::Running | TaskStatus::Starting);
                        let state = session_marks[i].map(attention_glyph).unwrap_or_else(|| task_glyph_state(task));
                        let glyph = if state == StatusGlyphState::Idle {
                            icon("message-square-text").size(sp(3.)).text_color(t.muted_foreground).into_any_element()
                        } else {
                            status_glyph(state, ("session-glyph", i), cx)
                        };
                        nav_row_with(
                            ("session", i),
                            glyph,
                            if task.title.is_empty() { "New session".to_string() } else { task.title.clone() },
                            (!running).then(|| time_ago(task.updated_at)),
                            active.as_deref() == Some(tab.as_str()),
                            false,
                            cx,
                        )
                        .on_click(move |_, _, cx| cx.core().use_::<TabsModule>().open_agent(&id))
                        .into_any_element()
                    }))
                    .into_any_element(),
            );
        }
        if !files.is_empty() {
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .pt(sp(4.))
                    .child(section_title(WorkspaceTool::Files.icon(), &tr("everythingFiles"), cx))
                    .children(files.iter().enumerate().map(|(i, d)| row("recent-file", i, d, "file-text", cx)))
                    .into_any_element(),
            );
        }
        if !pads.is_empty() {
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .pt(sp(4.))
                    .child(section_title("hash", &tr("everythingScratchpads"), cx))
                    .children(pads.iter().enumerate().map(|(i, d)| row("recent-pad", i, d, "hash", cx)))
                    .into_any_element(),
            );
        }
        let ws_new = ws.clone();
        let ws_session = ws.clone();
        div()
            .id("everything")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(sp(1.))
            .py(sp(2.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_none()
                    .child(nav_row("qa-scratchpad", "hash", tr("newScratchpad"), None, false, cx).on_click(move |_, _, cx| {
                        if let Ok(pads) = cx.core().workspace(&ws_new).get::<ScratchpadsModule>() {
                            cx.foreground_executor().spawn(pads.create_and_open()).detach();
                        }
                    }))
                    .child(nav_row("qa-session", "message-square-plus", tr("agentNewSession"), None, false, cx).on_click(move |_, _, cx| {
                        show_view(SidebarView::Tool(WorkspaceTool::Sessions), &ws_session, cx)
                    }))
                    .child(
                        nav_row("qa-open", "folder-plus", tr("openProject"), None, false, cx)
                            .on_click(|_, _, cx| open_folder(cx)),
                    ),
            )
            .child(separator(false, cx).mx(sp(1.)).mt(sp(2.)))
            .child(self.attention_card(cx))
            .when(sections.is_empty(), |d| {
                d.child(
                    div()
                        .p(sp(3.))
                        .text_size(t.text_xs)
                        .text_color(t.muted_foreground)
                        .child(tr("everythingEmpty")),
                )
            })
            .children(sections)
            .font_weight(FontWeight::NORMAL)
    }
}
