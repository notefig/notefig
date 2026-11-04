//! `sessions-panel.tsx` (+ `describeTaskMeta`, `formatTimeAgo`, the task
//! half of `utils/attention.ts`, `use-harness-selection.ts`) and
//! `jump-to-task.ts`.
//!
//! The left-sidebar sessions tool: every agent session in the workspace,
//! last activity first, with live status glyphs and meta. Clicking a row
//! opens (or focuses) its chat tab; right-click offers refresh, copy
//! session id, copy resume command and delete. The split button starts a
//! session on the default harness at once; its chevron lists the active
//! harnesses, and picking one starts on it and makes it the default. The
//! first start in a workspace asks for trust once.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClipboardItem, Context, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Pixels, Point, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    anchored, deferred, div, point, prelude::FluentBuilder as _, px,
};
use notefig_agent::harness::HarnessDefinition;
use notefig_agent::model::{AgentTaskRow, LastSettled, PermissionRequestRow, TaskStatus, TurnStatus};
use notefig_agents::{AgentStoreModule, AgentsModule, StartResult};
use notefig_core::WorkspaceHandle;
use notefig_i18n::{t as tr, t_args};
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use crate::glyph::{AttentionKind, attention_glyph_state, harness_logo, status_glyph, task_glyph_state};
use crate::style::{ButtonSize, ButtonVariant, PopoverSide, anchored_popover, button, menu_item, popover_frame, rule, text_11};

pub fn init(_: &mut App) {}

/// The KV key of the default harness (`DEFAULT_HARNESS_KEY`), in the
/// `agent` namespace.
pub const DEFAULT_HARNESS_KEY: &str = "default-harness";

// ─── task meta ───────────────────────────────────────────────────────────────

/// `AgentTaskMeta`.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentTaskMeta {
    pub task: AgentTaskRow,
    pub queued_count: usize,
    pub is_running: bool,
    pub needs_auth: bool,
    pub is_error: bool,
    pub is_unavailable: bool,
}

/// `toTaskMeta`.
pub fn task_meta(task: AgentTaskRow, queued_count: usize) -> AgentTaskMeta {
    AgentTaskMeta {
        queued_count,
        is_running: task.status == TaskStatus::Running,
        needs_auth: task.auth_required,
        is_error: task.status == TaskStatus::Error,
        is_unavailable: task.status == TaskStatus::Unavailable,
        task,
    }
}

/// `describeTaskMeta`: the row's status label, or None (a restored or idle
/// session says nothing; the list shows a time ago).
pub fn describe_task_meta(meta: &AgentTaskMeta) -> Option<String> {
    let count = meta.queued_count.to_string();
    if meta.needs_auth {
        return Some(tr("agentNeedsSignIn"));
    }
    if meta.is_running {
        return Some(if meta.queued_count > 0 {
            t_args("agentRunningQueued", &[("count", &count)])
        } else {
            tr("agentRunning")
        });
    }
    if meta.queued_count > 0 {
        return Some(t_args("agentQueuedCount", &[("count", &count)]));
    }
    if meta.is_error {
        return Some(tr("agentFailed"));
    }
    if meta.is_unavailable {
        return Some(tr("agentSessionUnavailable"));
    }
    None
}

