//! Document history (spec 03): one hidden git repo per workspace
//! (`notefig-history`, gitdir `<ws>/.notefig/.git`), the sidebar checkpoint
//! panel, the agent `history_*` tools and the after-every-turn checkpoint.
//!
//! Every repo call blocks, so it runs on the background executor. Refresh is
//! single-flight (one task; a dirty flag re-runs once), and a write bumps a
//! generation so an older fetch never lands after it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    App, AppContext as _, ClipboardItem, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Subscription,
    Task, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, IconName, Sizable as _, h_flex, v_flex};
use notefig_agent::AgentEvent;
use notefig_history::{Checkpoint, GixHistoryRepo, HistoryError, HistoryErrorCode, HistoryRepo, RepoStatus, Signature};

use crate::agents::{Agents, AgentsChanged};
use crate::theme::BrandColors;

const STALE_DEBOUNCE: Duration = Duration::from_millis(500);
const LOG_DEPTH: usize = 100;

/// Every open workspace's repo, for the agent tools.
#[derive(Clone, Default)]
pub struct HistoryRepos(pub Rc<RefCell<HashMap<PathBuf, Arc<dyn HistoryRepo>>>>);

impl HistoryRepos {
    pub fn get(&self, root: &Path) -> Arc<dyn HistoryRepo> {
        let canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if let Some(repo) = self.0.borrow().get(&canon) {
            return repo.clone();
        }
        Arc::new(GixHistoryRepo::new(canon))
    }
}

/// What the panel shows (`PanelState`).
#[derive(Clone, Debug, PartialEq)]
pub enum PanelState {
    Uninitialized,
    Error(String),
    Empty,
    Ready,
}

#[derive(Clone, Default)]
struct Snapshot {
    initialized: bool,
    status: Option<RepoStatus>,
    checkpoints: Vec<Checkpoint>,
    error: Option<HistoryError>,
}

pub struct WorkspaceHistory {
    pub repo: Arc<dyn HistoryRepo>,
    snapshot: Snapshot,
    /// The state rendered while a fetch is in flight (anti-flicker).
    shown: Option<PanelState>,
    pub fetching: bool,
    dirty: bool,
    generation: u64,
    refresh_task: Option<Task<()>>,
    stale_task: Option<Task<()>>,
    pub saving: bool,
    pub reverting: bool,
    revert_error: Option<HistoryError>,
    describe: Option<Entity<InputState>>,
    _subs: Vec<Subscription>,
}

impl WorkspaceHistory {
    pub fn new(root: &Path, repo: Arc<dyn HistoryRepo>, cx: &mut Context<Self>) -> Self {
        let mut subs = Vec::new();
        if let Some(agents) = Agents::global(cx) {
            let repos = agents.read(cx).history.clone();
            repos.0.borrow_mut().insert(root.to_path_buf(), repo.clone());
            let root = root.to_string_lossy().into_owned();
            subs.push(cx.subscribe(&agents, move |this: &mut Self, _, event: &AgentsChanged, cx| {
                for e in event.0.iter() {
                    if let AgentEvent::TurnCompleted { workspace_path, prompt, harness_id, .. } = e {
                        if workspace_path.trim_end_matches('/') == root.trim_end_matches('/') {
                            this.turn_checkpoint(prompt.clone(), harness_id.clone(), cx);
                        }
                    }
                }
            }));
        }
        let mut this = Self {
            repo,
            snapshot: Snapshot::default(),
            shown: None,
            fetching: false,
            dirty: false,
            generation: 0,
            refresh_task: None,
            stale_task: None,
            saving: false,
            reverting: false,
            revert_error: None,
            describe: None,
            _subs: subs,
        };
        this.refresh(cx);
        this
    }

    pub fn checkpoints(&self) -> &[Checkpoint] {
        &self.snapshot.checkpoints
    }

    pub fn has_changes(&self) -> bool {
        self.snapshot.status.as_ref().is_some_and(|s| s.has_changes())
    }

    pub fn state(&self) -> PanelState {
        let s = &self.snapshot;
        match (&s.error, s.initialized) {
            (Some(e), _) if e.code != HistoryErrorCode::RepoNotFound => PanelState::Error(e.message.clone()),
            (_, false) => PanelState::Uninitialized,
            _ if s.checkpoints.is_empty() => PanelState::Empty,
            _ => PanelState::Ready,
        }
    }

