//! The in-document prompt widget (`packages/widgets/src/prompt`): a node
//! view with its own composer, bound to the workspace's shared session.
//!
//! State machine (`machine.ts`): composing{confirmingTrust} → sending →
//! working{queued|running} → asking{permission|auth|question} →
//! settled{done|error|cancelled}. The agent side of a round arrives as
//! [`RoundFacts`] and [`state_from_round`] is the one place they become a
//! state. Answers come from `widget_respond` (the round's outcome).

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled,
    Subscription, WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme as _, IconName, Sizable as _, h_flex, v_flex};
use markdown_editor::{BlockEditorState, NodeViewCtx, PromptWidget, RoundId};
use notefig_agent::prompt::WidgetPromptSource;
use notefig_agent::rounds::{PromptRoundRow, RoundOutcome};
use notefig_agent::{PermissionOutcome, RoundStarted, TaskStatus, TurnStatus};

use super::Agents;
use super::composer::{Composer, ComposerEvent, compose_message};
use super::glyph;
use crate::theme::BrandColors;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Permission,
    Auth,
    Question,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Error,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetState {
    Composing { confirming_trust: bool },
    Sending,
    Working { queued: bool },
    Asking(Ask),
    Settled(Outcome),
}

pub const COMPOSING: WidgetState = WidgetState::Composing {
    confirming_trust: false,
};

/// The agent's side of a bound round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoundFacts {
    pub turn: Option<TurnStatus>,
    pub auth_required: bool,
    pub pending_permission: bool,
    pub awaiting_reply: bool,
}

/// `stateFromRound`: sign-in outranks the turn's own status.
pub fn state_from_round(f: RoundFacts) -> WidgetState {
    let Some(turn) = f.turn else { return COMPOSING };
    if f.auth_required && turn != TurnStatus::Completed {
        return WidgetState::Asking(Ask::Auth);
    }
    match turn {
        TurnStatus::Queued => WidgetState::Working { queued: true },
        TurnStatus::Running if f.pending_permission => WidgetState::Asking(Ask::Permission),
        TurnStatus::Running => WidgetState::Working { queued: false },
        TurnStatus::Error => WidgetState::Settled(Outcome::Error),
        TurnStatus::Completed if f.awaiting_reply => WidgetState::Asking(Ask::Question),
        TurnStatus::Completed => WidgetState::Settled(Outcome::Done),
        TurnStatus::Cancelled => WidgetState::Settled(Outcome::Cancelled),
    }
}

/// Whether the field takes typing (a prompt, a reply, an answer).
pub fn field_editable(state: WidgetState) -> bool {
    matches!(
        state,
        WidgetState::Composing { .. } | WidgetState::Settled(_) | WidgetState::Asking(Ask::Question)
    )
}

pub enum WidgetEvent {
    /// Open a touched file and step to its first change of this round.
    OpenChanges { abs: PathBuf, round: RoundId },
}

/// Where the widget lives: the document and workspace it belongs to.
#[derive(Clone)]
pub struct WidgetHost {
    pub agents: Entity<Agents>,
    pub root: PathBuf,
    /// Workspace-relative path, read at send time (renames move it).
    pub rel: Rc<RefCell<String>>,
    pub files: Rc<RefCell<Vec<String>>>,
}

pub struct PromptWidgetView {
    pub id: SharedString,
    host: WidgetHost,
    editor: WeakEntity<BlockEditorState>,
    pub task_id: Option<String>,
    pub turn_id: Option<String>,
    pub state: WidgetState,
    /// What was sent (shown while the round runs).
    sent: Option<String>,
    pub composer: Entity<Composer>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<WidgetEvent> for PromptWidgetView {}

impl PromptWidgetView {
    pub fn new(
        id: SharedString,
        task: Option<SharedString>,
        host: WidgetHost,
        editor: WeakEntity<BlockEditorState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let composer = cx.new(|cx| {
            let mut c = Composer::new("Ask AI to write or edit… (@ to mention)", window, cx);
            c.set_files(host.files.borrow().clone());
            c
        });
        let subs = vec![
            cx.observe(&host.agents, |this: &mut Self, _, cx| this.round_changed(cx)),
            cx.subscribe_in(&composer, window, |this, _, event, window, cx| match event {
                ComposerEvent::Submit => this.send(window, cx),
                ComposerEvent::Cancel => this.escape(window, cx),
                ComposerEvent::Changed => {}
            }),
        ];
        let mut this = Self {
            id,
            host,
            editor,
            task_id: task.map(|t| t.to_string()),
            turn_id: None,
            state: COMPOSING,
            sent: None,
            composer,
            _subs: subs,
        };
        // A bound widget (marker on disk) picks its newest round back up.
        if let Some(round) = this.newest_round(cx) {
            this.turn_id = Some(round.turn_id.clone());
            this.task_id = Some(round.task_id.clone());
            this.sent = round.typed_prompt.clone().or(Some(round.prompt.clone()));
        }
        this.round_changed(cx);
        this
    }

