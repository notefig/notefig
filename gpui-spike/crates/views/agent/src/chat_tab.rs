//! `agent-chat-tab.tsx` (`AgentChatTab`, `AgentChatTabBody`,
//! `ComposerOverlay`) and `agent-tab-controller.ts`: one agent session as a
//! tab. The transcript ([`Transcript`]) fills it; the floating composer
//! overlay is pinned to the bottom (the working shimmer, the permission and
//! auth cards, then the prompt box or the unavailable notice), and the
//! transcript pads its scroll end by the overlay's live height.
//!
//! The tab is pinned to one task. A restored session revives when its tab
//! is shown (session/load streams the history back); while it loads the
//! composer is disabled. Closing the tab never cancels the session.
//!
//! Tab controller (`agent-tab-controller.ts`): registered with the tabs
//! module while the view lives, it focuses the composer (or parks focus on
//! the tab's root while the composer declines). Deviations: the TS
//! "don't yank focus out of a text entry elsewhere" check has no DOM to ask
//! here, so an ambient intent always lands; `selected_text` is not
//! reported (GPUI's markdown selection is not readable from outside);
//! find-in-transcript is unimplemented in TS too (MET-152).

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Pixels, Render, SharedString, Styled, Window, canvas, div, linear_color_stop, linear_gradient,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::shimmer::ShimmerText;
use notefig_agent::model::{AgentTaskRow, TaskStatus};
use notefig_agents::{AgentStoreModule, AgentsModule};
use notefig_core::WorkspaceHandle;
use notefig_i18n::t as tr;
use notefig_tabs::{FocusTiming, TabController, TabsModule};
use notefig_ui::{CoreExt as _, observe, sp, tokens};

use crate::cards::{AuthCard, permission_card, unavailable_card};
use crate::composer::{Composer, ComposerDrafts, ComposerEvent, prompt_to_send};
use crate::transcript::Transcript;

pub fn init(_: &mut App) {}

/// `AgentChatTab`: one session's chat.
pub struct ChatTab {
    ws: WorkspaceHandle,
    task_id: String,
    transcript: Entity<Transcript>,
    composer: Option<Entity<Composer>>,
    auth: Entity<AuthCard>,
    focus: FocusHandle,
    /// The status last seen, to revive on each move into `restored`.
    last_status: Option<TaskStatus>,
    was_loading: bool,
    /// The overlay's height as last painted.
    overlay_height: Rc<Cell<Pixels>>,
    controller: Option<ControllerRegistration>,
    can_focus: Rc<Cell<bool>>,
    _subs: Vec<notefig_core::Subscription>,
    _gpui: Vec<gpui::Subscription>,
}