/// `formatTimeAgo`.
pub fn format_time_ago(timestamp: i64, now: i64) -> String {
    let seconds = (now - timestamp).max(0) / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;
    let weeks = days / 7;
    let plural = |n: i64, unit: &str| format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" });
    if seconds < 60 {
        "just now".into()
    } else if minutes < 60 {
        plural(minutes, "minute")
    } else if hours < 24 {
        plural(hours, "hour")
    } else if days < 7 {
        plural(days, "day")
    } else if weeks < 4 {
        plural(weeks, "week")
    } else {
        use chrono::TimeZone as _;
        chrono::Local
            .timestamp_millis_opt(timestamp)
            .single()
            .map(|d| d.format("%-m/%-d/%Y").to_string())
            .unwrap_or_default()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── attention (the task half of utils/attention.ts) ─────────────────────────

/// `taskAttention`: what a session should point the user at, if anything.
/// `last_looked` is the seen ledger's time for the task; `is_widget_round`
/// says a turn is a prompt widget's (its result lands on the document).
pub fn task_attention(
    task: &AgentTaskRow,
    has_pending_permission: bool,
    last_looked: i64,
    is_widget_round: impl Fn(&str) -> bool,
) -> Option<AttentionKind> {
    // A restored session claims nothing until it runs again.
    if task.status == TaskStatus::Restored {
        return None;
    }
    // Asks clear when answered, not when looked at.
    if has_pending_permission || task.auth_required {
        return Some(AttentionKind::Error);
    }
    let errored_without_turn = task.status == TaskStatus::Unavailable
        || (task.status == TaskStatus::Error
            && task.last_settled.as_ref().map(|s| s.status) != Some(TurnStatus::Error));
    if errored_without_turn {
        return (task.updated_at > last_looked).then_some(AttentionKind::Error);
    }
    let settled: &LastSettled = task.last_settled.as_ref()?;
    if is_widget_round(&settled.turn_id) || settled.at <= last_looked {
        return None;
    }
    let working = matches!(task.status, TaskStatus::Running | TaskStatus::Starting);
    if settled.status == TurnStatus::Completed && working {
        return None;
    }
    Some(if settled.status == TurnStatus::Error { AttentionKind::Error } else { AttentionKind::Bau })
}

/// Every task's attention in one pass (`deriveAttention().byTask`).
fn attention_by_task(tasks: &[AgentTaskRow], cx: &App) -> HashMap<String, AttentionKind> {
    let core = cx.core();
    // The app's attention module (`useAttention`), when the root lists it.
    if let Some(attention) = core.try_use::<notefig_attention::AttentionModule>() {
        return attention
            .get()
            .by_task
            .iter()
            .map(|(task, kind)| {
                let kind = match kind {
                    notefig_attention::AttentionKind::Bau => AttentionKind::Bau,
                    notefig_attention::AttentionKind::Error => AttentionKind::Error,
                };
                (task.clone(), kind)
            })
            .collect();
    }
    let store = core.use_::<AgentStoreModule>();
    let seen = core.try_use::<notefig_seen::SeenModule>();
    let rounds: HashSet<String> = core
        .try_use::<notefig_prompt_rounds::PromptRoundsModule>()
        .map(|r| r.collection().values().into_iter().map(|row| row.turn_id).collect())
        .unwrap_or_default();
    tasks
        .iter()
        .filter_map(|task| {
            let pending: Vec<PermissionRequestRow> = store.pending_permissions(&task.task_id);
            let looked = seen
                .as_ref()
                .map(|s| s.last_seen_at(&notefig_seen::SeenTarget::Task(task.task_id.clone())))
                .unwrap_or(i64::MAX);
            task_attention(task, !pending.is_empty(), looked, |turn| rounds.contains(turn))
                .map(|kind| (task.task_id.clone(), kind))
        })
        .collect()
}

// ─── jump-to-task.ts ─────────────────────────────────────────────────────────

/// Where a jump landed (`JumpTarget`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JumpTarget {
    Widget,
    Chat,
}

/// A prompt widget as the jump needs it (`PromptWidgetsApi.findByTask`).
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetLocation {
    pub document_path: String,
    pub blob_id: String,
    pub bound_turn_id: Option<String>,
}

/// What a jump drives (`Jumper`): the tabs, and the prompt widgets' lookup.
pub trait Jumper {
    fn find_widget(&self, task_id: &str, turn_id: Option<&str>) -> Option<WidgetLocation>;
    fn open_agent(&self, task_id: &str);
    /// Focus (opening if need be) the document and scroll the widget into view.
    fn reveal_widget(&self, widget: &WidgetLocation);
    fn open_document(&self, path: &str);
}

/// `jumpToTask`: the prompt widget that raised the round when one is known
/// (it renders the permission and sign-in cards in place), else the chat.
pub fn jump_to_task(jumper: &dyn Jumper, task_id: &str, turn_id: Option<&str>) -> JumpTarget {
    match jumper.find_widget(task_id, turn_id) {
        Some(widget) => {
            jumper.reveal_widget(&widget);
            JumpTarget::Widget
        }
        None => {
            jumper.open_agent(task_id);
            JumpTarget::Chat
        }
    }
}

/// `jumpToRound`: the widget when it is mounted and still bound to the
/// round, else its document.
pub fn jump_to_round(jumper: &dyn Jumper, task_id: &str, turn_id: &str, document_path: &str) {
    match jumper.find_widget(task_id, Some(turn_id)) {
        Some(widget) if widget.bound_turn_id.as_deref() == Some(turn_id) => jumper.reveal_widget(&widget),
        _ => jumper.open_document(document_path),
    }
}

/// The app's [`Jumper`] over the tabs module and the prompt widgets.
pub struct TabsJumper {
    tabs: Rc<notefig_tabs::TabsApi>,
    find: Box<dyn Fn(&str, Option<&str>) -> Option<WidgetLocation>>,
    /// Runs the reveal: `tabs.reveal` is a future (open, mount, scroll).
    executor: Rc<dyn notefig_core::Executor>,
}

impl TabsJumper {
    /// The jumper over `core`'s tabs and prompt widgets.
    pub fn new(core: &notefig_core::Core) -> Self {
        let prompts = core.use_::<notefig_prompt_widgets::PromptWidgetsModule>();
        Self {
            tabs: core.use_::<notefig_tabs::TabsModule>(),
            find: Box::new(move |task, turn| {
                prompts.find_by_task(task, turn).map(|w| WidgetLocation {
                    document_path: w.document_path,
                    blob_id: w.blob_id,
                    bound_turn_id: w.bound_turn_id,
                })
            }),
            executor: core.executor(),
        }
    }
}

impl Jumper for TabsJumper {
    fn find_widget(&self, task_id: &str, turn_id: Option<&str>) -> Option<WidgetLocation> {
        (self.find)(task_id, turn_id)
    }

    fn open_agent(&self, task_id: &str) {
        self.tabs.open_agent(task_id);
    }

    fn reveal_widget(&self, widget: &WidgetLocation) {
        let reveal = self.tabs.reveal(
            &widget.document_path,
            notefig_editors::EditorTarget::Block { block_id: widget.blob_id.clone() },
            notefig_tabs::OpenTabOptions {
                intent: notefig_layout::OpenFileIntent::NewTab,
                move_if_open: true,
                ..Default::default()
            },
        );
        // Spawned, not dropped: the reveal opens the tab, waits for its
        // editor to mount, then scrolls to the widget's block.
        self.executor.spawn(Box::pin(async move {
            reveal.await;
        }));
    }

    fn open_document(&self, path: &str) {
        self.tabs.open(path, notefig_tabs::OpenTabOptions { intent: notefig_layout::OpenFileIntent::Replace, ..Default::default() });
    }
}

// ─── harness selection ───────────────────────────────────────────────────────

/// `useActiveHarnesses`: the pickable harnesses, or every configured one
/// when none is pickable (a first run is never a dead end).
fn active_harnesses(cx: &App) -> Vec<HarnessDefinition> {
    let agents = cx.core().use_::<AgentsModule>();
    let pickable = agents.pickable_harnesses();
    if pickable.is_empty() { agents.configured_harnesses() } else { pickable }
}

/// `useDefaultHarness`: the stored choice if active, else the first.
pub fn pick_default<'a>(active: &'a [HarnessDefinition], stored: Option<&str>) -> Option<&'a HarnessDefinition> {
    active.iter().find(|h| Some(h.id.as_str()) == stored).or_else(|| active.first())
}