    fn workspace(&self) -> String {
        self.host.root.to_string_lossy().into_owned()
    }

    fn abs_path(&self) -> PathBuf {
        self.host.root.join(&*self.host.rel.borrow())
    }

    fn newest_round(&self, cx: &App) -> Option<PromptRoundRow> {
        let rounds = self.host.agents.read(cx).handle.prompt_rounds();
        rounds
            .into_iter()
            .filter(|r| r.blob_id.as_deref() == Some(self.id.as_ref()))
            .max_by_key(|r| r.started_at)
    }

    fn round(&self, cx: &App) -> Option<PromptRoundRow> {
        let turn = self.turn_id.as_ref()?;
        self.host
            .agents
            .read(cx)
            .handle
            .prompt_rounds()
            .into_iter()
            .find(|r| &r.turn_id == turn)
    }

    pub fn facts(&self, cx: &App) -> RoundFacts {
        let handle = &self.host.agents.read(cx).handle;
        let (Some(task), Some(turn_id)) = (&self.task_id, &self.turn_id) else {
            return RoundFacts {
                turn: None,
                auth_required: false,
                pending_permission: false,
                awaiting_reply: false,
            };
        };
        let turn = handle.turns(task).into_iter().find(|t| &t.turn_id == turn_id).map(|t| t.status);
        // A settled round whose turn row is gone still shows its outcome.
        let round = self.round(cx);
        let turn = turn.or_else(|| {
            round.as_ref().and_then(|r| match r.status {
                notefig_agent::rounds::RoundStatus::Completed => Some(TurnStatus::Completed),
                notefig_agent::rounds::RoundStatus::Cancelled => Some(TurnStatus::Cancelled),
                notefig_agent::rounds::RoundStatus::Error => Some(TurnStatus::Error),
                notefig_agent::rounds::RoundStatus::Live => None,
            })
        });
        let row = handle.task(task);
        RoundFacts {
            turn,
            auth_required: row.as_ref().is_some_and(|r| r.auth_required),
            pending_permission: !handle.pending_permissions(task).is_empty(),
            awaiting_reply: round
                .and_then(|r| r.outcome)
                .and_then(|o| o.response)
                .is_some_and(|r| r.awaits_reply()),
        }
    }

    fn round_changed(&mut self, cx: &mut Context<Self>) {
        if matches!(self.state, WidgetState::Sending) {
            return;
        }
        if self.turn_id.is_none() {
            if !matches!(self.state, WidgetState::Composing { .. }) {
                self.state = COMPOSING;
                cx.notify();
            }
            return;
        }
        let next = state_from_round(self.facts(cx));
        if next != self.state {
            let was_live = matches!(self.state, WidgetState::Working { .. } | WidgetState::Asking(Ask::Permission));
            self.state = next;
            if was_live && matches!(next, WidgetState::Settled(_) | WidgetState::Asking(Ask::Question)) {
                self.save_review_ranges(cx);
            }
            cx.notify();
        }
    }

    /// Persist this round's tracked spans in the document as review ranges.
    fn save_review_ranges(&mut self, cx: &mut Context<Self>) {
        let (Some(turn), Some(editor)) = (self.turn_id.clone(), self.editor.upgrade()) else {
            return;
        };
        let round = self.host.agents.update(cx, |a, _| a.round_id(&turn));
        let state = editor.read(cx);
        let model = state.model();
        let ranges: Vec<(String, notefig_agent::rounds::ChangeRange)> = state
            .tracked_changes(round)
            .into_iter()
            .filter_map(|c| {
                let from = model.pm_from_position(markdown_editor::BlockPosition::new(c.block, c.range.start))?;
                let to = model.pm_from_position(markdown_editor::BlockPosition::new(c.block, c.range.end))?;
                Some((turn.clone(), notefig_agent::rounds::ChangeRange { from: from as i64, to: to as i64 }))
            })
            .collect();
        if ranges.is_empty() {
            return;
        }
        let fingerprint = notefig_agent::rounds::content_hash(&state.source());
        let doc = self.abs_path().to_string_lossy().into_owned();
        self.host.agents.read(cx).handle.save_round_changes(&doc, &fingerprint, ranges);
    }