    /// Single-flight status + log fetch.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.refresh_task.is_some() {
            self.dirty = true;
            return;
        }
        self.fetching = true;
        self.shown = Some(self.state());
        let repo = self.repo.clone();
        let generation = self.generation;
        self.refresh_task = Some(cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_executor()
                .spawn(async move {
                    let initialized = repo.is_initialized();
                    if !initialized {
                        return Snapshot::default();
                    }
                    let mut snap = Snapshot {
                        initialized,
                        ..Default::default()
                    };
                    match repo.status() {
                        Ok(s) => snap.status = Some(s),
                        Err(e) => snap.error = Some(e),
                    }
                    match repo.log(Some(LOG_DEPTH), None) {
                        Ok(log) => snap.checkpoints = log,
                        Err(e) => snap.error = snap.error.or(Some(e)),
                    }
                    snap
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.refresh_task = None;
                if this.generation == generation {
                    this.snapshot = snapshot;
                }
                this.fetching = false;
                this.shown = None;
                if std::mem::take(&mut this.dirty) || this.generation != generation {
                    this.refresh(cx);
                }
                cx.notify();
            });
        }));
    }

    /// `git:stale`: files changed; refresh after a quiet 500 ms.
    pub fn mark_stale(&mut self, cx: &mut Context<Self>) {
        self.stale_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(STALE_DEBOUNCE).await;
            let _ = this.update(cx, |this, cx| this.refresh(cx));
        }));
    }

    /// Run a write on the background executor, then refresh.
    fn write<T: Send + 'static>(
        &mut self,
        op: impl FnOnce(&dyn HistoryRepo) -> notefig_history::Result<T> + Send + 'static,
        done: impl FnOnce(&mut Self, notefig_history::Result<T>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        self.generation += 1;
        let repo = self.repo.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { op(&*repo) }).await;
            let _ = this.update(cx, |this, cx| {
                done(this, result, cx);
                this.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub fn initialize(&mut self, cx: &mut Context<Self>) {
        self.write(|r| r.ensure_init(), |this, res, _| {
            if let Err(e) = res {
                this.snapshot.error = Some(e);
            }
        }, cx);
    }

    pub fn save(&mut self, message: String, cx: &mut Context<Self>) {
        self.saving = true;
        let message = if message.trim().is_empty() { "Checkpoint".to_string() } else { message };
        self.write(
            move |r| {
                r.ensure_init()?;
                r.checkpoint(&message, &Signature::panel())
            },
            |this, res, _| {
                this.saving = false;
                if let Err(e) = res {
                    this.snapshot.error = Some(e);
                }
            },
            cx,
        );
    }

    /// The panel's Restore: a WIP commit, then revert back to `oid`.
    pub fn restore(&mut self, oid: String, cx: &mut Context<Self>) {
        self.reverting = true;
        self.revert_error = None;
        self.write(
            move |r| r.revert_to(&oid, &Signature::panel()),
            |this, res, _| {
                this.reverting = false;
                if let Err(e) = res {
                    this.revert_error = Some(e);
                }
            },
            cx,
        );
    }

    pub fn abort_revert(&mut self, cx: &mut Context<Self>) {
        self.write(|r| r.abort_revert(), |this, _, _| this.revert_error = None, cx);
    }

    /// After every completed agent turn (errors are logged, never fatal).
    pub fn turn_checkpoint(&mut self, prompt: String, harness: String, cx: &mut Context<Self>) {
        self.write(
            move |r| notefig_history::tools::turn_checkpoint(r, &prompt, &harness),
            |_, res, _| {
                if let Err(e) = res {
                    log::warn!("turn checkpoint failed: {}", e.message);
                }
            },
            cx,
        );
    }

    fn toggle_describe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.describe.take().is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("What changed?"));
            input.update(cx, |i, cx| i.focus(window, cx));
            self.describe = Some(input);
        }
        cx.notify();
    }
}

fn ago_secs(secs: i64) -> String {
    crate::agents::ago(secs * 1000)
}