fn agent_kv(cx: &App) -> Option<notefig_kv::KvCollection> {
    cx.core().try_use::<notefig_kv::KvModule>().map(|kv| kv.collection(notefig_agents::AGENT_KV_NAMESPACE))
}

// ─── the panel ───────────────────────────────────────────────────────────────

struct ContextMenu {
    task_id: String,
    at: Point<Pixels>,
}

/// `SessionsPanel`.
pub struct SessionsPanel {
    ws: WorkspaceHandle,
    focus: FocusHandle,
    harness_menu: bool,
    context_menu: Option<ContextMenu>,
    /// The pending trust question: what it would start, and where.
    trust: Option<(String, HarnessDefinition)>,
    /// The last opened row, when no tabs module says which is active.
    opened: Option<String>,
    _subs: Vec<notefig_core::Subscription>,
}

impl SessionsPanel {
    pub fn new(ws: WorkspaceHandle, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let store = core.use_::<AgentStoreModule>();
        let s2 = store.clone();
        let mut subs = vec![
            observe(cx, move |notify| store.subscribe(move || notify())),
            observe(cx, move |notify| s2.subscribe_harnesses(move || notify())),
        ];
        if let Some(tabs) = core.try_use::<notefig_tabs::TabsModule>() {
            subs.push(observe(cx, move |notify| tabs.subscribe(move || notify())));
        }
        if let Some(seen) = core.try_use::<notefig_seen::SeenModule>() {
            subs.push(observe(cx, move |notify| seen.subscribe(move || notify())));
        }
        if let Some(attention) = core.try_use::<notefig_attention::AttentionModule>() {
            subs.push(observe(cx, move |notify| attention.subscribe(move || notify())));
        }
        if let Some(kv) = agent_kv(cx) {
            let preload = kv.preload();
            core.executor().spawn(preload);
            subs.push(observe(cx, move |notify| kv.subscribe(move || notify())));
        }
        // "just now" ages: re-render each minute.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self { ws, focus: cx.focus_handle(), harness_menu: false, context_menu: None, trust: None, opened: None, _subs: subs }
    }