    /// Send the field: a prompt, a reply or an answer.
    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !field_editable(self.state) {
            return;
        }
        let text = self.composer.read(cx).text(cx);
        if text.is_empty() {
            return;
        }
        self.send_text(text, window, cx);
    }

    pub fn send_text(&mut self, text: String, _: &mut Window, cx: &mut Context<Self>) {
        let handle = self.host.agents.read(cx).handle.clone();
        let ws = self.workspace();
        if !handle.is_trusted_persisted(&ws) {
            match self.state {
                WidgetState::Composing { confirming_trust: true } => handle.trust(&ws),
                _ => {
                    self.state = WidgetState::Composing { confirming_trust: true };
                    cx.notify();
                    return;
                }
            }
        }
        let Some(harness) = self.host.agents.read(cx).default_harness(&ws) else {
            self.state = WidgetState::Settled(Outcome::Error);
            self.sent = Some("No agent harness is available. Install one and rescan in Settings.".into());
            cx.notify();
            return;
        };
        self.state = WidgetState::Sending;
        self.sent = Some(text.clone());
        self.composer.update(cx, |c, cx| c.clear(cx));
        cx.notify();
        let (message, extras) = compose_message(&text, &self.host.root);
        let rel = self.host.rel.borrow().clone();
        let abs = self.abs_path().to_string_lossy().into_owned();
        let id = self.id.clone();
        let (pos, is_doc_empty) = self
            .editor
            .upgrade()
            .map(|e| {
                let state = e.read(cx);
                let model = state.model();
                let pos = model
                    .find_prompt_widget(&id)
                    .and_then(|b| model.pm_from_position(markdown_editor::BlockPosition::new(b, 0)))
                    .unwrap_or(0);
                let empty = state.source().lines().all(|l| l.trim().is_empty() || l.trim_start().starts_with("<!-- notefig:prompt"));
                (pos, empty)
            })
            .unwrap_or((0, false));
        cx.spawn(async move |this, cx| {
            let task = match handle.shared_session(&ws, &harness).recv().await {
                Some(Ok(task)) => task,
                other => {
                    log::warn!("widget session failed: {other:?}");
                    let _ = this.update(cx, |this, cx| {
                        this.state = COMPOSING;
                        if let Some(sent) = this.sent.take() {
                            this.composer.update(cx, |c, cx| c.set_text(&sent, cx));
                        }
                        cx.notify();
                    });
                    return;
                }
            };
            // Bind the widget: its marker now names the session.
            let _ = this.update(cx, |this, cx| {
                this.task_id = Some(task.clone());
                if let Some(editor) = this.editor.upgrade() {
                    let id = this.id.clone();
                    editor.update(cx, |e, cx| {
                        if let Some(block) = e.model().find_prompt_widget(&id) {
                            let _ = e.set_prompt_widget(
                                block,
                                PromptWidget {
                                    id: id.clone(),
                                    task: Some(task.clone().into()),
                                },
                                cx,
                            );
                        }
                    });
                }
            });
            let source = WidgetPromptSource {
                workspace_path: ws.clone(),
                path: rel,
                pos: pos as i64,
                is_doc_empty,
                reference: None,
            };
            let Some(prompt) = handle.prompt_from_widget(&task, &message, source, extras).recv().await else {
                return;
            };
            handle.record_round_started(RoundStarted {
                turn_id: prompt.turn_id.clone(),
                task_id: task.clone(),
                workspace_path: ws.clone(),
                document_path: abs,
                prompt: message.clone(),
                blob_id: Some(id.to_string()),
                typed_prompt: Some(text.clone()),
            });
            let _ = this.update(cx, |this, cx| {
                this.turn_id = Some(prompt.turn_id.clone());
                // The round is tracked from its first write.
                let round = this.host.agents.update(cx, |a, _| a.round_id(&prompt.turn_id));
                if let Some(editor) = this.editor.upgrade() {
                    let brand = BrandColors::get(cx).brand;
                    editor.update(cx, |e, cx| {
                        e.track_changes(round);
                        e.set_change_gutter(Some((round, brand)), cx);
                    });
                }
                this.state = state_from_round(RoundFacts {
                    turn: Some(TurnStatus::Queued),
                    ..this.facts(cx)
                });
                this.round_changed(cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(task) = &self.task_id {
            let _ = self.host.agents.read(cx).handle.cancel(task);
        }
    }

    /// Escape: a running round is cancelled; otherwise focus goes back to
    /// the document after the widget.
    fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.state, WidgetState::Working { .. } | WidgetState::Asking(Ask::Permission)) {
            self.stop(cx);
            return;
        }
        if let Some(editor) = self.editor.upgrade() {
            let id = self.id.clone();
            editor.update(cx, |e, cx| {
                if let Some(block) = e.model().find_prompt_widget(&id) {
                    e.focus_after_widget(block, window, cx);
                }
                e.focus(window, cx);
            });
        }
    }

    /// Remove the widget (Edit/dismiss): an unbound one reverts to `/`.
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        if let Some(editor) = self.editor.upgrade() {
            let id = self.id.clone();
            editor.update(cx, |e, cx| {
                if let Some(block) = e.model().find_prompt_widget(&id) {
                    let _ = e.remove_prompt_widget(block, None, cx);
                }
            });
        }
    }

    fn render_outcome(&self, outcome: &RoundOutcome, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let mut col = v_flex().gap_2();
        if let Some(response) = &outcome.response {
            let is_issue = response.kind == "issue";
            col = col
                .when_some(response.title.clone(), |this, title| {
                    this.child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD).child(title))
                })
                .child(
                    div()
                        .when(is_issue, |d| d.pl_2().border_l_2().border_color(brand.warning))
                        .child(TextView::markdown(SharedString::from(format!("wr-{}", self.id)), response.markdown.clone()).selectable(true)),
                );
            if let Some(options) = &response.options {
                let multiple = response.kind == "multiple_choice";
                col = col.child(v_flex().gap_1().children(options.iter().enumerate().map(|(ix, opt)| {
                    let opt2 = opt.clone();
                    Button::new(SharedString::from(format!("wopt-{}-{ix}", self.id)))
                        .label(format!("{}. {opt}", ix + 1))
                        .small()
                        .outline()
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if multiple {
                                // Collect choices in the field; Send answers.
                                let current = this.composer.read(cx).text(cx);
                                let next = if current.is_empty() { opt2.clone() } else { format!("{current}, {opt2}") };
                                this.composer.update(cx, |c, cx| c.set_text(&next, cx));
                            } else {
                                this.send_text(opt2.clone(), window, cx);
                            }
                        }))
                })));
            }
        } else if let Some(summary) = &outcome.summary {
            col = col.child(TextView::markdown(SharedString::from(format!("ws-{}", self.id)), summary.clone()).selectable(true));
        }
        if let Some(err) = &outcome.error {
            col = col.child(div().text_sm().text_color(brand.warning).child(err.clone()));
        }
        if !outcome.touched_files.is_empty() {
            let round = self.turn_id.clone();
            col = col.child(h_flex().flex_wrap().gap_1().children(outcome.touched_files.iter().enumerate().map(|(ix, f)| {
                let abs = PathBuf::from(f);
                let label = abs
                    .strip_prefix(&self.host.root)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| f.clone());
                let round = round.clone();
                div()
                    .id(SharedString::from(format!("wfile-{}-{ix}", self.id)))
                    .px_1p5()
                    .rounded_sm()
                    .text_xs()
                    .bg(theme.muted)
                    .cursor_pointer()
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(turn) = &round {
                            let round = this.host.agents.update(cx, |a, _| a.round_id(turn));
                            cx.emit(WidgetEvent::OpenChanges { abs: abs.clone(), round });
                        }
                    }))
            })));
        }
        col.into_any_element()
    }
}

