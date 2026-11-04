//! The Sessions sidebar view (`sessions-panel.tsx`): the workspace's tasks
//! by `updatedAt` with live status glyphs, and the `+` harness picker
//! behind the workspace trust gate.

use gpui::{
    App, AsyncWindowContext, Context, Entity, EventEmitter, InteractiveElement, IntoElement,
    ParentElement, PromptLevel, Render, SharedString, StatefulInteractiveElement as _, Styled,
    Subscription, Task, WeakEntity, Window, div, prelude::FluentBuilder as _,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, IconName, Sizable as _, h_flex, v_flex};
use notefig_agent::StartResult;

use super::{Agents, ago, glyph};

pub enum SessionsEvent {
    Open(String),
}

pub struct SessionsPanel {
    agents: Entity<Agents>,
    workspace: String,
    pub active: Option<String>,
    _sub: Subscription,
}

impl EventEmitter<SessionsEvent> for SessionsPanel {}

/// Start a session with `harness`, asking to trust the workspace first when
/// it is the first one there. Resolves to the new task id.
pub fn start_session(
    agents: Entity<Agents>,
    workspace: String,
    harness: String,
    window: &mut Window,
    cx: &mut App,
) -> Task<Option<String>> {
    window.spawn(cx, async move |cx: &mut AsyncWindowContext| {
        let handle = cx.update(|_, cx| agents.read(cx).handle.clone()).ok()?;
        match handle.start_task(&workspace, &harness).recv().await? {
            StartResult::Started { task_id } => Some(task_id),
            StartResult::NeedsTrust => {
                let answer = cx
                    .update(|window, cx| {
                        window.prompt(
                            PromptLevel::Warning,
                            "Let agents work in this folder?",
                            Some(
                                "Agents can read and change files in this workspace and run commands. Only continue if you trust its contents.",
                            ),
                            &["Trust and Continue", "Cancel"],
                            cx,
                        )
                    })
                    .ok()?;
                if answer.await.ok()? != 0 {
                    return None;
                }
                handle.trust(&workspace);
                match handle.start_task(&workspace, &harness).recv().await? {
                    StartResult::Started { task_id } => Some(task_id),
                    _ => None,
                }
            }
            StartResult::UnknownHarness => {
                log::warn!("unknown harness {harness}");
                None
            }
        }
    })
}

impl SessionsPanel {
    pub fn new(agents: Entity<Agents>, workspace: String, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(&agents, |_, _, cx| cx.notify());
        Self {
            agents,
            workspace,
            active: None,
            _sub: sub,
        }
    }

    /// The harness the `+` button starts: the most recently used one in this
    /// workspace that is still pickable, else the first pickable.
    pub fn default_harness(&self, cx: &App) -> Option<String> {
        self.agents.read(cx).default_harness(&self.workspace)
    }

    pub fn start(&mut self, harness: String, window: &mut Window, cx: &mut Context<Self>) {
        let task = start_session(self.agents.clone(), self.workspace.clone(), harness, window, cx);
        cx.spawn(async move |this: WeakEntity<Self>, cx| {
            if let Some(task_id) = task.await {
                let _ = this.update(cx, |_, cx| cx.emit(SessionsEvent::Open(task_id)));
            }
        })
        .detach();
    }
}

impl Render for SessionsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let handle = self.agents.read(cx).handle.clone();
        let mut tasks = handle.tasks_for_workspace(&self.workspace);
        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let pickable = handle.pickable_harnesses();
        let default = self.default_harness(cx);
        let default_label = default
            .as_ref()
            .map(|h| handle.harness_label(h))
            .unwrap_or_else(|| "No agent found".into());
        let weak = cx.entity().downgrade();
        let picker_items: Vec<(String, String)> = pickable.iter().map(|h| (h.id.clone(), h.label.clone())).collect();
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .px_2()
                    .pb_2()
                    .gap_0p5()
                    .child(
                        Button::new("session-new")
                            .icon(IconName::Plus)
                            .label(format!("New {default_label} session"))
                            .small()
                            .outline()
                            .disabled(default.is_none())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(h) = this.default_harness(cx) {
                                    this.start(h, window, cx);
                                }
                            })),
                    )
                    .child(
                        Button::new("session-pick")
                            .icon(IconName::ChevronDown)
                            .small()
                            .ghost()
                            .disabled(picker_items.is_empty())
                            .dropdown_menu(move |mut menu, _, _| {
                                for (id, label) in &picker_items {
                                    let (weak, id) = (weak.clone(), id.clone());
                                    menu = menu.item(PopupMenuItem::new(label.clone()).on_click(move |_, window, cx| {
                                        let id = id.clone();
                                        let _ = weak.update(cx, |this, cx| this.start(id, window, cx));
                                    }));
                                }
                                menu
                            }),
                    ),
            )
            .when(tasks.is_empty(), |this| {
                this.child(
                    div()
                        .px_3()
                        .py_2()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(if pickable.is_empty() {
                            "No agent harness was found. Install Claude Code or another ACP agent, then rescan in Settings."
                        } else {
                            "No sessions yet."
                        }),
                )
            })
            .child(
                v_flex()
                    .id("sessions-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_1()
                    .children(tasks.into_iter().map(|row| {
                        let pending = !handle.pending_permissions(&row.task_id).is_empty();
                        let g = glyph::glyph_for(&row, pending);
                        let is_active = self.active.as_deref() == Some(row.task_id.as_str());
                        let id = row.task_id.clone();
                        let title: SharedString = if row.title.trim().is_empty() {
                            handle.harness_label(&row.harness_id).into()
                        } else {
                            row.title.clone().into()
                        };
                        h_flex()
                            .id(SharedString::from(format!("session-{}", row.task_id)))
                            .px_2()
                            .py_1()
                            .gap_2()
                            .rounded_md()
                            .text_sm()
                            .cursor_pointer()
                            .when(is_active, |this| this.bg(theme.sidebar_accent))
                            .hover(|this| this.bg(theme.list_hover))
                            .child(glyph::render(g, format!("glyph-{}", row.task_id), cx))
                            .child(div().flex_1().truncate().child(title))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(ago(row.updated_at)),
                            )
                            .on_click(cx.listener(move |_, _, _, cx| cx.emit(SessionsEvent::Open(id.clone()))))
                    })),
            )
    }
}
