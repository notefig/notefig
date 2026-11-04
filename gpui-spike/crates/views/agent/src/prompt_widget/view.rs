//! `PromptBlob` (`prompt/ui/prompt-blob.tsx`, `widget-response-view.tsx`,
//! `copy-text-button.tsx`): one widget's face over `core.promptWidgets`.
//!
//! The service holds the state (machine, binding, last prompt, outcome);
//! this view reads it, renders the face for its phase, and runs the actions
//! — send, reply, choice answers, edit, retry, stop, dismiss, session
//! picking — through the service, `core.agents` and the shared session.
//! Everything that behaves differently per state asks `capabilities_of`.

use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use gpui::{
    Animation, AnimationExt as _, AnyElement, App, AppContext as _, ClipboardItem, Context, ElementId, Entity, FontWeight, Hsla,
    InteractiveElement, IntoElement, KeyDownEvent, MouseButton, ParentElement, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Subscription, WeakEntity, Window, div, prelude::FluentBuilder as _,
};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::tooltip::Tooltip;
use markdown_editor::{BlockEditorState, BlockPosition, PromptWidget as WidgetNode, strip_prompt_markers};
use notefig_agent::mcp::WidgetResponse;
use notefig_agent::model::{AgentEntry, AgentTaskRow, TaskStatus};
use notefig_agent::prompt::WidgetPromptSource;
use notefig_agents::{AgentStoreModule, AgentsModule};
use notefig_i18n::{t, t_args};
use notefig_prompt_widgets::{
    Ask, BlobPhase, DispatchedRound, Escape, PromptWidget, PromptWidgetsModule, StopCommands, StopResult,
    WidgetState, capabilities_of, phase_of, prompt_change_hue,
};
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use super::draft::{DraftEvent, DraftField};
use super::face::{
    CardTone, ChoiceKey, DoneLabels, card_tone, compose_choice_answer, derive_active_tool_line, derive_choice_key,
    REMOVAL_REFUSED_HINT_MS, SHAKE_MS, derive_done_line, derive_latest_assistant_line, derive_queue_position,
    draft_placeholder_key, is_choice_kind, shake_due, shake_offset, widget_prompt_target,
};
use super::host::PromptWidgetHost;
use super::{prompt_round_id, sessions};
use crate::harness_settings::{default_harness, harness_logo_element, set_default_harness};
use crate::style::{self, PopoverSide, text_9, text_10, text_11, tint_over};

/// A choice question's picks, held per round (`ChoicePicks`).
#[derive(Default)]
struct ChoicePicks {
    turn_id: Option<String>,
    picked: Vec<String>,
    /// The option the keys are on; `None` while they are in the field.
    focused: Option<usize>,
}

/// The `promptWidgets` service.
fn prompts(cx: &App) -> Rc<notefig_prompt_widgets::PromptWidgetsModuleApi> {
    cx.core().use_::<PromptWidgetsModule>()
}

/// `StopCommands` over `core.agents`.
struct AgentStop(notefig_agents::AgentsApi);

impl StopCommands for AgentStop {
    fn cancel_task(&self, task_id: &str) {
        let cancel = self.0.task(task_id).cancel();
        std::mem::drop(cancel.map(|r| {
            if let Err(err) = r {
                log::warn!("prompt widget: stop failed: {err}");
            }
        }));
    }
    fn remove_queued_prompt(&self, task_id: &str, turn_id: &str) {
        self.0.task(task_id).remove_queued_prompt(turn_id);
    }
}

/// `--chart-<n>`: a widget's review colour.
pub(crate) fn chart_color(hue: u32, dark: bool) -> Hsla {
    let (h, s, l) = match (hue, dark) {
        (1, _) => (220., 70., 50.),
        (2, false) => (173., 58., 39.),
        (2, true) => (160., 60., 45.),
        (3, false) => (197., 37., 24.),
        (3, true) => (30., 80., 55.),
        (4, false) => (43., 74., 66.),
        (4, true) => (280., 65., 60.),
        (_, false) => (27., 87., 67.),
        (_, true) => (340., 75., 55.),
    };
    gpui::hsla(h / 360., s / 100., l / 100., 1.)
}

/// `formatTimeAgo`.
fn time_ago(ms: i64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let s = ((now - ms) / 1000).max(0);
    match s {
        0..60 => "just now".into(),
        60..3600 => format!("{}m ago", s / 60),
        3600..86400 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86400),
    }
}

pub struct PromptWidgetView {
    pub(crate) blob_id: String,
    /// The chip's ✕ (TS `clearReference`): the selection this widget was
    /// summoned over is no longer sent or shown.
    reference_cleared: bool,
    host: WeakEntity<PromptWidgetHost>,
    workspace_path: String,
    pub(crate) draft: Entity<DraftField>,
    draft_empty: bool,
    /// Summoned by "/" (Escape or a second "/" reverts it to a slash).
    pub(crate) summoned: bool,
    /// The response body is shown (`defaultExpanded`: in a document, yes).
    expanded: bool,
    picks: ChoicePicks,
    copied_at: Option<Instant>,
    session_menu: bool,
    auth: Option<(String, Entity<crate::cards::AuthCard>)>,
    /// Last state seen, to catch a live round settling.
    last_state: WidgetState,
    _widget: notefig_core::Subscription,
    _rows: Option<(String, notefig_core::Subscription)>,
    _escape: notefig_core::Subscription,
    _subs: Vec<Subscription>,
}

impl PromptWidgetView {
    pub(crate) fn new(
        blob_id: String,
        persisted_task: Option<String>,
        summoned: bool,
        host: WeakEntity<PromptWidgetHost>,
        workspace_path: String,
        document_path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let draft = cx.new(|cx| DraftField::new(workspace_path.clone(), window, cx));
        let subs = vec![cx.subscribe_in(&draft, window, Self::on_draft_event)];
        let service = prompts(cx);
        let id = blob_id.clone();
        let widget_sub = observe(cx, move |notify| service.subscribe(&id, move || notify()));
        let service = prompts(cx);
        // Where this widget lives (the app's session → widget lookups).
        service.set_document(&blob_id, &document_path);
        // A widget restored from the file carries its session: adopted when
        // still reachable; a session gone for good leaves a fresh composer
        // (the file is never edited on that answer).
        if let Some(task) = persisted_task
            && cx.core().use_::<AgentsModule>().task(&task).is_reachable()
        {
            service.restore(&blob_id, &task);
        }
        let escape = service.claim_escape(&blob_id);
        let last_state = service.get(&blob_id).state;
        let mut this = Self {
            reference_cleared: false,
            blob_id,
            host,
            workspace_path,
            draft,
            draft_empty: true,
            summoned,
            expanded: true,
            picks: ChoicePicks::default(),
            copied_at: None,
            session_menu: false,
            auth: None,
            last_state,
            _widget: widget_sub,
            _rows: None,
            _escape: escape,
            _subs: subs,
        };
        // Built while the host renders (it is mid-update), and `sync` reads
        // the host: run it once that update is over.
        let me = cx.entity().downgrade();
        cx.defer(move |cx| {
            let _ = me.update(cx, |this, cx| this.sync(cx));
        });
        this
    }