impl Render for PromptWidgetView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let state = self.state;
        let handle = self.host.agents.read(cx).handle.clone();
        let task = self.task_id.clone();
        let row = task.as_ref().and_then(|t| handle.task(t));
        let status_label = match state {
            WidgetState::Composing { .. } => "",
            WidgetState::Sending => "Sending…",
            WidgetState::Working { queued: true } => "Queued",
            WidgetState::Working { queued: false } => "Working…",
            WidgetState::Asking(Ask::Permission) => "Needs your permission",
            WidgetState::Asking(Ask::Auth) => "Sign in to continue",
            WidgetState::Asking(Ask::Question) => "The agent asks",
            WidgetState::Settled(Outcome::Done) => "Done",
            WidgetState::Settled(Outcome::Error) => "Error",
            WidgetState::Settled(Outcome::Cancelled) => "Cancelled",
        };
        let outcome = self.round(cx).and_then(|r| r.outcome);
        let moving = matches!(state, WidgetState::Sending | WidgetState::Working { .. });
        let mut body = v_flex().gap_2();
        if let Some(sent) = self.sent.clone().filter(|_| !matches!(state, WidgetState::Composing { .. })) {
            body = body.child(div().text_sm().text_color(theme.muted_foreground).child(sent));
        }
        match state {
            WidgetState::Asking(Ask::Permission) => {
                if let Some(req) = task.as_ref().and_then(|t| handle.pending_permissions(t).into_iter().next()) {
                    body = body
                        .child(div().text_sm().child(req.title.clone()))
                        .child(h_flex().gap_1().children(req.options.iter().map(|o| {
                            let (h, t, r, oid) = (handle.clone(), req.task_id.clone(), req.id.clone(), o.option_id.clone());
                            let b = Button::new(SharedString::from(format!("wperm-{}", o.option_id)))
                                .label(o.name.clone())
                                .xsmall();
                            let b = if o.kind.starts_with("allow") { b.primary() } else { b.ghost() };
                            b.on_click(move |_, _, _| {
                                let _ = h.respond_permission(&t, &r, PermissionOutcome::Selected(oid.clone()));
                            })
                        })));
                }
            }
            WidgetState::Asking(Ask::Auth) => {
                let methods = row.as_ref().map(|r| r.auth_methods.clone()).unwrap_or_default();
                body = body
                    .when_some(row.as_ref().and_then(|r| r.auth_hint.clone()), |this, hint| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(hint))
                    })
                    .child(h_flex().gap_1().children(methods.into_iter().map(|m| {
                        let (h, t, mid) = (handle.clone(), task.clone().unwrap_or_default(), m.id.clone());
                        Button::new(SharedString::from(format!("wauth-{}", m.id)))
                            .label(if m.name.is_empty() { m.id.clone() } else { m.name.clone() })
                            .xsmall()
                            .outline()
                            .on_click(move |_, _, _| {
                                let _ = h.authenticate(&t, &mid);
                            })
                    })))
                    .child({
                        let (h, t) = (handle.clone(), task.clone().unwrap_or_default());
                        Button::new("wauth-retry").label("I've signed in").xsmall().primary().on_click(move |_, _, _| {
                            let _ = h.retry_after_auth(&t);
                        })
                    });
            }
            _ => {}
        }
        if let Some(outcome) = outcome.as_ref().filter(|_| matches!(state, WidgetState::Settled(_) | WidgetState::Asking(Ask::Question))) {
            body = body.child(self.render_outcome(outcome, cx));
        } else if let (WidgetState::Settled(Outcome::Error), Some(row)) = (state, row.as_ref()) {
            if row.status == TaskStatus::Error {
                body = body.child(div().text_sm().text_color(brand.warning).child("The session failed to start."));
            }
        }
        if let WidgetState::Composing { confirming_trust: true } = state {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(brand.warning)
                    .child("Agents will be able to read and change files in this folder and run commands. Send again to trust it."),
            );
        }
        let editable = field_editable(state);
        v_flex()
            .id(SharedString::from(format!("widget-{}", self.id)))
            .my_1()
            .p_3()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_color(if moving { brand.brand } else { theme.border })
            .bg(theme.secondary.opacity(0.5))
            .child(
                h_flex()
                    .gap_2()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(div().text_color(brand.brand).child("✦ AI"))
                    .when(moving, |this| this.child(glyph::render(glyph::Glyph::Moving, format!("wg-{}", self.id), cx)))
                    .child(div().flex_1().child(status_label))
                    .when(moving, |this| {
                        this.child(Button::new("wstop").label("Stop").xsmall().ghost().on_click(cx.listener(|this, _, _, cx| this.stop(cx))))
                    })
                    .child(
                        Button::new("wclose")
                            .icon(IconName::Close)
                            .xsmall()
                            .ghost()
                            .tooltip("Remove")
                            .on_click(cx.listener(|this, _, _, cx| this.dismiss(cx))),
                    ),
            )
            .child(body)
            .when(editable, |this| {
                this.child(
                    h_flex()
                        .gap_2()
                        .items_end()
                        .child(
                            div()
                                .flex_1()
                                .rounded_md()
                                .border_1()
                                .border_color(theme.input)
                                .bg(theme.background)
                                .child(self.composer.clone()),
                        )
                        .child(
                            Button::new("wsend")
                                .label(match state {
                                    WidgetState::Composing { .. } => "Send",
                                    _ => "Reply",
                                })
                                .xsmall()
                                .primary()
                                .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                        ),
                )
            })
            .max_w(px(760.))
    }
}