    pub fn workspace(&self) -> &WorkspaceHandle {
        &self.ws
    }

    /// `useAgentTaskList`: the workspace's tasks, last activity first.
    pub fn task_list(&self, cx: &App) -> Vec<AgentTaskMeta> {
        let store = cx.core().use_::<AgentStoreModule>();
        store
            .tasks_for_workspace(self.ws.path())
            .into_iter()
            .map(|task| {
                let queued = store.turns(&task.task_id).iter().filter(|t| t.status == TurnStatus::Queued).count();
                task_meta(task, queued)
            })
            .collect()
    }

    fn default_harness(&self, cx: &App) -> Option<HarnessDefinition> {
        let active = active_harnesses(cx);
        let stored = agent_kv(cx).and_then(|kv| kv.get_as::<String>(DEFAULT_HARNESS_KEY));
        pick_default(&active, stored.as_deref()).cloned()
    }

    fn set_default_harness(&self, harness_id: &str, cx: &mut App) {
        if let Some(kv) = cx.core().try_use::<notefig_kv::KvModule>() {
            let write = kv.write(notefig_agents::AGENT_KV_NAMESPACE, DEFAULT_HARNESS_KEY, &harness_id.to_string());
            cx.foreground_executor().spawn(write).detach();
        }
    }

    fn active_tab(&self, cx: &App) -> Option<String> {
        match cx.core().try_use::<notefig_tabs::TabsModule>() {
            Some(tabs) => tabs.active_tab_id(),
            None => self.opened.as_ref().map(|id| notefig_tabs::tab_id::agent_tab_id(id)),
        }
    }

    /// Open (or focus) a session's chat tab.
    pub fn open(&mut self, task_id: &str, cx: &mut Context<Self>) {
        self.opened = Some(task_id.to_string());
        match cx.core().try_use::<notefig_tabs::TabsModule>() {
            Some(tabs) => tabs.open_agent(task_id),
            None => cx.core().use_::<AgentsModule>().task(task_id).open(),
        }
        cx.notify();
    }

    /// `useStartSession().create`: start, asking for trust the first time.
    pub fn create(&mut self, harness: HarnessDefinition, window: &mut Window, cx: &mut Context<Self>) {
        let requested = self.ws.path().to_string();
        let pending = cx.core().use_::<AgentsModule>().workspace(&requested).start(&harness.id);
        cx.spawn_in(window, async move |this, cx| {
            let result = pending.await;
            let _ = this.update(cx, |this, cx| match result {
                StartResult::Started { task_id } => this.open(&task_id, cx),
                // Asked about the workspace on screen, or not at all.
                StartResult::NeedsTrust if this.ws.path() == requested => {
                    this.trust = Some((requested, harness));
                    cx.notify();
                }
                StartResult::NeedsTrust => {}
                StartResult::UnknownHarness => log::warn!("unknown harness {}", harness.id),
            });
        })
        .detach();
    }