    fn widget(&self, cx: &App) -> Rc<PromptWidget> {
        prompts(cx).get(&self.blob_id)
    }

    fn editor(&self, cx: &App) -> Option<Entity<BlockEditorState>> {
        self.host.upgrade()?.read(cx).editor()
    }

    /// The selection this widget was summoned over (`captureSelectionReference`):
    /// its text and editor range, unless the chip's ✕ cleared it.
    fn reference(&self, cx: &App) -> Option<(String, notefig_agent::prompt::Range)> {
        if self.reference_cleared {
            return None;
        }
        let editor = self.editor(cx)?;
        let state = editor.read(cx);
        let model = state.model();
        let block = model.find_prompt_widget(&self.blob_id)?;
        let reference = model.widget_reference(block)?;
        let from = model.pm_from_position(reference.from).unwrap_or(0) as i64;
        let to = model.pm_from_position(reference.to).unwrap_or(0) as i64;
        Some((reference.text.to_string(), notefig_agent::prompt::Range { from, to }))
    }

    /// `ReferenceChip`: the quoted selection's first line; its ✕ only while
    /// the widget takes typing (`referenceRemovalArmed`).
    fn reference_chip(&self, phase: BlobPhase, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (text, _) = self.reference(cx)?;
        let tk = tokens(cx).clone();
        let first = text.split('\n').next().unwrap_or("").to_string();
        let full: SharedString = if text.chars().count() > 600 {
            format!("{}…", text.chars().take(600).collect::<String>()).into()
        } else {
            text.clone().into()
        };
        let removable = super::face::takes_typing(phase);
        let (accent, fg) = (tk.accent, tk.foreground);
        Some(
            div()
                .px(sp(2.))
                .pt(sp(1.5))
                .text_size(text_9())
                .line_height(rem(0.75))
                .text_color(tk.muted_foreground.opacity(0.8))
                .child(
                    div()
                        .id(ElementId::Name(format!("ref-{}", self.blob_id).into()))
                        .group("ref")
                        .flex()
                        .max_w_full()
                        .items_center()
                        .gap(sp(1.))
                        .rounded(rem(0.125))
                        .px(sp(1.))
                        .py(sp(0.5))
                        .hover(move |s| s.bg(accent.opacity(0.5)))
                        .tooltip(move |window, cx| Tooltip::new(full.clone()).build(window, cx))
                        .child(icon("text-quote").size(rem(0.625)).flex_none().text_color(tk.muted_foreground))
                        .child(div().min_w_0().truncate().italic().child(first))
                        .when(removable, |d| {
                            d.child(
                                div()
                                    .id(ElementId::Name(format!("ref-x-{}", self.blob_id).into()))
                                    .flex_none()
                                    .cursor_pointer()
                                    .rounded(rem(0.125))
                                    .p(sp(0.5))
                                    .invisible()
                                    .group_hover("ref", |s| s.visible())
                                    .hover(move |s| s.bg(accent).text_color(fg))
                                    .tooltip(|window, cx| Tooltip::new(t("promptBlobReferenceRemove")).build(window, cx))
                                    .child(icon("x").size(rem(0.625)).text_color(tk.muted_foreground))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.reference_cleared = true;
                                        cx.notify();
                                    })),
                            )
                        }),
                )
                .into_any_element(),
        )
    }

    fn document_path(&self, cx: &App) -> String {
        self.host.upgrade().map(|h| h.read(cx).document_path().to_string()).unwrap_or_default()
    }

    /// The harness the widget's prompts go to (`useTargetHarnessId`): its
    /// bound session's, else the shared session's, else the default.
    fn target_harness(&self, cx: &App) -> String {
        let store = cx.core().use_::<AgentStoreModule>();
        let widget = self.widget(cx);
        let task = widget.bound_task_id.clone().or_else(|| sessions::peek(&self.workspace_path, cx));
        task.and_then(|t| store.task(&t))
            .map(|row| row.harness_id)
            .or_else(|| default_harness(cx))
            .unwrap_or_else(|| "claude-code".into())
    }

    fn harness_label(&self, harness_id: &str, cx: &App) -> String {
        cx.core().use_::<AgentsModule>().harness_label(harness_id)
    }

    /// Keep what follows the service in step: the bound task's rows, the
    /// file marker, the draft's placeholder and editability, and the review
    /// ranges of a round that just settled.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let widget = self.widget(cx);
        // Watch the bound task's rows (the transcript lines, the cards).
        let task = widget.bound_task_id.clone();
        if self._rows.as_ref().map(|(t, _)| Some(t)) != Some(task.as_ref()) {
            self._rows = task.map(|t| {
                let store = cx.core().use_::<AgentStoreModule>();
                let id = t.clone();
                (t, observe(cx, move |notify| store.subscribe_task(&id, move || notify())))
            });
        }
        // The file marker follows the binding.
        if let Some(editor) = self.editor(cx) {
            let id = self.blob_id.clone();
            let bound = widget.bound_task_id.clone();
            editor.update(cx, |e, cx| {
                let model = e.model();
                if let Some(block) = model.find_prompt_widget(&id)
                    && model.prompt_widget(block).is_some_and(|w| w.task.as_deref() != bound.as_deref())
                    && bound.is_some()
                {
                    let _ = e.set_prompt_widget(block, WidgetNode { id: id.clone().into(), task: bound.clone().map(Into::into) }, cx);
                }
            });
        }
        let phase = phase_of(widget.state);
        let caps = capabilities_of(widget.state, self.summoned);
        let placeholder = match cx.core().try_use::<notefig_dictation::DictationModule>() {
            Some(d) => {
                let key = notefig_dictation::hold_key_label(d.hold_key(), notefig_dictation::KeyPlatform::current());
                t_args(&format!("{}Dictation", draft_placeholder_key(phase)), &[("key", &key)])
            }
            None => t(draft_placeholder_key(phase)),
        };
        let size = if phase == BlobPhase::Composing { tokens(cx).text_sm } else { tokens(cx).text_xs };
        let target = (widget.bound_task_id.clone().or_else(|| sessions::peek(&self.workspace_path, cx)), self.target_harness(cx));
        self.draft.update(cx, |d, cx| {
            d.set_placeholder(placeholder, cx);
            d.set_editable(caps.field_editable, cx);
            d.set_text_size(size, cx);
            d.set_target(target.0, target.1);
        });
        // A round that was live and is now over: keep its changes for review.
        let was_live = matches!(self.last_state, WidgetState::Working(_) | WidgetState::Asking(Ask::Permission));
        if was_live && matches!(widget.state, WidgetState::Settled(_) | WidgetState::Asking(Ask::Question)) {
            self.save_review_ranges(&widget, cx);
        }
        self.last_state = widget.state;
    }

    /// Persist the round's tracked spans as review ranges (`change-store`).
    fn save_review_ranges(&self, widget: &PromptWidget, cx: &mut Context<Self>) {
        let (Some(turn), Some(editor)) = (widget.bound_turn_id.clone(), self.editor(cx)) else { return };
        let document_path = self.document_path(cx);
        let state = editor.read(cx);
        let model = state.model();
        let round = prompt_round_id(&turn);
        let mut changes: Vec<notefig_prompt_widgets::PromptChange> = prompts(cx)
            .review()
            .changes(&document_path)
            .iter()
            .filter(|c| c.turn_id != turn)
            .cloned()
            .collect();
        for c in state.tracked_changes(round) {
            let from = model.pm_from_position(BlockPosition::new(c.block, c.range.start));
            let to = model.pm_from_position(BlockPosition::new(c.block, c.range.end));
            if let (Some(from), Some(to)) = (from, to) {
                changes.push(notefig_prompt_widgets::PromptChange {
                    blob_id: self.blob_id.clone(),
                    turn_id: turn.clone(),
                    from: from as i64,
                    to: to as i64,
                });
            }
        }
        let fingerprint = format!("{:x}", md5_like(&state.source()));
        let review = prompts(cx);
        review.review().set(&document_path, changes.clone());
        review.review().save(&document_path, notefig_prompt_widgets::SavedReviewRanges { fingerprint, changes });
    }

    fn on_draft_event(&mut self, _: &Entity<DraftField>, event: &DraftEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            DraftEvent::Submit => self.submit(window, cx),
            DraftEvent::Changed => {
                // The live draft titles the widget's minimap dot.
                let text = self.draft.read(cx).text(cx);
                prompts(cx).set_draft(&self.blob_id, &markdown_editor::dot_title(text.trim()));
                let empty = self.draft.read(cx).is_empty(cx);
                // Any edit to the field leaves a choice's options.
                self.picks.focused = None;
                let live = capabilities_of(self.widget(cx).state, self.summoned).live_draft;
                if empty != self.draft_empty || live {
                    self.draft_empty = empty;
                    cx.notify();
                }
            }
            DraftEvent::Focus | DraftEvent::Blur => cx.notify(),
        }
    }

    // ── actions ──

    /// Enter: a prompt, a reply, or a question's answer.
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let widget = self.widget(cx);
        match widget.state {
            WidgetState::Composing { .. } => self.send(window, cx),
            WidgetState::Asking(Ask::Question) => {
                let picked = self.picks.picked.clone();
                self.send_follow_up(Box::new(move |typed| compose_choice_answer(&picked, typed)), window, cx)
            }
            WidgetState::Settled(_) => self.send_follow_up(Box::new(|typed| typed.to_string()), window, cx),
            _ => {}
        }
    }

    /// The widget-context target of a prompt sent now (read fresh: a reply
    /// may follow a round that filled the doc or moved the node).
    fn prompt_source(&self, cx: &App) -> WidgetPromptSource {
        let document_path = self.document_path(cx);
        let (pos, size, empty) = self
            .editor(cx)
            .map(|e| {
                let state = e.read(cx);
                let model = state.model();
                let pos = model
                    .find_prompt_widget(&self.blob_id)
                    .and_then(|b| model.pm_from_position(BlockPosition::new(b, 0)))
                    .map(|p| p as i64);
                let source = state.source();
                (pos, source.len() as i64, strip_prompt_markers(&source).trim().is_empty())
            })
            .unwrap_or((None, 0, true));
        let (path, pos) = widget_prompt_target(&document_path, &self.workspace_path, pos, size);
        WidgetPromptSource {
            workspace_path: self.workspace_path.clone(),
            path,
            pos,
            is_doc_empty: empty,
            reference: self.reference(cx),
        }
    }

    /// The one dispatch both send paths share: `prompt_from_widget` on the
    /// task, with directives resolved and mentions as context parts.
    fn dispatch(
        &self,
        task: futures::future::LocalBoxFuture<'static, Result<String, String>>,
        text: String,
        cx: &mut Context<Self>,
    ) -> futures::future::LocalBoxFuture<'static, Result<DispatchedRound, String>> {
        let source = self.prompt_source(cx);
        let document_path = self.document_path(cx);
        let workspace = self.workspace_path.clone();
        let harness = self.target_harness(cx);
        let agents = cx.core().use_::<AgentsModule>().agents.clone();
        let editor = self.editor(cx).map(|e| e.downgrade());
        let async_cx = cx.to_async();
        async move {
            let task_id = task.await?;
            let (sent, extras) =
                async_cx.update(|cx| crate::composer::prompt_to_send(cx, &workspace, &task_id, &harness, &text));
            let handle = agents
                .task(&task_id)
                .prompt_from_widget(&sent, source, extras)
                .await
                .ok_or_else(|| "the agent runtime is gone".to_string())?;
            // The round is tracked from its first write.
            let round = prompt_round_id(&handle.turn_id);
            if let Some(editor) = editor {
                let _ = async_cx.update(|cx| {
                    let _ = editor.update(cx, |e, _| e.track_changes(round));
                });
            }
            drop(handle.completed);
            Ok(DispatchedRound {
                task_id,
                turn_id: handle.turn_id,
                workspace_path: workspace,
                document_path,
                sent_prompt: sent,
            })
        }
        .boxed_local()
    }

    /// Round one (`send`): the trust gate, then the bound session if still
    /// reachable, else the workspace's shared one.
    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.draft.read(cx).text(cx).trim().to_string();
        if text.is_empty() {
            return;
        }
        let service = prompts(cx);
        let agents = cx.core().use_::<AgentsModule>();
        let ws = agents.workspace(&self.workspace_path);
        let confirming = matches!(service.get(&self.blob_id).state, WidgetState::Composing { confirming_trust: true });
        if !ws.is_trusted() && !confirming {
            service.ask_trust(&self.blob_id);
            return;
        }
        if confirming {
            ws.trust();
            service.answer_trust(&self.blob_id);
        }
        let bound = service.get(&self.blob_id).bound_task_id.clone().filter(|t| agents.task(t).is_reachable());
        let harness = self.target_harness(cx);
        let task = match bound {
            Some(t) => futures::future::ready(Ok(t)).boxed_local(),
            None => sessions::get_or_start(&self.workspace_path, &harness, cx),
        };
        let dispatch = self.dispatch(task, text.clone(), cx);
        self.run_send(text, dispatch, window, cx);
    }

    /// A reply (or an answer): continue on the BOUND task, never the shared
    /// session. A session that is gone keeps the draft and unbinds.
    fn send_follow_up(&mut self, compose: Box<dyn FnOnce(&str) -> String>, window: &mut Window, cx: &mut Context<Self>) {
        let text = compose(&self.draft.read(cx).text(cx)).trim().to_string();
        let service = prompts(cx);
        let Some(task) = service.get(&self.blob_id).bound_task_id.clone() else { return };
        if text.is_empty() {
            return;
        }
        if !cx.core().use_::<AgentsModule>().task(&task).is_reachable() {
            window.push_notification(t("promptBlobSessionGone"), cx);
            service.unbind(&self.blob_id);
            return;
        }
        let dispatch = self.dispatch(futures::future::ready(Ok(task)).boxed_local(), text.clone(), cx);
        self.run_send(text, dispatch, window, cx);
    }

    fn run_send(
        &mut self,
        text: String,
        dispatch: futures::future::LocalBoxFuture<'static, Result<DispatchedRound, String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let sent = prompts(cx).send(&self.blob_id, &text, move || dispatch);
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            if !sent.await {
                return;
            }
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    this.picks = ChoicePicks::default();
                    this.draft.update(cx, |d, cx| d.set_text("", cx));
                    // The field closes while the agent works: the caret
                    // goes back to the document.
                    this.leave(window, cx);
                });
            });
        })
        .detach();
        cx.notify();
    }

    /// Unbind and pull the sent prompt back into the composer (a draft
    /// already typed wins).
    fn restore_prompt_to_draft(&mut self, cx: &mut Context<Self>) {
        let service = prompts(cx);
        let last = service.get(&self.blob_id).last_sent_prompt.clone();
        service.unbind(&self.blob_id);
        let current = self.draft.read(cx).text(cx);
        let next = if current.trim().is_empty() { last } else { current };
        self.draft.update(cx, |d, cx| d.set_text(&next, cx));
    }

    /// Edit: a queued turn is withdrawn; the prompt comes back to the field.
    fn edit_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let stop = AgentStop(cx.core().use_::<AgentsModule>().agents.clone());
        prompts(cx).withdraw(&self.blob_id, &stop);
        self.restore_prompt_to_draft(cx);
        self.draft.update(cx, |d, cx| d.focus(window, cx));
    }

    fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_prompt(window, cx);
        self.send(window, cx);
    }

    /// Stop: a queued turn is withdrawn (its prompt comes back), a running
    /// one cancelled (the widget settles as Stopped).
    fn stop(&mut self, cx: &mut Context<Self>) {
        let stop = AgentStop(cx.core().use_::<AgentsModule>().agents.clone());
        if prompts(cx).stop(&self.blob_id, &stop) == StopResult::Withdrawn {
            self.restore_prompt_to_draft(cx);
        }
    }

    /// Escape in the document while this round is the newest running one.
    pub(crate) fn stop_from_document(&mut self, cx: &mut Context<Self>) {
        self.stop(cx);
    }

    /// ✕: unbind, and remove the node when the doc has real content (in an
    /// empty doc the keeper would only put it back).
    fn dismiss(&mut self, cx: &mut Context<Self>) {
        prompts(cx).unbind(&self.blob_id);
        self.draft.update(cx, |d, cx| d.set_text("", cx));
        if let Some(host) = self.host.upgrade() {
            let id = self.blob_id.clone();
            host.update(cx, |h, cx| h.remove_widget(&id, None, true, cx));
        }
    }

    /// Esc or a second "/" on an empty summoned composer: back to a "/".
    fn revert_to_slash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(host) = self.host.upgrade() {
            let id = self.blob_id.clone();
            host.update(cx, |h, cx| h.remove_widget(&id, Some("/"), false, cx));
            self.focus_editor(window, cx);
        }
    }

    /// Backspace on an empty composer: a summoned widget gives its
    /// paragraph back; one restored from a marker is removed outright when
    /// the doc has real content.
    fn backspace_dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(host) = self.host.upgrade() {
            let id = self.blob_id.clone();
            let summoned = self.summoned;
            host.update(cx, |h, cx| h.remove_widget(&id, summoned.then_some(""), !summoned, cx));
            self.focus_editor(window, cx);
        }
    }

    fn focus_editor(&self, window: &mut Window, cx: &mut App) {
        if let Some(editor) = self.editor(cx) {
            editor.update(cx, |e, cx| e.focus(window, cx));
        }
    }

    /// Hand the caret back to the document, after the widget.
    fn leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor(cx) else { return };
        let id = self.blob_id.clone();
        editor.update(cx, |e, cx| match e.model().find_prompt_widget(&id) {
            Some(block) => e.focus_after_widget(block, window, cx),
            None => e.focus(window, cx),
        });
    }

    /// The session picker: a bound widget is re-targeted; an unbound one
    /// moves the shared session.
    fn select_session(&mut self, task_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.session_menu = false;
        sessions::adopt(&self.workspace_path, task_id, cx);
        if self.widget(cx).bound_task_id.is_some() {
            prompts(cx).rebind(&self.blob_id, task_id);
        }
        self.draft.update(cx, |d, cx| d.focus(window, cx));
        cx.notify();
    }

    /// "New {harness} conversation": drop the shared session and remember
    /// the harness as the default.
    fn new_conversation(&mut self, harness_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.session_menu = false;
        set_default_harness(harness_id, cx);
        sessions::drop_session(&self.workspace_path, cx);
        if self.widget(cx).bound_task_id.is_some() {
            prompts(cx).unbind(&self.blob_id);
        }
        self.draft.update(cx, |d, cx| d.focus(window, cx));
        cx.notify();
    }

    fn open_chat(&self, cx: &mut App) {
        let Some(task) = self.widget(cx).bound_task_id.clone() else { return };
        match cx.core().try_use::<notefig_tabs::TabsModule>() {
            Some(tabs) => tabs.open_agent(&task),
            None => cx.core().use_::<AgentsModule>().task(&task).open(),
        }
    }

    fn open_file(&self, path: &str, cx: &mut App) {
        if let Some(tabs) = cx.core().try_use::<notefig_tabs::TabsModule>() {
            tabs.open(
                path,
                notefig_tabs::OpenTabOptions { intent: notefig_layout::OpenFileIntent::NewTab, ..Default::default() },
            );
        }
    }

    /// A choice option clicked: a single choice sends it, a multiple one
    /// toggles it.
    fn pick_option(&mut self, option: String, multiple: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !multiple {
            self.send_follow_up(Box::new(move |typed| compose_choice_answer(&[option], typed)), window, cx);
            return;
        }
        if let Some(i) = self.picks.picked.iter().position(|p| *p == option) {
            self.picks.picked.remove(i);
        } else {
            self.picks.picked.push(option);
        }
        cx.notify();
    }

    /// Keys in the field, before the field sees them (`useComposerKeys`).
    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let mods = &event.keystroke.modifiers;
        if mods.platform || mods.control || mods.alt {
            return;
        }
        if self.draft.update(cx, |d, cx| d.menu_key(key, window, cx)) {
            cx.stop_propagation();
            return;
        }
        let widget = self.widget(cx);
        let caps = capabilities_of(widget.state, self.summoned);
        let empty = self.draft.read(cx).is_empty(cx);
        // A choice question's options take the keys first.
        if let Some((options, multiple)) = self.open_choice(&widget) {
            let dom = match key {
                "up" => "ArrowUp",
                "down" => "ArrowDown",
                "left" => "ArrowLeft",
                "right" => "ArrowRight",
                "enter" => "Enter",
                "escape" => "Escape",
                "space" => " ",
                other => other,
            };
            if let Some(action) = derive_choice_key(dom, self.picks.focused, options.len(), multiple, self.picks.picked.len(), empty) {
                match action {
                    ChoiceKey::Focus { focus, consumed } => {
                        self.picks.focused = focus;
                        cx.notify();
                        if consumed {
                            cx.stop_propagation();
                        }
                        if consumed || !matches!(key, "up") {
                            return;
                        }
                    }
                    ChoiceKey::Send => {
                        cx.stop_propagation();
                        let picked = self.picks.picked.clone();
                        self.send_follow_up(Box::new(move |typed| compose_choice_answer(&picked, typed)), window, cx);
                        return;
                    }
                    ChoiceKey::Pick(ix) => {
                        cx.stop_propagation();
                        self.picks.focused = Some(ix);
                        self.pick_option(options[ix].clone(), multiple, window, cx);
                        return;
                    }
                }
            }
        }
        match key {
            "escape" => {
                cx.stop_propagation();
                match caps.escape {
                    Escape::Stop => self.stop(cx),
                    Escape::Revert if empty => self.revert_to_slash(window, cx),
                    _ => self.leave(window, cx),
                }
            }
            "/" if empty && self.summoned && matches!(widget.state, WidgetState::Composing { .. }) => {
                cx.stop_propagation();
                self.revert_to_slash(window, cx);
            }
            "backspace" if empty && caps.field_editable => {
                cx.stop_propagation();
                self.backspace_dismiss(window, cx);
            }
            "down" if empty => {
                cx.stop_propagation();
                self.leave(window, cx);
            }
            _ => {}
        }
    }

    /// The open choice question's options, while one is asked.
    fn open_choice(&self, widget: &PromptWidget) -> Option<(Vec<String>, bool)> {
        if widget.state != WidgetState::Asking(Ask::Question) {
            return None;
        }
        let response = widget.outcome.as_ref()?.response.as_ref()?;
        Some((response.options.clone()?, response.kind == "multiple_choice"))
    }

    // ── rendering ──

    fn small_button(
        &self,
        id: &str,
        glyph: &str,
        label: String,
        size: gpui::Pixels,
        pad: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let tk = tokens(cx).clone();
        let (accent, fg) = (tk.accent, tk.foreground);
        div()
            .id(ElementId::Name(format!("{id}-{}", self.blob_id).into()))
            .flex_none()
            .rounded(rem(0.25))
            .p(pad)
            .text_color(tk.muted_foreground)
            .cursor_pointer()
            .hover(move |s| s.bg(accent).text_color(fg))
            .tooltip(move |window, cx| Tooltip::new(label.clone()).build(window, cx))
            .child(icon(glyph).size(size).text_color(tk.muted_foreground))
    }

    /// `StatusRow`: spinner, label and the sent prompt (or the live
    /// teaser), with Open chat / Edit / Stop slots that stay reserved.
    fn status_row(
        &self,
        label: Option<String>,
        shimmer: bool,
        prompt: String,
        teaser: Option<String>,
        actions: Option<String>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let tk = tokens(cx).clone();
        let second = teaser.unwrap_or(prompt);
        let bound = actions.is_some();
        let invisible = |el: gpui::Stateful<gpui::Div>, on: bool| if on { el } else { el.invisible() };
        div()
            .flex()
            .items_center()
            .gap(sp(2.))
            .px(sp(2.5))
            .py(sp(1.5))
            .when(shimmer, |d| {
                d.child(crate::glyph::orb(
                    ElementId::Name(format!("orb-{}", self.blob_id).into()),
                    sp(3.5),
                    tk.muted_foreground,
                    true,
                ))
            })
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .when_some(label.filter(|l| !l.trim().is_empty()), |d, l| {
                        d.child(
                            div()
                                .truncate()
                                .text_size(tk.text_xs)
                                .font_weight(FontWeight::MEDIUM)
                                .when(shimmer, |d| d.text_color(tk.muted_foreground))
                                .child(l),
                        )
                    })
                    .when(!second.trim().is_empty(), |d| {
                        d.child(div().truncate().text_size(text_11()).text_color(tk.muted_foreground).child(second))
                    }),
            )
            .child(invisible(
                self.small_button("open-chat", "message-square", t("promptBlobOpenChat"), sp(3.5), sp(1.), cx)
                    .on_click(cx.listener(|this, _, _, cx| this.open_chat(cx))),
                bound,
            ))
            .child(invisible(
                self.small_button("edit", "pencil", t("promptBlobEdit"), sp(3.5), sp(1.), cx)
                    .on_click(cx.listener(|this, _, window, cx| this.edit_prompt(window, cx))),
                bound,
            ))
            .child(invisible(
                self.small_button("stop", "square", actions.unwrap_or_default(), sp(3.5), sp(1.), cx)
                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx))),
                bound,
            ))
            .into_any_element()
    }

    /// `SentFace`: sending, queued, running (and its permission card), sign-in.
    fn sent_face(&mut self, phase: BlobPhase, widget: &PromptWidget, round: Option<&RoundView>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let prompt = widget.last_sent_prompt.clone();
        Some(match phase {
            BlobPhase::Sending => self.status_row(None, true, self.draft.read(cx).text(cx), None, None, cx),
            BlobPhase::Queued => {
                let ahead = round.map(|r| r.queue_ahead).unwrap_or(0);
                let label = if ahead > 0 {
                    t_args("promptBlobQueuedAhead", &[("count", &ahead.to_string())])
                } else {
                    t("promptBlobQueued")
                };
                self.status_row(Some(label), false, prompt, None, Some(t("agentRemoveFromQueue")), cx)
            }
            BlobPhase::Running | BlobPhase::NeedsPermission => {
                let row = self.status_row(
                    round.and_then(|r| r.active_tool_line.clone()),
                    true,
                    prompt,
                    round.and_then(|r| r.teaser.clone()),
                    Some(t("agentStop")),
                    cx,
                );
                let card = (phase == BlobPhase::NeedsPermission)
                    .then(|| widget.bound_task_id.clone())
                    .flatten()
                    .and_then(|task| self.permission_card(&task, cx));
                div().flex().flex_col().child(row).children(card.map(|c| div().px(sp(2.5)).pb(sp(2.)).child(c))).into_any_element()
            }
            BlobPhase::NeedsAuth => {
                let task = round.and_then(|r| r.task.clone())?;
                let row = self.status_row(Some(t("agentSignInRequired")), false, prompt, None, Some(t("agentStop")), cx);
                div().flex().flex_col().child(row).child(div().px(sp(2.5)).pb(sp(2.)).child(self.auth_card(&task, cx))).into_any_element()
            }
            _ => return None,
        })
    }

    /// `PermissionCard bare` (the chat's card, as the TS host slot).
    fn permission_card(&self, task_id: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pending = cx.core().use_::<AgentStoreModule>().pending_permissions(task_id);
        crate::cards::permission_card(task_id, &pending, true, cx)
    }

    /// `AuthCard bare` (the chat's card, as the TS host slot), kept per task.
    fn auth_card(&mut self, task: &AgentTaskRow, cx: &mut Context<Self>) -> AnyElement {
        if self.auth.as_ref().map(|(id, _)| id.as_str()) != Some(task.task_id.as_str()) {
            let id = task.task_id.clone();
            self.auth = Some((id.clone(), cx.new(|_| crate::cards::AuthCard::new(id, true))));
        }
        self.auth.as_ref().map(|(_, card)| card.clone().into_any_element()).unwrap_or_else(|| div().into_any_element())
    }

    /// `DoneState` / `WidgetResponseView`: the heading row (the harness
    /// mark tinted by kind, the summary line that toggles the body, copy,
    /// Open chat, Dismiss), the body, a question's options, file chips.
    fn done_face(&self, phase: BlobPhase, widget: &PromptWidget, round: Option<&RoundView>, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let outcome = widget.outcome.clone().unwrap_or_default();
        let response: Option<WidgetResponse> = outcome.response.clone();
        let cancelled = widget.state == WidgetState::Settled(notefig_prompt_widgets::SettledOutcome::Cancelled);
        let fallback = outcome.summary.clone().or_else(|| round.and_then(|r| r.teaser.clone()));
        let labels = (t("promptBlobDone"), t("promptBlobStopped"), t("promptBlobIssue"));
        let line = derive_done_line(
            response.as_ref(),
            fallback.as_deref(),
            cancelled,
            self.expanded,
            &DoneLabels { done: &labels.0, stopped: &labels.1, issue: &labels.2 },
        );
        let is_issue = line.kind == "issue";
        let tone = match line.kind.as_str() {
            "issue" => tk.warning,
            "single_choice" | "multiple_choice" => tk.primary,
            _ => tk.success.opacity(0.8),
        };
        let harness = round.and_then(|r| r.task.as_ref()).map(|t| t.harness_id.clone()).unwrap_or_else(|| self.target_harness(cx));
        let mark = harness_logo_element(&harness, sp(3.), tone);
        let copied = self.copied_at.is_some_and(|at| at.elapsed() < Duration::from_millis(1500));
        let copy_text = if is_choice_kind(&line.kind) { Some(line.summary.clone()) } else { line.body.clone() };
        let copy = copy_text.map(|text| {
            self.small_button("copy", if copied { "check" } else { "copy" }, t("copyMessage"), sp(3.), sp(0.5), cx)
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                    this.copied_at = Some(Instant::now());
                    cx.notify();
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(Duration::from_millis(1500)).await;
                        let _ = this.update(cx, |_, cx| cx.notify());
                    })
                    .detach();
                }))
        });
        let actions = div()
            .flex()
            .items_center()
            .child(
                self.small_button("chat", "message-square", t("promptBlobOpenChat"), sp(3.), sp(0.5), cx)
                    .on_click(cx.listener(|this, _, _, cx| this.open_chat(cx))),
            )
            .child(
                self.small_button("dismiss", "x", t("promptBlobDismiss"), sp(3.), sp(0.5), cx)
                    .on_click(cx.listener(|this, _, _, cx| this.dismiss(cx))),
            );
        let md_id = |suffix: &str| SharedString::from(format!("wr-{suffix}-{}", self.blob_id));
        let choices = (phase == BlobPhase::NeedsAnswer).then(|| self.choice_options(widget, cx)).flatten();
        let chips = self.file_chips(&outcome.touched_files, cx);
        if is_choice_kind(&line.kind) {
            return div()
                .flex()
                .flex_col()
                .gap(sp(1.))
                .px(sp(2.))
                .py(sp(1.))
                .child(
                    div()
                        .flex()
                        .items_start()
                        .gap(sp(1.5))
                        .child(div().flex().items_center().h(rem(1.125)).child(mark))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .text_size(tk.text_xs)
                                .line_height(style::leading_relaxed(tk.text_xs))
                                .text_color(tk.foreground)
                                .child(TextView::markdown(md_id("q"), line.summary.clone())),
                        )
                        .children(copy)
                        .child(actions),
                )
                .children(choices)
                .children(chips)
                .into_any_element();
        }
        let expandable = line.body.is_some();
        let summary_color = if is_issue { tk.warning } else { tk.muted_foreground };
        let fg = tk.foreground;
        div()
            .flex()
            .flex_col()
            .gap(sp(0.5))
            .px(sp(2.))
            .py(sp(1.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(sp(1.5))
                    .child(div().flex().flex_none().items_center().child(mark))
                    .child(
                        div()
                            .id(ElementId::Name(format!("summary-{}", self.blob_id).into()))
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(tk.text_xs)
                            .text_color(summary_color)
                            .when(expandable, |d| {
                                let tip = if self.expanded { t("promptBlobShowLess") } else { t("promptBlobShowMore") };
                                d.cursor_pointer()
                                    .hover(move |s| s.text_color(fg))
                                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.expanded = !this.expanded;
                                        cx.notify();
                                    }))
                            })
                            .child(line.summary.clone()),
                    )
                    .children(copy)
                    .child(actions),
            )
            .when_some(line.body.clone().filter(|_| self.expanded), |d, body| {
                d.child(
                    div()
                        .id(ElementId::Name(format!("body-{}", self.blob_id).into()))
                        .max_h(sp(80.))
                        .overflow_y_scroll()
                        .text_size(tk.text_xs)
                        .line_height(style::leading_relaxed(tk.text_xs))
                        .text_color(if is_issue { tk.warning } else { tk.foreground.opacity(0.8) })
                        .child(TextView::markdown(md_id("b"), body)),
                )
            })
            .children(choices)
            .children(chips)
            .into_any_element()
    }

    /// `ChoiceOptions`: a chip per option; a single choice answers on click,
    /// a multiple one toggles (a checkbox), with a send arrow once something
    /// is picked. While the keys are on the options each chip shows its digit.
    fn choice_options(&self, widget: &PromptWidget, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (options, multiple) = self.open_choice(widget)?;
        let tk = tokens(cx).clone();
        let navigating = self.picks.focused.is_some();
        let mut row = div().flex().flex_wrap().items_center().gap(sp(1.5)).pt(sp(0.5));
        for (ix, option) in options.iter().enumerate() {
            let picked = self.picks.picked.contains(option);
            let focused = self.picks.focused == Some(ix);
            let (accent, fg) = (tk.accent, tk.foreground);
            let value = option.clone();
            row = row.child(
                div()
                    .id(ElementId::Name(format!("choice-{}-{ix}", self.blob_id).into()))
                    .flex()
                    .items_center()
                    .gap(sp(1.5))
                    .rounded(tk.radius_md)
                    .border_1()
                    .border_color(if picked { tk.foreground.opacity(0.3) } else { tk.border })
                    .px(sp(2.))
                    .py(sp(0.5))
                    .text_size(tk.text_xs)
                    .text_color(if picked { tk.foreground } else { tk.foreground.opacity(0.8) })
                    .when(picked, |d| d.bg(tk.accent))
                    .when(focused, |d| d.shadow(vec![gpui::BoxShadow {
                        color: tk.ring,
                        offset: gpui::point(gpui::px(0.), gpui::px(0.)),
                        blur_radius: gpui::px(0.),
                        spread_radius: gpui::px(1.),
                        inset: false,
                    }]))
                    .cursor_pointer()
                    .hover(move |s| s.bg(accent).text_color(fg))
                    .when(multiple, |d| {
                        d.child(
                            div()
                                .size(sp(3.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(gpui::px(3.))
                                .border_1()
                                .border_color(tk.primary)
                                .when(picked, |d| d.bg(tk.primary).child(icon("check").size(sp(2.5)).text_color(tk.primary_foreground))),
                        )
                    })
                    .child(option.clone())
                    .when(navigating && ix < 9, |d| d.child(div().text_size(text_10()).text_color(tk.muted_foreground).child((ix + 1).to_string())))
                    .on_click(cx.listener(move |this, _, window, cx| this.pick_option(value.clone(), multiple, window, cx))),
            );
        }
        if multiple && !self.picks.picked.is_empty() {
            row = row.child(
                div().ml_auto().child(
                    self.small_button("choice-send", "corner-down-left", t("send"), sp(3.5), sp(1.), cx).on_click(cx.listener(|this, _, window, cx| {
                        let picked = this.picks.picked.clone();
                        this.send_follow_up(Box::new(move |typed| compose_choice_answer(&picked, typed)), window, cx);
                    })),
                ),
            );
        }
        Some(row.into_any_element())
    }

    /// `TouchedFileChips`: each document the round wrote to; the widget's
    /// own document's chip toggles the review highlighting, another marked
    /// document opens with it on, any other chip just opens.
    fn file_chips(&self, paths: &[String], cx: &mut Context<Self>) -> Option<AnyElement> {
        if paths.is_empty() {
            return None;
        }
        let tk = tokens(cx).clone();
        let service = prompts(cx);
        let counts = service.review().counts(&self.blob_id);
        let reviewing = service.review().reviewing().as_deref() == Some(self.blob_id.as_str());
        let color = chart_color(prompt_change_hue(&self.blob_id), tk.dark);
        let document_path = self.document_path(cx);
        let mut row = div().flex().flex_wrap().items_center().gap(sp(1.));
        for (ix, path) in paths.iter().enumerate() {
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_string();
            let marked = counts.contains_key(path);
            let own = *path == document_path;
            let on = marked && reviewing;
            let (accent, fg) = (tk.accent, tk.foreground);
            let p = path.clone();
            let blob = self.blob_id.clone();
            let chip = div()
                .id(ElementId::Name(format!("chip-{}-{ix}", self.blob_id).into()))
                .flex()
                .items_center()
                .gap(sp(1.))
                .rounded(tk.radius_md)
                .px(sp(1.5))
                .py(sp(0.5))
                .text_size(text_11())
                .cursor_pointer()
                .map(|d| {
                    if on {
                        d.bg(color.opacity(0.15)).text_color(tk.foreground).hover(move |s| s.bg(color.opacity(0.25)))
                    } else {
                        d.bg(tk.muted).text_color(tk.muted_foreground).hover(move |s| s.bg(accent).text_color(fg))
                    }
                })
                .child(if marked {
                    div()
                        .size(sp(3.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(div().size(sp(2.)).rounded_full().border_2().border_color(color).when(on, |d| d.bg(color)))
                        .into_any_element()
                } else {
                    icon("file-text").size(sp(3.)).text_color(tokens(cx).muted_foreground).into_any_element()
                })
                .child(name)
                .on_click(cx.listener(move |this, _, _, cx| {
                    let service = prompts(cx);
                    if marked && own {
                        let now = service.review().reviewing().as_deref() == Some(blob.as_str());
                        service.review().set_reviewing(if now { None } else { Some(&blob) });
                    } else {
                        if marked {
                            service.review().set_reviewing(Some(&blob));
                        }
                        this.open_file(&p, cx);
                    }
                    cx.notify();
                }));
            row = row.child(chip);
        }
        Some(row.into_any_element())
    }

    /// `ErrorState`: the failure, Retry / Edit / Dismiss.
    fn error_face(&self, message: Option<String>, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let text = match message {
            Some(m) if !m.is_empty() => format!("{} {m}", t("promptBlobFailed")),
            _ => t("promptBlobFailed"),
        };
        div()
            .flex()
            .flex_col()
            .px(sp(2.5))
            .py(sp(1.5))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(sp(2.))
                    .child(icon("x").size(sp(3.5)).text_color(tk.destructive))
                    .child(div().min_w_0().flex_1().truncate().text_size(tk.text_xs).text_color(tk.destructive).child(text))
                    .child(self.small_button("retry", "rotate-cw", t("promptBlobRetry"), sp(3.5), sp(1.), cx).on_click(cx.listener(|this, _, window, cx| this.retry(window, cx))))
                    .child(self.small_button("err-edit", "pencil", t("promptBlobEdit"), sp(3.5), sp(1.), cx).on_click(cx.listener(|this, _, window, cx| this.edit_prompt(window, cx))))
                    .child(self.small_button("err-dismiss", "x", t("promptBlobDismiss"), sp(3.5), sp(1.), cx).on_click(cx.listener(|this, _, _, cx| this.dismiss(cx)))),
            )
            .into_any_element()
    }

    /// `SessionControl`: the logo-only trigger naming where the next prompt
    /// goes, and its menu — recent live sessions, then a new conversation
    /// on each of the top three harnesses.
    fn session_control(&self, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let harness = self.target_harness(cx);
        let open = self.session_menu;
        let accent = tk.accent;
        let mut el = div().relative().flex_none().child(
            div()
                .id(ElementId::Name(format!("session-{}", self.blob_id).into()))
                .size(sp(7.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(tk.radius_lg)
                .cursor_pointer()
                .when(open, |d| d.bg(accent))
                .hover(move |s| s.bg(accent))
                .tooltip(|window, cx| Tooltip::new(t("agentChooseHarness")).build(window, cx))
                .child(harness_logo_element(&harness, sp(3.5), tk.muted_foreground))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.session_menu = !this.session_menu;
                    cx.notify();
                })),
        );
        if open {
            el = el.child(self.session_menu(cx));
        }
        el.into_any_element()
    }

    fn session_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let core = cx.core();
        let store = core.use_::<AgentStoreModule>();
        let agents = core.use_::<AgentsModule>();
        let peeked = self.widget(cx).bound_task_id.clone().or_else(|| sessions::peek(&self.workspace_path, cx));
        let sessions: Vec<AgentTaskRow> = store
            .tasks_for_workspace(&self.workspace_path)
            .into_iter()
            .filter(|r| !matches!(r.status, TaskStatus::Error | TaskStatus::Cancelled | TaskStatus::Unavailable))
            .take(5)
            .collect();
        let default = default_harness(cx);
        let mut harnesses: Vec<(String, String)> = Vec::new();
        let mut active: Vec<notefig_agent::harness::HarnessDefinition> = agents.pickable_harnesses();
        if active.is_empty() {
            active = notefig_agent::harness::built_in_harnesses();
        }
        if let Some(d) = default.as_ref().and_then(|d| active.iter().find(|h| &h.id == d)) {
            harnesses.push((d.id.clone(), d.label.clone()));
        }
        for h in &active {
            if !harnesses.iter().any(|(id, _)| *id == h.id) {
                harnesses.push((h.id.clone(), h.label.clone()));
            }
        }
        let mut menu = style::popover_frame(cx).min_w(sp(56.)).p(sp(1.)).on_mouse_down_out(cx.listener(|this, _, _, cx| {
            this.session_menu = false;
            cx.notify();
        }));
        for (ix, row) in sessions.iter().enumerate() {
            let task = row.task_id.clone();
            menu = menu.child(
                style::menu_item(ElementId::Name(format!("sess-{}-{ix}", self.blob_id).into()), false, cx)
                    .text_size(tk.text_xs)
                    .child(if peeked.as_deref() == Some(row.task_id.as_str()) {
                        icon("check").size(sp(3.)).text_color(tk.foreground).into_any_element()
                    } else {
                        harness_logo_element(&row.harness_id, sp(3.), tk.foreground)
                    })
                    .child(div().min_w_0().flex_1().truncate().child(row.title.clone()))
                    .child(div().flex_none().text_size(text_11()).text_color(tk.muted_foreground).child(time_ago(row.updated_at)))
                    .on_click(cx.listener(move |this, _, window, cx| this.select_session(&task, window, cx))),
            );
        }
        if !sessions.is_empty() {
            menu = menu.child(div().my(sp(1.)).child(style::rule(cx)));
        }
        for (ix, (id, label)) in harnesses.into_iter().take(3).enumerate() {
            menu = menu.child(
                style::menu_item(ElementId::Name(format!("new-{}-{ix}", self.blob_id).into()), false, cx)
                    .text_size(tk.text_xs)
                    .child(harness_logo_element(&id, sp(3.), tk.muted_foreground))
                    .child(t_args("promptBlobNewSessionWith", &[("harness", &label)]))
                    .on_click(cx.listener(move |this, _, window, cx| this.new_conversation(&id, window, cx))),
            );
        }
        style::anchored_popover(PopoverSide::BelowStart, menu)
    }

    /// `DraftRow`: the field (hidden while it takes no typing), with the
    /// session control while composing and the trust warning under it.
    fn draft_row(&self, phase: BlobPhase, editable: bool, confirm_trust: bool, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let composing = phase == BlobPhase::Composing;
        if !editable {
            return div().into_any_element();
        }
        let field = div()
            .id(ElementId::Name(format!("draft-{}", self.blob_id).into()))
            .relative()
            .min_w_0()
            .flex_1()
            .map(|d| if composing { d.pt(sp(1.)).pb(sp(1.5)) } else { d })
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| this.on_key(e, window, cx)))
            .child(self.draft.clone());
        let harness_label = self.harness_label(&self.target_harness(cx), cx);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(sp(1.5))
                    .map(|d| {
                        if composing {
                            d.px(sp(1.5)).py(sp(1.))
                        } else {
                            d.mt(sp(1.)).border_t_1().border_color(tk.border.opacity(0.6)).px(sp(2.5)).pt(sp(1.5)).pb(sp(1.))
                        }
                    })
                    .when(composing, |d| d.child(self.session_control(cx)))
                    .child(field),
            )
            .when(composing && confirm_trust, |d| {
                d.child(
                    div()
                        .px(sp(3.))
                        .pb(sp(1.5))
                        .text_size(text_11())
                        .text_color(tk.warning)
                        .child(t_args("promptBlobTrustWarning", &[("name", &harness_label)])),
                )
            })
            .into_any_element()
    }
}