impl ChatTab {
    pub fn new(ws: WorkspaceHandle, task_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let workspace_path = ws.path().to_string();
        let transcript = cx.new(|cx| Transcript::new(task_id.clone(), workspace_path, cx));
        let auth = cx.new(|_| AuthCard::new(task_id.clone(), false));
        let store = cx.core().use_::<AgentStoreModule>();
        let id = task_id.clone();
        let sub = observe(cx, move |notify| store.subscribe_task(&id, move || notify()));
        // Re-derive on every task change (the observe above notifies us).
        let mut this = Self {
            ws,
            task_id,
            transcript,
            composer: None,
            auth,
            focus: cx.focus_handle(),
            last_status: None,
            was_loading: true,
            overlay_height: Rc::new(Cell::new(px(0.))),
            controller: None,
            can_focus: Rc::new(Cell::new(false)),
            _subs: vec![sub],
            _gpui: Vec::new(),
        };
        this.register_controller(window, cx);
        this.sync(window, cx);
        this
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn workspace(&self) -> &WorkspaceHandle {
        &self.ws
    }

    /// The tab's title: the task's title.
    pub fn title(&self, cx: &App) -> SharedString {
        cx.core()
            .use_::<AgentStoreModule>()
            .task(&self.task_id)
            .map(|r| r.title)
            .unwrap_or_default()
            .into()
    }

    pub fn composer(&self) -> Option<&Entity<Composer>> {
        self.composer.as_ref()
    }

    pub fn transcript(&self) -> &Entity<Transcript> {
        &self.transcript
    }

    fn row(&self, cx: &App) -> Option<AgentTaskRow> {
        cx.core().use_::<AgentStoreModule>().task(&self.task_id)
    }

    /// `isLoadingSession`: restored and waiting for its revive, or reviving
    /// (starting with a session id; a brand-new task has none yet).
    pub fn is_loading(row: &AgentTaskRow) -> bool {
        row.status == TaskStatus::Restored || (row.status == TaskStatus::Starting && row.session_id.is_some())
    }

    /// Follow the row: revive a restored session, build the composer once
    /// the row is known, keep its state current, focus it when loaded.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.row(cx) else {
            self.can_focus.set(false);
            return;
        };
        if row.status == TaskStatus::Restored && self.last_status != Some(TaskStatus::Restored) {
            cx.core().use_::<AgentsModule>().task(&self.task_id).revive();
        }
        self.last_status = Some(row.status);
        if self.composer.is_none() {
            let (task, ws, harness) = (self.task_id.clone(), row.workspace_path.clone(), row.harness_id.clone());
            let composer = cx.new(|cx| Composer::new(task, ws, harness, window, cx));
            self._gpui.push(cx.subscribe_in(&composer, window, Self::on_composer_event));
            self.composer = Some(composer);
        }
        let loading = Self::is_loading(&row);
        let running = row.status == TaskStatus::Running;
        if let Some(composer) = &self.composer {
            composer.update(cx, |c, cx| c.set_state(running, loading, cx));
        }
        self.can_focus.set(!loading && row.status != TaskStatus::Unavailable);
        if self.was_loading && !loading {
            // Re-fired when the session finishes loading: a disabled
            // composer declines focus.
            self.request_focus(window, cx);
        }
        self.was_loading = loading;
    }

    fn request_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let tab_id = notefig_tabs::tab_id::agent_tab_id(&self.task_id);
        match cx.core().try_use::<TabsModule>() {
            Some(tabs) => {
                tabs.controllers().request_focus(&tab_id, FocusTiming::WhenMounted, false);
            }
            None => {
                self.focus_composer(window, cx);
            }
        }
    }

    /// The controller's focus: the composer, else park on the root.
    fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if let Some(composer) = &self.composer
            && composer.update(cx, |c, cx| c.focus(window, cx))
        {
            return true;
        }
        window.focus(&self.focus, cx);
        false
    }

    fn register_controller(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tabs) = cx.core().try_use::<TabsModule>() else { return };
        let (tx, rx) = async_channel::unbounded::<()>();
        let tab_id = notefig_tabs::tab_id::agent_tab_id(&self.task_id);
        let controller = Rc::new(ChatTabController { tab_id: tab_id.clone(), focus: tx, can_focus: self.can_focus.clone() });
        tabs.controllers().register(controller);
        cx.spawn_in(window, async move |this, cx| {
            while rx.recv().await.is_ok() {
                if this.update_in(cx, |this, window, cx| this.focus_composer(window, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        self.controller = Some(ControllerRegistration { tabs, tab_id });
    }

    fn on_composer_event(&mut self, _: &Entity<Composer>, event: &ComposerEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            ComposerEvent::Send => self.send(window, cx),
            ComposerEvent::Stop => {
                let pending = cx.core().use_::<AgentsModule>().task(&self.task_id).cancel();
                cx.foreground_executor().spawn(pending).detach();
            }
            ComposerEvent::CancelRestore => self.cancel_and_restore(cx),
        }
    }

    /// `sendPrompt`: resolve directives and mentions, queue the prompt,
    /// remember it, clear the draft, jump to the live edge.
    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(composer) = self.composer.clone() else { return };
        let Some(row) = self.row(cx) else { return };
        let text = composer.read(cx).text(cx);
        if text.is_empty() {
            return;
        }
        let (sent, extras) = prompt_to_send(cx, &row.workspace_path, &self.task_id, &row.harness_id, &text);
        let pending = cx.core().use_::<AgentsModule>().task(&self.task_id).prompt(&sent, extras);
        cx.foreground_executor().spawn(pending).detach();
        let drafts = ComposerDrafts::global(cx);
        drafts.set_last_sent(&self.task_id, &text);
        drafts.clear(&self.task_id);
        composer.update(cx, |c, cx| {
            c.set_text("", cx);
            c.focus(window, cx);
        });
        self.transcript.update(cx, |t, cx| t.scroll_to_end(cx));
    }

    /// Escape while a turn runs (MET-94): cancel it; when the agent had not
    /// answered yet, the round is forgotten and the sent prompt comes back
    /// into an empty composer (never over a half-typed follow-up).
    pub fn cancel_and_restore(&mut self, cx: &mut Context<Self>) {
        let pending = cx.core().use_::<AgentsModule>().task(&self.task_id).cancel_turn_and_forget();
        let task_id = self.task_id.clone();
        cx.spawn(async move |this, cx| {
            if !pending.await {
                return;
            }
            let _ = this.update(cx, |this, cx| {
                let Some(composer) = this.composer.clone() else { return };
                let drafts = ComposerDrafts::global(cx);
                if !drafts.get(&task_id).trim().is_empty() {
                    return;
                }
                let last = drafts.last_sent(&task_id);
                if !last.is_empty() {
                    composer.update(cx, |c, cx| c.set_text(&last, cx));
                }
            });
        })
        .detach();
    }

    fn render_overlay(&mut self, row: &AgentTaskRow, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        let bg = t.background;
        let running = row.status == TaskStatus::Running;
        let pending = cx.core().use_::<AgentStoreModule>().pending_permissions(&self.task_id);
        let height = self.overlay_height.clone();
        let transcript = self.transcript.downgrade();
        div()
            .absolute()
            .left_0()
            .right_0()
            .bottom_0()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .px(sp(3.))
            .pb(sp(3.))
            .pt(sp(10.))
            .bg(linear_gradient(
                0.,
                linear_color_stop(bg, 0.45),
                linear_color_stop(bg.opacity(0.), 1.),
            ))
            // Measure the overlay so the transcript can pad past it.
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, _, cx| {
                        let h = bounds.size.height;
                        if (height.get() - h).abs() > px(0.5) {
                            height.set(h);
                            let transcript = transcript.clone();
                            cx.defer(move |cx| {
                                let _ = transcript.update(cx, |t, cx| t.set_bottom_inset(h, cx));
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .when(running, |d| {
                d.child(
                    div()
                        .self_start()
                        .px(sp(1.))
                        .text_size(t.text_xs)
                        .text_color(t.muted_foreground)
                        .child(ShimmerText::new(tr("agentWorking")).id("agent-working")),
                )
            })
            .children(permission_card(&self.task_id, &pending, false, cx))
            .when(row.auth_required, |d| d.child(self.auth.clone()))
            .map(|d| {
                if row.status == TaskStatus::Unavailable {
                    d.child(unavailable_card(&self.task_id, cx))
                } else {
                    d.children(self.composer.clone())
                }
            })
    }
}

impl Focusable for ChatTab {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ChatTab {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let t = tokens(cx);
        // The tab can outlive the task row for a frame (workspace teardown).
        let Some(row) = self.row(cx) else {
            return div()
                .flex()
                .size_full()
                .flex_1()
                .items_center()
                .justify_center()
                .text_size(t.text_sm)
                .text_color(t.muted_foreground)
                .child(tr("agentSessionEnded"))
                .into_any_element();
        };
        div()
            .id("agent-chat-tab")
            .track_focus(&self.focus)
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .bg(t.background)
            .text_color(t.foreground)
            .child(self.transcript.clone())
            .child(self.render_overlay(&row, cx))
            .into_any_element()
    }
}

/// The chat tab's side of the tab-controller contract.
struct ChatTabController {
    tab_id: String,
    focus: async_channel::Sender<()>,
    can_focus: Rc<Cell<bool>>,
}

impl TabController for ChatTabController {
    fn tab_id(&self) -> &str {
        &self.tab_id
    }

    fn kind(&self) -> notefig_tabs::tab_id::TabKind {
        notefig_tabs::tab_id::TabKind::Agent
    }

    /// Focus lands on the composer, or parks on the root and reports false
    /// while the composer declines (a `WhenMounted` intent keeps waiting).
    fn focus(&self, _steal: bool) -> bool {
        let _ = self.focus.try_send(());
        self.can_focus.get()
    }

    fn is_focusable(&self) -> bool {
        !self.focus.is_closed()
    }

    fn selected_text(&self) -> Option<String> {
        None
    }

    /// Closing the tab leaves the session running.
    fn dispose(&self) {}
}

/// Unregisters the controller when the view goes.
struct ControllerRegistration {
    tabs: Rc<notefig_tabs::TabsApi>,
    tab_id: String,
}

impl Drop for ControllerRegistration {
    fn drop(&mut self) {
        self.tabs.controllers().unregister(&self.tab_id);
    }
}