    fn confirm_trust(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((ws, harness)) = self.trust.take() else { return };
        cx.core().use_::<AgentsModule>().workspace(&ws).trust();
        if ws == self.ws.path() {
            self.create(harness, window, cx);
        } else {
            let pending = cx.core().use_::<AgentsModule>().workspace(&ws).start(&harness.id);
            cx.foreground_executor().spawn(pending).detach();
        }
        cx.notify();
    }

    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx).clone();
        let muted = t.muted_foreground;
        let Some(default) = self.default_harness(cx) else {
            return div().h(sp(9.)).into_any_element();
        };
        let label: SharedString = t_args("agentNewSessionWith", &[("harness", &default.label)]).into();
        let main_default = default.clone();
        let main = button("new-session", ButtonVariant::Ghost, ButtonSize::Sm, false, cx)
            .h(sp(6.))
            .gap(sp(1.))
            .px(sp(1.5))
            .text_size(t.text_xs)
            .font_weight(FontWeight::NORMAL)
            .text_color(muted)
            .child(icon("plus").size(sp(3.)).text_color(muted))
            .child(harness_logo(&default.id, sp(3.), muted))
            .child(div().truncate().child(default.label.clone()))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
            .on_click(cx.listener(move |this, _, window, cx| this.create(main_default.clone(), window, cx)));
        let choose: SharedString = tr("agentChooseHarness").into();
        let chevron = button("choose-harness", ButtonVariant::Ghost, ButtonSize::Icon, false, cx)
            .h(sp(6.))
            .w(sp(5.))
            .text_color(muted)
            .when(self.harness_menu, |b| b.bg(t.accent))
            .child(icon("chevron-down").size(sp(3.5)).text_color(muted))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(choose.clone()).build(window, cx))
            .on_click(cx.listener(|this, _, _, cx| {
                this.harness_menu = !this.harness_menu;
                cx.notify();
            }));
        let menu = self.harness_menu.then(|| {
            let items = active_harnesses(cx).into_iter().map(|h| {
                let is_default = h.id == default.id;
                let fg = tokens(cx).foreground;
                let pick = h.clone();
                menu_item(SharedString::from(format!("harness-{}", h.id)), false, cx)
                    .child(harness_logo(&h.id, sp(3.5), fg))
                    .child(div().flex_1().child(h.label.clone()))
                    .when(is_default, |d| d.child(icon("check").size(sp(3.5)).text_color(fg)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.harness_menu = false;
                        this.set_default_harness(&pick.id, cx);
                        this.create(pick.clone(), window, cx);
                    }))
            });
            anchored_popover(
                PopoverSide::BelowEnd,
                popover_frame(cx)
                    .id("harness-menu")
                    .min_w(rem(8.))
                    .p(sp(1.))
                    .flex()
                    .flex_col()
                    .children(items.collect::<Vec<_>>())
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                        this.harness_menu = false;
                        cx.notify();
                    })),
            )
        });
        div()
            .flex_none()
            .flex()
            .h(sp(9.))
            .items_center()
            .gap(sp(1.))
            .px(sp(2.))
            .child(div().flex().items_center().child(main).child(div().relative().child(chevron).children(menu)))
            .into_any_element()
    }

    fn render_row(&self, meta: &AgentTaskMeta, attention: Option<AttentionKind>, active: bool, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx).clone();
        let task = &meta.task;
        let group: SharedString = format!("session-row-{}", task.task_id).into();
        let state = attention.map(attention_glyph_state).unwrap_or_else(|| task_glyph_state(task));
        let label = describe_task_meta(meta).unwrap_or_else(|| format_time_ago(task.updated_at, now));
        let (accent, half) = (t.accent, t.accent.opacity(0.5));
        let (muted, fg) = (t.muted_foreground, t.foreground);
        let id = task.task_id.clone();
        let rid = task.task_id.clone();
        let title: SharedString = task.title.clone().into();
        let stop = meta.is_running.then(|| {
            let id = task.task_id.clone();
            let label: SharedString = tr("agentStopSession").into();
            div()
                .id(SharedString::from(format!("stop-{}", task.task_id)))
                .flex_none()
                .rounded(crate::style::radius_default())
                .p(sp(0.5))
                .text_color(muted)
                .cursor_pointer()
                .hover(move |s| s.text_color(fg))
                .invisible()
                .group_hover(group.clone(), |s| s.visible())
                .child(div().size(sp(3.)).rounded(px(1.)).bg(gpui::transparent_black()).child(div().size_full().bg(muted).rounded(px(1.))))
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    let pending = cx.core().use_::<AgentsModule>().task(&id).cancel();
                    cx.foreground_executor().spawn(pending).detach();
                })
        });
        div()
            .id(SharedString::from(format!("session-{}", task.task_id)))
            .group(group.clone())
            .flex()
            .w_full()
            .items_center()
            .gap(sp(2.5))
            .px(sp(2.))
            .py(sp(1.5))
            .text_size(t.text_xs)
            .cursor_pointer()
            .when(active, |d| d.bg(accent))
            .when(!active, |d| d.hover(move |s| s.bg(half)))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .size(sp(3.))
                    .items_center()
                    .justify_center()
                    .child(status_glyph(state, SharedString::from(format!("glyph-{}", task.task_id)), cx)),
            )
            .child(div().min_w_0().flex_1().truncate().when(attention.is_some(), |d| d.font_weight(FontWeight::MEDIUM)).child(title.clone()))
            .child(div().flex_none().text_size(text_11()).text_color(muted.opacity(0.8)).child(label))
            .children(stop)
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(title.clone()).build(window, cx))
            .on_click(cx.listener(move |this, _, _, cx| this.open(&id, cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, e: &gpui::MouseDownEvent, _, cx| {
                    this.context_menu = Some(ContextMenu { task_id: rid.clone(), at: e.position });
                    cx.notify();
                }),
            )
            .into_any_element()
    }

    /// `SessionRowMenu`.
    fn render_context_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.context_menu.as_ref()?;
        let core = cx.core();
        let task = core.use_::<AgentStoreModule>().task(&menu.task_id)?;
        let agents = core.use_::<AgentsModule>();
        let t = tokens(cx).clone();
        let can_refresh = matches!(task.status, TaskStatus::Idle | TaskStatus::Cancelled | TaskStatus::Restored);
        let session_id = task.session_id.clone();
        let supported = agents
            .configured_harnesses()
            .iter()
            .find(|h| h.id == task.harness_id)
            .is_some_and(|h| h.resume_command.is_some());
        let resume = agents.task(&task.task_id).resume_command();
        let item = |id: &str, icon_name: &str, label: String, enabled: bool, destructive: bool, cx: &mut Context<Self>| {
            let color = if destructive { t.destructive } else { t.popover_foreground };
            menu_item(SharedString::from(format!("ctx-{id}")), false, cx)
                .text_color(color)
                .when(!enabled, |d| d.opacity(0.5).cursor_default())
                .child(icon(icon_name).size(sp(4.)).text_color(color))
                .child(label)
        };
        let close = |this: &mut Self, cx: &mut Context<Self>| {
            this.context_menu = None;
            cx.notify();
        };
        let tid = task.task_id.clone();
        let refresh = item("refresh", "refresh-cw", tr("agentRefreshSession"), can_refresh, false, cx).when(can_refresh, |d| {
            let tid = tid.clone();
            d.on_click(cx.listener(move |this, _, _, cx| {
                let pending = cx.core().use_::<AgentsModule>().task(&tid).refresh();
                cx.foreground_executor().spawn(pending).detach();
                close(this, cx);
            }))
        });
        let copy_id = item("copy-id", "copy", tr("agentCopySessionId"), session_id.is_some(), false, cx).when_some(session_id, |d, sid| {
            d.on_click(cx.listener(move |this, _, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(sid.clone()));
                close(this, cx);
            }))
        });
        let copy_resume = supported.then(|| {
            item("resume", "terminal", tr("agentCopyResumeCommand"), resume.is_some(), false, cx).when_some(resume, |d, cmd| {
                d.on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                    close(this, cx);
                }))
            })
        });
        let delete = item("delete", "trash-2", tr("agentDeleteSession"), true, true, cx).on_click(cx.listener(move |this, _, _, cx| {
            let pending = cx.core().use_::<AgentsModule>().task(&tid).delete();
            cx.foreground_executor().spawn(pending).detach();
            close(this, cx);
        }));
        Some(
            deferred(
                anchored().position(menu.at).snap_to_window_with_margin(px(8.)).child(
                    popover_frame(cx)
                        .id("session-context-menu")
                        .min_w(rem(8.))
                        .p(sp(1.))
                        .flex()
                        .flex_col()
                        .child(refresh)
                        .child(copy_id)
                        .children(copy_resume)
                        .child(div().my(sp(1.)).mx(sp(-1.)).child(rule(cx)))
                        .child(delete)
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.context_menu = None;
                            cx.notify();
                        })),
                ),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }

    /// The one-time trust confirmation (`AlertDialog`).
    fn render_trust_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (_, harness) = self.trust.as_ref()?;
        let t = tokens(cx).clone();
        let size = window.viewport_size();
        Some(
            deferred(
                anchored().position(point(px(0.), px(0.))).child(
                    div()
                        .id("trust-overlay")
                        .w(size.width)
                        .h(size.height)
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(gpui::black().opacity(0.8))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .id("trust-dialog")
                                .w_full()
                                .max_w(rem(32.))
                                .flex()
                                .flex_col()
                                .gap(sp(4.))
                                .rounded(t.radius_lg)
                                .border_1()
                                .border_color(t.border)
                                .bg(t.background)
                                .text_color(t.foreground)
                                .p(sp(6.))
                                .shadow_lg()
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(sp(2.))
                                        .child(div().text_size(rem(1.125)).font_weight(FontWeight::SEMIBOLD).child(tr("agentTrustTitle")))
                                        .child(
                                            div()
                                                .text_size(t.text_sm)
                                                .text_color(t.muted_foreground)
                                                .child(t_args("agentTrustDescription", &[("harness", &harness.label)])),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .justify_end()
                                        .gap(sp(2.))
                                        .child(
                                            button("trust-cancel", ButtonVariant::Outline, ButtonSize::Default, false, cx)
                                                .child(tr("cancel"))
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.trust = None;
                                                    cx.notify();
                                                })),
                                        )
                                        .child(
                                            button("trust-confirm", ButtonVariant::Default, ButtonSize::Default, false, cx)
                                                .child(tr("agentTrustConfirm"))
                                                .on_click(cx.listener(|this, _, window, cx| this.confirm_trust(window, cx))),
                                        ),
                                ),
                        ),
                ),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }
}