impl Render for WorkspaceHistory {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let brand = BrandColors::get(cx);
        let state = self.shown.clone().filter(|_| self.fetching).unwrap_or_else(|| self.state());
        let can_save = self.has_changes() && self.snapshot.initialized && !self.saving;
        let toolbar = h_flex()
            .px_2()
            .pb_2()
            .gap_0p5()
            .child(
                Button::new("history-save")
                    .label(if self.saving { "Saving commit…" } else { "Save commit" })
                    .small()
                    .outline()
                    .disabled(!can_save)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let message = this
                            .describe
                            .take()
                            .map(|i| i.read(cx).value().to_string())
                            .unwrap_or_default();
                        this.save(message, cx)
                    })),
            )
            .child(
                Button::new("history-describe")
                    .icon(IconName::ChevronDown)
                    .small()
                    .ghost()
                    .tooltip("Describe the commit")
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_describe(window, cx))),
            )
            .child(div().flex_1())
            .when(self.fetching, |this| this.child(div().text_xs().text_color(theme.muted_foreground).child("…")));
        let body = match state {
            PanelState::Uninitialized => v_flex()
                .p_3()
                .gap_2()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child("Commit history keeps checkpoints of this folder in a hidden repository (it never touches your own git).")
                .child(
                    Button::new("history-init")
                        .label("Initialize commit history")
                        .small()
                        .primary()
                        .on_click(cx.listener(|this, _, _, cx| this.initialize(cx))),
                )
                .into_any_element(),
            PanelState::Error(message) => v_flex()
                .p_3()
                .gap_2()
                .text_sm()
                .child(div().text_color(brand.warning).child("History is unavailable"))
                .child(div().text_xs().text_color(theme.muted_foreground).child(message))
                .child(
                    h_flex()
                        .gap_1()
                        .child(Button::new("history-retry").label("Retry").small().outline().on_click(cx.listener(|this, _, _, cx| this.refresh(cx))))
                        .child(Button::new("history-repair").label("Repair").small().ghost().on_click(cx.listener(|this, _, _, cx| this.initialize(cx)))),
                )
                .into_any_element(),
            PanelState::Empty => div()
                .p_3()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child("No commits yet. Save one to start the timeline.")
                .into_any_element(),
            PanelState::Ready => {
                let busy = self.reverting || self.saving;
                v_flex()
                    .id("history-rows")
                    .flex_1()
                    .overflow_y_scroll()
                    .px_1()
                    .when(self.saving, |this| {
                        this.child(
                            div().px_2().py_1().text_sm().text_color(theme.muted_foreground).child("Saving commit…"),
                        )
                    })
                    .children(self.snapshot.checkpoints.iter().enumerate().map(|(ix, cp)| {
                        let oid = cp.oid.clone();
                        let hash = cp.hash().to_string();
                        let full = cp.oid.clone();
                        h_flex()
                            .id(SharedString::from(format!("cp-{}", cp.oid)))
                            .px_2()
                            .py_1()
                            .gap_2()
                            .rounded_md()
                            .text_sm()
                            .hover(|this| this.bg(theme.list_hover))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .child(div().truncate().child(cp.summary().to_string()))
                                    .child(
                                        h_flex()
                                            .gap_1()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .child(ago_secs(cp.committer_time))
                                            .child("·")
                                            .child(cp.author_name.clone()),
                                    ),
                            )
                            .when(ix == 0, |this| {
                                this.child(div().px_1().rounded_sm().text_xs().bg(theme.muted).child("Latest"))
                            })
                            .child(
                                div()
                                    .id(SharedString::from(format!("cph-{ix}")))
                                    .text_xs()
                                    .font_family(theme.mono_font_family.clone())
                                    .text_color(theme.muted_foreground)
                                    .cursor_pointer()
                                    .child(hash)
                                    .on_click(move |_, _, cx: &mut App| cx.write_to_clipboard(ClipboardItem::new_string(full.clone()))),
                            )
                            .child(
                                Button::new(SharedString::from(format!("cpr-{ix}")))
                                    .icon(IconName::Undo2)
                                    .xsmall()
                                    .ghost()
                                    .tooltip("Restore this checkpoint")
                                    .disabled(ix == 0 || busy)
                                    .on_click(cx.listener(move |this, _, _, cx| this.restore(oid.clone(), cx))),
                            )
                    }))
                    .into_any_element()
            }
        };
        v_flex()
            .size_full()
            .child(toolbar)
            .when_some(self.describe.clone(), |this, input| {
                this.child(div().px_2().pb_2().child(Input::new(&input).small()))
            })
            .when_some(self.revert_error.clone(), |this, err| {
                let merge = err.code == HistoryErrorCode::MergeRequired;
                this.child(
                    v_flex()
                        .mx_2()
                        .mb_2()
                        .p_2()
                        .gap_1()
                        .rounded_md()
                        .border_1()
                        .border_color(brand.warning)
                        .text_xs()
                        .child(if merge { "Revert needs attention".to_string() } else { err.message.clone() })
                        .child(if merge {
                            Button::new("abort-revert").label("Abort revert").xsmall().outline().on_click(cx.listener(|this, _, _, cx| this.abort_revert(cx)))
                        } else {
                            Button::new("dismiss-revert").label("Dismiss").xsmall().ghost().on_click(cx.listener(|this, _, _, cx| {
                                this.revert_error = None;
                                cx.notify();
                            }))
                        }),
                )
            })
            .child(div().flex_1().min_h_0().child(body))
            .max_w(px(10000.))
    }
}