/// The bound round as the face reads it.
struct RoundView {
    task: Option<AgentTaskRow>,
    queue_ahead: usize,
    active_tool_line: Option<String>,
    teaser: Option<String>,
    error: Option<String>,
}

fn round_view(blob_id: &str, widget: &PromptWidget, cx: &App) -> Option<RoundView> {
    let snapshot = prompts(cx).round(blob_id)?;
    let turn_id = widget.bound_turn_id.clone().unwrap_or_default();
    let entries: Vec<AgentEntry> = widget
        .bound_task_id
        .as_ref()
        .map(|t| cx.core().use_::<AgentStoreModule>().entries(t))
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.turn_id == turn_id)
        .collect();
    Some(RoundView {
        task: snapshot.task.clone(),
        queue_ahead: derive_queue_position(&snapshot.task_turns, &turn_id),
        active_tool_line: derive_active_tool_line(&entries),
        teaser: derive_latest_assistant_line(&entries),
        error: snapshot.turn.as_ref().and_then(|t| t.error.clone()),
    })
}

/// A short content hash for review fingerprints (FNV-1a, hex).
fn md5_like(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

impl Render for PromptWidgetView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(cx);
        let tk = tokens(cx).clone();
        let widget = self.widget(cx);
        let phase = phase_of(widget.state);
        let caps = capabilities_of(widget.state, self.summoned);
        let round = round_view(&self.blob_id, &widget, cx);
        // A done round in view has been seen (the TS minimap's
        // IntersectionObserver; a node view renders only while laid out).
        if phase == BlobPhase::Done && widget.bound_turn_id.is_some() && widget.seen_turn_id != widget.bound_turn_id {
            prompts(cx).mark_seen(&self.blob_id);
        }
        let has_issue = widget.outcome.as_ref().and_then(|o| o.response.as_ref()).is_some_and(|r| r.kind == "issue");
        let (border, bg, raised) = match card_tone(phase, has_issue) {
            CardTone::Resting => (tk.border.opacity(0.6), tk.card.opacity(0.8), false),
            CardTone::RestingIssue => (tk.warning.opacity(0.4), tk.card.opacity(0.8), false),
            CardTone::Warning => (tk.warning.opacity(0.4), tint_over(tk.background, tk.warning, 0.1), true),
            CardTone::Attention => (tk.border, tint_over(tk.background, tk.muted, 0.4), true),
            CardTone::Raised => (tk.border, tk.card, true),
        };
        let reference = self.reference_chip(phase, cx);
        let sent = self.sent_face(phase, &widget, round.as_ref(), cx);
        let settled = match phase {
            BlobPhase::Done | BlobPhase::NeedsAnswer => Some(self.done_face(phase, &widget, round.as_ref(), cx)),
            BlobPhase::Error => {
                let message = widget.outcome.as_ref().and_then(|o| o.error.clone()).or_else(|| round.as_ref().and_then(|r| r.error.clone()));
                Some(self.error_face(message, cx))
            }
            _ => None,
        };
        let now = notefig_core_now();
        let refused = widget.removal_refused_at.is_some_and(|at| now - at < REMOVAL_REFUSED_HINT_MS);
        let confirm_trust = matches!(widget.state, WidgetState::Composing { confirming_trust: true });
        let draft = self.draft_row(phase, caps.field_editable, confirm_trust, cx);
        // `FaceFrame`: the card, which a refused delete shakes.
        let card = div()
            .relative()
            .rounded(tk.radius_lg)
            .border_1()
            .border_color(border)
            .bg(bg)
            .when(raised, |d| d.shadow_lg())
            .children(reference)
            .children(sent)
            .children(settled)
            .when(refused, |d| {
                d.child(div().px(sp(2.5)).pb(sp(1.5)).text_size(text_11()).text_color(tk.muted_foreground).child(t("promptBlobStopToRemove")))
            })
            .child(draft);
        // `useShakeOn`: keyed by the refusal's stamp, so each refused
        // attempt plays it again. (TS skips it under reduced motion; GPUI
        // exposes no such preference.)
        let card = match shake_due(widget.removal_refused_at, now) {
            Some(at) => card
                .with_animation(
                    ElementId::NamedInteger(format!("prompt-shake-{}", self.blob_id).into(), at as u64),
                    Animation::new(Duration::from_millis(SHAKE_MS)).with_easing(gpui::ease_in_out),
                    |card, t| card.left(gpui::px(shake_offset(t))),
                )
                .into_any_element(),
            None => card.into_any_element(),
        };
        div()
            .id(ElementId::Name(format!("prompt-widget-{}", self.blob_id).into()))
            .relative()
            .w_full()
            .my(sp(1.))
            .font_family(notefig_ui::theme::FONT_SANS)
            .text_color(tk.foreground)
            // The widget claims its pointer events: the editor must not turn
            // clicks on its controls into node selections.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(card)
    }
}

fn notefig_core_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
