//! `CheckpointPanel`: the sidebar's Git tab — the commit controls, the
//! status chip, the revert banner and the checkpoint list.

use std::rc::Rc;

use gpui::{
    AppContext as _, App, ClipboardItem, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Disableable as _, Sizable as _};
use notefig_core::WorkspaceHandle;
use notefig_git::{GitModule, WorkspaceGit, derive_sync_state};
use notefig_history::HistoryError;
use notefig_i18n::t as tr;
use notefig_ui::{IconButton, icon, rem, sp, tokens};

use crate::state::{
    ActionKind, CheckpointItem, PanelState, RecoveryAction, checkpoint_items, derive_can_save, derive_panel_state,
    distance_to_now, error_presentation, list_actions, list_message, revert_actions, sync_state_presentation,
    visible_panel_error,
};

/// `text-[0.6875rem]`.
fn text_11() -> gpui::Pixels {
    rem(0.6875)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The Git tab. `GitPanel::new(ws, window, cx)` inside `cx.new`.
pub struct GitPanel {
    ws: WorkspaceHandle,
    git: Option<Rc<WorkspaceGit>>,
    _git_sub: Option<notefig_core::Subscription>,
    focus: FocusHandle,
    /// `useStablePanelState`: held while a background fetch runs.
    stable_state: Option<PanelState>,
    /// The save in flight, with its description (`saveCheckpoint.variables`).
    saving: Option<String>,
    initializing: bool,
    initialize_error: Option<HistoryError>,
    /// `activeRevertId`.
    reverting: Option<String>,
    revert_error: Option<HistoryError>,
    aborting: bool,
    /// The (disabled) auto-save switch, as TS keeps it.
    auto_save: bool,
    describe_open: bool,
    description: Entity<TextareaState>,
}

impl GitPanel {
    pub fn new(ws: WorkspaceHandle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let description = cx.new(|cx| TextareaState::new(window, cx).placeholder(tr("checkpointDescriptionPlaceholder")));
        let mut this = Self {
            ws,
            git: None,
            _git_sub: None,
            focus: cx.focus_handle(),
            stable_state: None,
            saving: None,
            initializing: false,
            initialize_error: None,
            reverting: None,
            revert_error: None,
            aborting: false,
            auto_save: false,
            describe_open: false,
            description,
        };
        this.attach(cx);
        this
    }

    /// Bind to the workspace's git, once it is open.
    fn attach(&mut self, cx: &mut Context<Self>) {
        if self.git.is_some() {
            return;
        }
        let Ok(git) = self.ws.get::<GitModule>() else { return };
        let watched = git.clone();
        self._git_sub = Some(notefig_ui::observe(cx, move |notify| watched.subscribe(move || notify())));
        self.git = Some(git);
    }

    /// The workspace's git, read when an action runs.
    fn workspace_git(&self) -> Option<Rc<WorkspaceGit>> {
        self.git.clone()
    }

    fn save(&mut self, description: Option<String>, cx: &mut Context<Self>) {
        let Some(git) = self.workspace_git() else { return };
        self.saving = Some(description.clone().unwrap_or_default());
        let fut = git.save_checkpoint(description.as_deref());
        cx.spawn(async move |this, cx| {
            let result = fut.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = None;
                if let Err(err) = result {
                    // TS keeps the mutation's error unread; log it.
                    log::warn!("[git] commit failed: {err}");
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn save_quick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save(None, cx);
        self.clear_description(window, cx);
        self.describe_open = false;
    }

    fn save_with_description(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.description.read(cx).value().to_string();
        self.save(if text.trim().is_empty() { None } else { Some(text) }, cx);
        self.clear_description(window, cx);
        self.describe_open = false;
    }

    fn clear_description(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.description.update(cx, |d, cx| d.set_value("", window, cx));
    }

    fn initialize(&mut self, cx: &mut Context<Self>) {
        let Some(git) = self.workspace_git() else { return };
        self.initializing = true;
        self.initialize_error = None;
        let fut = git.initialize();
        cx.spawn(async move |this, cx| {
            let result = fut.await;
            let _ = this.update(cx, |this, cx| {
                this.initializing = false;
                this.initialize_error = result.err();
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        if let Some(git) = self.workspace_git() {
            cx.foreground_executor().spawn(git.refetch()).detach();
        }
    }

    fn revert(&mut self, item: &CheckpointItem, cx: &mut Context<Self>) {
        let Some(git) = self.workspace_git() else { return };
        self.revert_error = None;
        self.reverting = Some(item.id.clone());
        let fut = git.revert_to(&item.id, &item.hash);
        cx.spawn(async move |this, cx| {
            let result = fut.await;
            let _ = this.update(cx, |this, cx| {
                this.reverting = None;
                this.revert_error = result.err();
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn abort_revert(&mut self, cx: &mut Context<Self>) {
        let Some(git) = self.workspace_git() else { return };
        self.aborting = true;
        let fut = git.abort_revert();
        cx.spawn(async move |this, cx| {
            let result = fut.await;
            let _ = this.update(cx, |this, cx| {
                this.aborting = false;
                if result.is_ok() {
                    this.revert_error = None;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn run_action(&mut self, kind: ActionKind, cx: &mut Context<Self>) {
        match kind {
            ActionKind::Initialize | ActionKind::Repair => self.initialize(cx),
            ActionKind::Retry => self.retry(cx),
            ActionKind::Save => self.save(None, cx),
            ActionKind::Abort => self.abort_revert(cx),
            ActionKind::Dismiss => {
                self.revert_error = None;
                cx.notify();
            }
        }
    }

    // ─── rendering ──────────────────────────────────────────────────────

    /// A `variant="outline" size="sm"` button at `h-6 text-[0.6875rem]`,
    /// tinted destructive in an error state.
    fn action_button(&self, action: &RecoveryAction, destructive: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        let (fg, border, hover) = if destructive {
            (t.destructive, t.destructive.opacity(0.3), t.destructive.opacity(0.1))
        } else {
            (t.foreground, t.border, t.accent)
        };
        let kind = action.kind;
        div()
            .id(SharedString::from(format!("git-action-{kind:?}")))
            .flex()
            .items_center()
            .justify_center()
            .h(sp(6.))
            .px(sp(3.))
            .rounded(t.radius_md)
            .border_1()
            .border_color(border)
            .bg(t.background)
            .shadow_xs()
            .text_size(text_11())
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .whitespace_nowrap()
            .child(action.label.clone())
            .when(action.disabled, |d| d.opacity(0.5))
            .when(!action.disabled, |d| {
                d.cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |this, _, _, cx| this.run_action(kind, cx)))
            })
    }

    fn render_toolbar(&self, can_save: bool, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let saving = self.saving.is_some();
        let sync = derive_sync_state(self.git.as_ref().and_then(|g| g.summary()).as_ref());
        let (sync_label, sync_icon) = sync_state_presentation(sync);
        let save_disabled = saving || !can_save;
        let label = if saving { tr("checkpointSaving") } else { tr("saveCheckpoint") };

        let save_button = div()
            .id("git-save")
            .flex()
            .items_center()
            .h(sp(6.))
            .gap(sp(1.))
            .px(sp(1.5))
            .rounded(t.radius_md)
            .text_size(t.text_xs)
            .font_weight(FontWeight::MEDIUM)
            .text_color(t.muted_foreground)
            .child(icon("git-commit-horizontal").size(sp(3.5)).text_color(t.muted_foreground))
            .child(div().truncate().child(label))
            .when(save_disabled, |d| d.opacity(0.5))
            .when(!save_disabled, |d| {
                let (hover, fg) = (t.accent, t.accent_foreground);
                d.cursor_pointer()
                    .hover(move |s| s.bg(hover).text_color(fg))
                    .on_click(cx.listener(|this, _, window, cx| this.save_quick(window, cx)))
            });

        let panel = cx.entity();
        let description = self.description.clone();
        let can_commit = !saving && can_save;
        let auto_save = self.auto_save;
        let chevron = Button::new("git-describe")
            .ghost()
            .w(sp(6.))
            .h(sp(6.))
            .text_color(t.muted_foreground)
            .disabled(saving)
            .child(icon("chevron-down").size(sp(3.5)).text_color(t.muted_foreground))
            .tooltip(tr("saveCheckpointWithDescription"));
        // The popover (`PopoverContent side="bottom" align="start" w-80`),
        // drawn deferred under the chevron: the kit Popover's content takes
        // no pointer input in this window setup.
        let chevron = chevron.on_click(cx.listener(|this, _, window, cx| {
            this.describe_open = !this.describe_open;
            if this.describe_open {
                this.description.update(cx, |d, cx| d.focus(window, cx));
            }
            cx.notify();
        }));
        let open = self.describe_open;
        let describe_panel = {
            let cx: &mut App = cx;
            let content = {
                let t = tokens(cx).clone();
                let save_panel = panel.clone();
                let switch_panel = panel.clone();
                div()
                    .w(sp(80.))
                    .flex()
                    .flex_col()
                    .gap(sp(3.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(sp(1.5))
                            .child(
                                div()
                                    .text_size(t.text_sm)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(tr("saveCheckpointWithDescription")),
                            )
                            .child(
                                div()
                                    .text_size(t.text_xs)
                                    .text_color(t.muted_foreground)
                                    .child(tr("checkpointDescriptionHint")),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(sp(2.))
                            .child(div().min_h(rem(5.25)).text_size(t.text_sm).child(Textarea::new(&description).h(rem(5.25))))
                            .child(
                                div().flex().justify_end().child(
                                    Button::new("git-describe-save")
                                        .primary()
                                        .small()
                                        .h(sp(8.))
                                        .text_size(t.text_xs)
                                        .label(tr("saveCheckpoint"))
                                        .disabled(!can_commit)
                                        .on_click(move |_, window, cx| {
                                            save_panel.update(cx, |this, cx| this.save_with_description(window, cx))
                                        }),
                                ),
                            ),
                    )
                    .child(div().my(sp(1.)).h(gpui::px(1.)).bg(t.border))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(sp(3.))
                            .child(
                                div()
                                    .child(div().text_size(t.text_xs).font_weight(FontWeight::MEDIUM).child(tr("autoSaveCheckpoints")))
                                    .child(div().text_size(text_11()).text_color(t.muted_foreground).child(tr("autoSaveCheckpointsHint"))),
                            )
                            .child(
                                // Disabled in TS too: auto-save is not built.
                                Switch::new("git-autosave").checked(auto_save).disabled(true).on_click(move |on, _, cx| {
                                    switch_panel.update(cx, |this, cx| {
                                        this.auto_save = *on;
                                        cx.notify();
                                    })
                                }),
                            ),
                    )
            };
            let t = tokens(cx).clone();
            let close = panel.clone();
            div()
                .id("git-describe-popover")
                .occlude()
                .rounded(t.radius_md)
                .border_1()
                .border_color(t.border)
                .bg(t.popover)
                .text_color(t.popover_foreground)
                .shadow_md()
                .p(sp(4.))
                .on_mouse_down_out(move |_, _, cx| {
                    close.update(cx, |this, cx| {
                        if this.describe_open {
                            this.describe_open = false;
                            cx.notify();
                        }
                    })
                })
                .child(content)
        };
        let describe = div().relative().child(chevron).when(open, |d| {
            d.child(gpui::deferred(div().absolute().top_full().left_0().mt(sp(1.)).child(describe_panel)).with_priority(1))
        });
        let _ = window;

        let chip = div()
            .flex()
            .flex_none()
            .items_center()
            .h(sp(6.))
            .max_w(sp(24.))
            .min_w_0()
            .gap(sp(1.))
            .overflow_hidden()
            .rounded(t.radius_md)
            .border_1()
            .border_color(t.border)
            .px(sp(1.5))
            .text_size(text_11())
            .text_color(t.foreground)
            .child(icon(sync_icon).size(sp(3.5)).text_color(t.foreground))
            .child(div().min_w_0().truncate().child(sync_label));

        div()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .h(sp(9.))
            .gap(sp(1.))
            .px(sp(2.))
            .child(div().flex().items_center().child(save_button).child(describe))
            .child(chip)
    }

    fn render_banner(&self, error: &HistoryError, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let (title, message) = error_presentation(error);
        let actions = revert_actions(Some(error), self.aborting);
        div()
            .w_full()
            .bg(t.destructive.opacity(0.1))
            .px(sp(3.))
            .py(sp(2.))
            .child(div().text_size(t.text_xs).font_weight(FontWeight::SEMIBOLD).text_color(t.destructive).child(title))
            .child(div().mt(sp(0.5)).text_size(t.text_xs).text_color(t.destructive.opacity(0.8)).child(message))
            .child(
                div()
                    .mt(sp(2.))
                    .flex()
                    .gap(sp(2.))
                    .children(actions.iter().map(|a| self.action_button(a, true, cx).into_any_element())),
            )
    }

    fn render_list(
        &self,
        state: PanelState,
        items: &[CheckpointItem],
        actions: &[RecoveryAction],
        message: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let t = tokens(cx).clone();
        let is_error = state == PanelState::Error;
        if matches!(state, PanelState::Uninitialized | PanelState::Empty) || is_error {
            return div()
                .flex()
                .flex_1()
                .items_center()
                .justify_center()
                .p(sp(8.))
                .child(
                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .gap(sp(3.))
                        .items_center()
                        .text_center()
                        .child(
                            div()
                                .w_full()
                                .whitespace_normal()
                                .text_size(t.text_sm)
                                .text_color(if is_error { t.destructive } else { t.muted_foreground })
                                .children(message),
                        )
                        .when(!actions.is_empty(), |d| {
                            d.child(
                                div()
                                    .flex()
                                    .justify_center()
                                    .gap(sp(2.))
                                    .children(actions.iter().map(|a| self.action_button(a, is_error, cx).into_any_element())),
                            )
                        }),
                )
                .into_any_element();
        }

        let reverting = self.reverting.is_some();
        let now = now_ms();
        let hover_bg: Hsla = t.muted.opacity(0.5);
        div()
            .id("git-checkpoints")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(div().flex().flex_col().children(items.iter().enumerate().map(|(index, item)| {
                let disabled = index == 0
                    || item.is_pending()
                    || reverting
                    || self.reverting.as_deref() == Some(item.id.as_str());
                let hash = item.hash.clone();
                let restore = item.clone();
                let title: gpui::AnyElement = if item.message.is_empty() {
                    div()
                        .truncate()
                        .text_size(text_11())
                        .text_color(t.muted_foreground)
                        .child(distance_to_now(item.timestamp, now))
                        .into_any_element()
                } else {
                    div()
                        .truncate()
                        .text_size(text_11())
                        .font_weight(FontWeight::MEDIUM)
                        .child(item.message.clone())
                        .into_any_element()
                };
                div()
                    .id(SharedString::from(format!("cp-{}", item.id)))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(sp(2.))
                    .py(sp(1.5))
                    .pl(sp(4.))
                    .pr(sp(1.))
                    .hover(move |s| s.bg(hover_bg))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(sp(1.5))
                                    .child(title)
                                    .when(index == 0, |d| {
                                        d.child(
                                            div()
                                                .flex_none()
                                                .flex()
                                                .items_center()
                                                .h(sp(4.))
                                                .max_w(sp(16.))
                                                .px(sp(1.5))
                                                .rounded(t.radius_md)
                                                .bg(t.secondary)
                                                .text_size(t.text_2xs)
                                                .text_color(t.secondary_foreground)
                                                .whitespace_nowrap()
                                                .child(tr("latest")),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .mt(sp(0.5))
                                    .flex()
                                    .items_center()
                                    .gap(sp(1.))
                                    .text_size(t.text_2xs)
                                    .text_color(t.muted_foreground)
                                    .child({
                                        let fg = t.foreground;
                                        div()
                                            .id(SharedString::from(format!("cp-hash-{}", item.id)))
                                            .font_family(notefig_ui::theme::FONT_MONO)
                                            .cursor_pointer()
                                            .hover(move |s| s.text_color(fg))
                                            .tooltip(|w, cx| Tooltip::new(tr("copyCommitHash")).build(w, cx))
                                            .on_click(move |_, _, cx: &mut App| {
                                                cx.write_to_clipboard(ClipboardItem::new_string(hash.clone()))
                                            })
                                            .child(item.hash.clone())
                                    }),
                            ),
                    )
                    .child(
                        div().flex().items_center().gap(sp(0.5)).child(
                            IconButton::new(SharedString::from(format!("cp-restore-{}", item.id)), "undo-2")
                                .disabled(disabled)
                                .tooltip(tr("restoreCheckpoint"))
                                .on_click({
                                    let panel = cx.entity();
                                    move |_, _, cx| panel.update(cx, |this, cx| this.revert(&restore, cx))
                                }),
                        ),
                    )
                    .into_any_element()
            })))
            .into_any_element()
    }
}

impl Focusable for GitPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for GitPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.attach(cx);
        let summary = self.git.as_ref().and_then(|g| g.summary());
        let rows = self.git.as_ref().map(|g| g.checkpoints()).unwrap_or_default();
        let fetching = self.git.as_ref().is_some_and(|g| g.is_fetching());
        let items = checkpoint_items(&rows, self.saving.as_deref(), now_ms());

        let panel_state = derive_panel_state(summary.as_ref(), self.initialize_error.as_ref(), &items);
        if self.stable_state.is_none() || !fetching {
            self.stable_state = Some(panel_state);
        }
        let state = self.stable_state.unwrap_or(panel_state);
        let panel_error = visible_panel_error(state, summary.as_ref(), self.initialize_error.as_ref());
        let can_save = derive_can_save(state, summary.as_ref());
        let actions = list_actions(state, panel_error.as_ref(), can_save, self.saving.is_some());
        let message = list_message(state, panel_error.as_ref());

        let t = tokens(cx).clone();
        // `WorkspaceErrorBoundary` (desktop): a lost folder replaces the panel.
        if let Some(_lost) = self.git.as_ref().and_then(|g| g.access_error()) {
            let retry = RecoveryAction { kind: ActionKind::Retry, label: tr("retry"), disabled: false };
            return div()
                .track_focus(&self.focus)
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .p(sp(8.))
                .child(
                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(sp(3.))
                        .text_center()
                        .child(div().text_size(rem(1.125)).font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(tr("fsAccessLostTitle")))
                        .child(div().w_full().whitespace_normal().text_size(t.text_sm).text_color(t.muted_foreground).child(tr("fsAccessLostBodyDesktop")))
                        .child(self.action_button(&retry, false, cx)),
                )
                .into_any_element();
        }
        let toolbar = self.render_toolbar(can_save, window, cx).into_any_element();
        let banner = self.revert_error.clone().map(|e| self.render_banner(&e, cx).into_any_element());
        let list = self.render_list(state, &items, &actions, message, cx);
        div()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .size_full()
            .text_color(t.foreground)
            .child(toolbar)
            .children(banner)
            .child(list)
            .into_any_element()
    }
}