/// Per-document registry of widget views, used by the editor's node-view
/// renderer (views are created on first render and kept by widget id).
#[derive(Clone)]
pub struct WidgetRegistry {
    pub views: Rc<RefCell<HashMap<SharedString, Entity<PromptWidgetView>>>>,
    /// Focus the composer of this widget when it first renders.
    pub focus_next: Rc<RefCell<Option<SharedString>>>,
    pub host: WidgetHost,
    /// Notified with each new view (the workspace subscribes to its events).
    pub on_new: Rc<RefCell<Option<Box<dyn Fn(&Entity<PromptWidgetView>, &mut Window, &mut App)>>>>,
}

impl WidgetRegistry {
    pub fn new(host: WidgetHost) -> Self {
        Self {
            views: Default::default(),
            focus_next: Default::default(),
            host,
            on_new: Default::default(),
        }
    }

    /// The renderer to hand `BlockEditorState::set_node_view_renderer`.
    pub fn renderer(&self) -> impl Fn(&NodeViewCtx, &mut Window, &mut App) -> AnyElement + 'static {
        let reg = self.clone();
        move |ctx, window, cx| {
            let existing = reg.views.borrow().get(&ctx.widget.id).cloned();
            let view = match existing {
                Some(v) => v,
                None => {
                    let host = reg.host.clone();
                    let (id, task, editor) = (ctx.widget.id.clone(), ctx.widget.task.clone(), ctx.editor.clone());
                    let v = cx.new(|cx| PromptWidgetView::new(id, task, host, editor, window, cx));
                    reg.views.borrow_mut().insert(ctx.widget.id.clone(), v.clone());
                    if let Some(f) = reg.on_new.borrow().as_ref() {
                        f(&v, window, cx);
                    }
                    v
                }
            };
            if reg.focus_next.borrow().as_ref() == Some(&ctx.widget.id) {
                reg.focus_next.borrow_mut().take();
                let composer = view.read(cx).composer.clone();
                Composer::focus(&composer, window, cx);
            }
            view.into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(turn: Option<TurnStatus>) -> RoundFacts {
        RoundFacts {
            turn,
            auth_required: false,
            pending_permission: false,
            awaiting_reply: false,
        }
    }

    #[test]
    fn machine() {
        assert_eq!(state_from_round(facts(None)), COMPOSING);
        assert_eq!(state_from_round(facts(Some(TurnStatus::Queued))), WidgetState::Working { queued: true });
        assert_eq!(
            state_from_round(RoundFacts { pending_permission: true, ..facts(Some(TurnStatus::Running)) }),
            WidgetState::Asking(Ask::Permission)
        );
        assert_eq!(
            state_from_round(RoundFacts { auth_required: true, ..facts(Some(TurnStatus::Error)) }),
            WidgetState::Asking(Ask::Auth)
        );
        assert_eq!(
            state_from_round(RoundFacts { awaiting_reply: true, ..facts(Some(TurnStatus::Completed)) }),
            WidgetState::Asking(Ask::Question)
        );
        assert_eq!(state_from_round(facts(Some(TurnStatus::Completed))), WidgetState::Settled(Outcome::Done));
        assert_eq!(state_from_round(facts(Some(TurnStatus::Cancelled))), WidgetState::Settled(Outcome::Cancelled));
        assert!(field_editable(WidgetState::Asking(Ask::Question)));
        assert!(!field_editable(WidgetState::Working { queued: false }));
    }
}