impl Focusable for SessionsPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SessionsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let metas = self.task_list(cx);
        let tasks: Vec<AgentTaskRow> = metas.iter().map(|m| m.task.clone()).collect();
        let attention = attention_by_task(&tasks, cx);
        let active = self.active_tab(cx);
        let now = now_ms();
        let body: AnyElement = if metas.is_empty() {
            div().p(sp(3.)).text_size(t.text_xs).text_color(t.muted_foreground).child(tr("agentNoSessions")).into_any_element()
        } else {
            let rows: Vec<AnyElement> = metas
                .iter()
                .map(|m| {
                    let is_active = active.as_deref() == Some(notefig_tabs::tab_id::agent_tab_id(&m.task.task_id).as_str());
                    self.render_row(m, attention.get(&m.task.task_id).copied(), is_active, now, cx)
                })
                .collect();
            div().id("sessions-list").flex_1().min_h_0().overflow_y_scroll().py(sp(1.)).children(rows).into_any_element()
        };
        div()
            .id("sessions-panel")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .size_full()
            .text_color(t.foreground)
            .child(self.render_header(cx))
            .child(body)
            .children(self.render_context_menu(cx))
            .children(self.render_trust_dialog(window, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(status: &str) -> AgentTaskRow {
        serde_json::from_value(json!({"taskId": "task_1", "workspacePath": "/ws", "title": "t", "status": status,
            "harnessId": "claude-code", "createdAt": 0, "updatedAt": 100}))
        .unwrap()
    }

    #[test]
    fn meta_labels() {
        assert_eq!(describe_task_meta(&task_meta(row("running"), 0)).as_deref(), Some("running"));
        assert_eq!(describe_task_meta(&task_meta(row("running"), 2)).as_deref(), Some("running · 2 queued"));
        assert_eq!(describe_task_meta(&task_meta(row("idle"), 1)).as_deref(), Some("1 queued"));
        assert_eq!(describe_task_meta(&task_meta(row("error"), 0)).as_deref(), Some("failed"));
        assert_eq!(describe_task_meta(&task_meta(row("unavailable"), 0)).as_deref(), Some("unavailable"));
        assert_eq!(describe_task_meta(&task_meta(row("restored"), 0)), None);
        let mut auth = row("running");
        auth.auth_required = true;
        assert_eq!(describe_task_meta(&task_meta(auth, 0)).as_deref(), Some("needs sign-in"));
    }

    #[test]
    fn time_ago() {
        let now = 10_000_000_000;
        assert_eq!(format_time_ago(now - 5_000, now), "just now");
        assert_eq!(format_time_ago(now - 60_000, now), "1 minute ago");
        assert_eq!(format_time_ago(now - 2 * 3_600_000, now), "2 hours ago");
        assert_eq!(format_time_ago(now - 3 * 86_400_000, now), "3 days ago");
        assert_eq!(format_time_ago(now - 14 * 86_400_000, now), "2 weeks ago");
    }

    #[test]
    fn attention_follows_the_ledger() {
        let mut task = row("idle");
        task.last_settled = Some(LastSettled { turn_id: "trn_1".into(), at: 500, status: TurnStatus::Completed });
        assert_eq!(task_attention(&task, false, 0, |_| false), Some(AttentionKind::Bau));
        // Looked at since: clear.
        assert_eq!(task_attention(&task, false, 600, |_| false), None);
        // A widget round lands on its document.
        assert_eq!(task_attention(&task, false, 0, |t| t == "trn_1"), None);
        // An ask outranks being seen.
        assert_eq!(task_attention(&task, true, 600, |_| false), Some(AttentionKind::Error));
        // A finished turn on a session that moved on is not news.
        task.status = TaskStatus::Running;
        assert_eq!(task_attention(&task, false, 0, |_| false), None);
        // A failed turn is.
        task.last_settled.as_mut().unwrap().status = TurnStatus::Error;
        assert_eq!(task_attention(&task, false, 0, |_| false), Some(AttentionKind::Error));
    }

    #[test]
    fn restored_and_errors_without_turns() {
        let mut task = row("restored");
        task.auth_required = true;
        assert_eq!(task_attention(&task, true, 0, |_| false), None);
        let failed = row("error");
        assert_eq!(task_attention(&failed, false, 50, |_| false), Some(AttentionKind::Error));
        assert_eq!(task_attention(&failed, false, 150, |_| false), None);
    }

    #[test]
    fn default_harness_prefers_the_stored_one() {
        let h = |id: &str| HarnessDefinition { id: id.into(), label: id.into(), ..serde_json::from_value(json!({"id": id, "label": id, "command": "x", "mcpRegistration": "session-new"})).unwrap() };
        let active = vec![h("claude-code"), h("opencode")];
        assert_eq!(pick_default(&active, Some("opencode")).map(|h| h.id.as_str()), Some("opencode"));
        assert_eq!(pick_default(&active, Some("gone")).map(|h| h.id.as_str()), Some("claude-code"));
        assert_eq!(pick_default(&[], None), None);
    }

    struct FakeJumper {
        widget: Option<WidgetLocation>,
        log: std::cell::RefCell<Vec<String>>,
    }

    impl Jumper for FakeJumper {
        fn find_widget(&self, _: &str, _: Option<&str>) -> Option<WidgetLocation> {
            self.widget.clone()
        }
        fn open_agent(&self, task_id: &str) {
            self.log.borrow_mut().push(format!("agent:{task_id}"));
        }
        fn reveal_widget(&self, w: &WidgetLocation) {
            self.log.borrow_mut().push(format!("reveal:{}#{}", w.document_path, w.blob_id));
        }
        fn open_document(&self, path: &str) {
            self.log.borrow_mut().push(format!("open:{path}"));
        }
    }

    #[test]
    fn jumps_to_the_widget_else_the_chat() {
        let widget = WidgetLocation { document_path: "/ws/a.md".into(), blob_id: "b1".into(), bound_turn_id: Some("trn_1".into()) };
        let with = FakeJumper { widget: Some(widget), log: Default::default() };
        assert_eq!(jump_to_task(&with, "task_1", None), JumpTarget::Widget);
        let without = FakeJumper { widget: None, log: Default::default() };
        assert_eq!(jump_to_task(&without, "task_1", None), JumpTarget::Chat);
        assert_eq!(without.log.borrow().as_slice(), ["agent:task_1"]);
        // A round: the widget only while still bound to it.
        jump_to_round(&with, "task_1", "trn_2", "/ws/a.md");
        jump_to_round(&with, "task_1", "trn_1", "/ws/a.md");
        assert_eq!(with.log.borrow().as_slice(), ["reveal:/ws/a.md#b1", "open:/ws/a.md", "reveal:/ws/a.md#b1"]);
    }
}
