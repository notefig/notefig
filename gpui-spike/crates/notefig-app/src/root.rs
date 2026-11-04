//! The window's content: title bar, then either the Welcome screen or the
//! open workspace. Owns app-level actions (open/close folder, theme, quit).

use std::path::{Path, PathBuf};

use gpui::{
    AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _,
    Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{
    ActiveTheme as _, IconName, Sizable as _, TitleBar, WindowExt as _, h_flex, v_flex,
};
use notefig_workspace::{ThemePreference, Workspace};

use crate::actions::*;
use crate::app_state::{self, AppState};
use crate::document::Document;
use crate::workspace_view::{WorkspaceEvent, WorkspaceView};

pub struct NotefigRoot {
    app_state: Entity<AppState>,
    pub workspace: Option<Entity<WorkspaceView>>,
    focus: FocusHandle,
    workspace_sub: Option<Subscription>,
    _subs: Vec<Subscription>,
}

impl NotefigRoot {
    /// `initial`: a folder from the command line; otherwise the last
    /// workspace is restored.
    pub fn new(initial: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let app_state = AppState::global(cx);
        let pref = app_state.read(cx).theme();
        app_state::apply_theme(pref, window, cx);
        let subs = vec![
            cx.observe_window_appearance(window, |this, window, cx| {
                if this.app_state.read(cx).theme() == ThemePreference::System {
                    app_state::apply_theme(ThemePreference::System, window, cx);
                }
            }),
            cx.observe_window_bounds(window, |this, window, cx| {
                let (bounds, maximized, fullscreen) = match window.window_bounds() {
                    gpui::WindowBounds::Windowed(b) => (b, false, false),
                    gpui::WindowBounds::Maximized(b) => (b, true, false),
                    gpui::WindowBounds::Fullscreen(b) => (b, false, true),
                };
                let saved = notefig_workspace::WindowBoundsState {
                    x: f32::from(bounds.origin.x),
                    y: f32::from(bounds.origin.y),
                    width: f32::from(bounds.size.width),
                    height: f32::from(bounds.size.height),
                    maximized,
                    fullscreen,
                };
                this.app_state.update(cx, |s, cx| {
                    if s.data().window != Some(saved) {
                        s.update_data(cx, |d| d.window = Some(saved));
                    }
                });
            }),
            cx.on_app_quit(|this: &mut Self, cx| {
                if let Some(ws) = &this.workspace {
                    ws.update(cx, |ws, cx| ws.flush(cx));
                }
                this.app_state.update(cx, |state, _| state.flush());
                async {}
            }),
        ];
        let mut this = Self {
            app_state,
            workspace: None,
            focus: cx.focus_handle(),
            workspace_sub: None,
            _subs: subs,
        };
        let restore = initial.is_none();
        let target = initial.or_else(|| this.app_state.read(cx).data().last_workspace.clone());
        if let Some(path) = target {
            let result = if restore {
                this.open_workspace(&path, window, cx)
            } else {
                this.enter_workspace(&path, window, cx)
            };
            if let Err(err) = result {
                log::warn!("could not open {}: {err:#}", path.display());
                if restore {
                    this.app_state.update(cx, |s, cx| {
                        s.update_data(cx, |d| d.last_workspace = None)
                    });
                } else {
                    window.push_notification(
                        gpui_kit::component::notification::Notification::error(format!("{err:#}")),
                        cx,
                    );
                }
            }
        }
        if this.workspace.is_none() {
            window.focus(&this.focus, cx);
        }
        this.update_title(window, cx);
        this
    }

    /// The user enters a workspace (open folder, recent, CLI path): open it
    /// and land on a scratchpad if no file is open (spec 04 §3).
    pub fn enter_workspace(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) -> anyhow::Result<()> {
        self.open_workspace(path, window, cx)?;
        if let Some(ws) = self.workspace.clone() {
            ws.update(cx, |ws, cx| ws.enter(window, cx));
        }
        Ok(())
    }

    /// Open without entry handlers (a restore at launch).
    pub fn open_workspace(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) -> anyhow::Result<()> {
        let ws = Workspace::open(path)?;
        if let Some(old) = self.workspace.take() {
            old.update(cx, |old, cx| old.flush(cx));
        }
        let root = ws.root().to_path_buf();
        self.app_state
            .update(cx, |s, cx| s.update_data(cx, |d| d.record_open(&root)));
        let app_state = self.app_state.clone();
        let view = cx.new(|cx| WorkspaceView::new(ws, app_state, window, cx));
        self.workspace_sub = Some(cx.subscribe_in(&view, window, |this, _, event, window, cx| {
            match event {
                WorkspaceEvent::TitleChanged => this.update_title(window, cx),
            }
        }));
        view.update(cx, |view, cx| {
            if let Some(doc) = view.active_doc() {
                Document::focus_editor(&doc, window, cx);
            } else {
                window.focus(&view.focus_handle(cx), cx);
            }
        });
        self.workspace = Some(view);
        self.update_title(window, cx);
        cx.notify();
        Ok(())
    }

    pub fn close_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ws) = self.workspace.take() {
            ws.update(cx, |ws, cx| ws.flush(cx));
        }
        self.workspace_sub = None;
        self.app_state
            .update(cx, |s, cx| s.update_data(cx, |d| d.last_workspace = None));
        window.focus(&self.focus, cx);
        self.update_title(window, cx);
        cx.notify();
    }

    pub fn prompt_open_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(path) = paths.into_iter().next() {
                    let _ = this.update_in(cx, |this, window, cx| {
                        if let Err(err) = this.enter_workspace(&path, window, cx) {
                            window.push_notification(
                                gpui_kit::component::notification::Notification::error(format!("{err:#}")),
                                cx,
                            );
                        }
                    });
                }
            }
        })
        .detach();
    }

    fn update_title(&self, window: &mut Window, cx: &mut Context<Self>) {
        let title = match &self.workspace {
            Some(ws) => ws.read(cx).title(cx),
            None => "Notefig".to_string(),
        };
        window.set_window_title(&title);
        cx.notify();
    }

    fn set_theme(&mut self, pref: ThemePreference, window: &mut Window, cx: &mut Context<Self>) {
        self.app_state
            .update(cx, |s, cx| s.set_theme(pref, window, cx));
        cx.notify();
    }

    fn render_title_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (workspace, active, dirty) = match &self.workspace {
            Some(ws) => {
                let ws = ws.read(cx);
                let active = ws.layout.active_tab().map(|t| match t {
                    crate::layout::Tab::File { rel } => rel.clone(),
                    crate::layout::Tab::Chat { task_id } => crate::agents::Agents::global(cx)
                        .and_then(|a| a.read(cx).handle.task(task_id))
                        .map(|t| t.title)
                        .filter(|t| !t.is_empty())
                        .unwrap_or_else(|| "Session".into()),
                    crate::layout::Tab::Settings => "Settings".into(),
                });
                let dirty = ws.active_doc().is_some_and(|d| d.read(cx).is_dirty());
                (Some(ws.name()), active, dirty)
            }
            None => (None, None, false),
        };
        TitleBar::new().child(
            h_flex()
                .flex_1()
                .justify_center()
                .gap_2()
                .text_sm()
                .text_color(theme.muted_foreground)
                .when_some(workspace, |this, name| {
                    this.child(
                        div()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.foreground)
                            .child(name),
                    )
                })
                .when_some(active, |this, active| this.child("/").child(active))
                .when(dirty, |this| this.child("•"))
                .when(self.workspace.is_none(), |this| this.child("Notefig")),
        )
    }

    fn render_welcome(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let recent = self.app_state.read(cx).data().recent.clone();
        v_flex()
            .id("welcome")
            .size_full()
            .items_center()
            .justify_center()
            .gap_6()
            .bg(theme.background)
            .child(
                v_flex()
                    .items_center()
                    .gap_1()
                    .child(div().text_3xl().font_weight(gpui::FontWeight::BOLD).child("Notefig"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("Markdown notes with your agents."),
                    ),
            )
            .child(
                Button::new("welcome-open")
                    .primary()
                    .icon(IconName::FolderOpen)
                    .label("Open Folder…")
                    .on_click(cx.listener(|this, _, window, cx| this.prompt_open_folder(window, cx))),
            )
            .when(!recent.is_empty(), |this| {
                this.child(
                    v_flex()
                        .w(px(480.))
                        .gap_1()
                        .child(
                            div()
                                .px_2()
                                .text_xs()
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(theme.muted_foreground)
                                .child("RECENT"),
                        )
                        .children(recent.into_iter().take(10).enumerate().map(|(ix, r)| {
                            let path = r.path.clone();
                            let forget = r.path.clone();
                            h_flex()
                                .id(("recent", ix))
                                .px_2()
                                .py_1()
                                .gap_2()
                                .rounded_md()
                                .cursor_pointer()
                                .hover(|this| this.bg(theme.list_hover))
                                .child(div().text_sm().child(SharedString::from(r.name.clone())))
                                .child(
                                    div()
                                        .flex_1()
                                        .truncate()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(SharedString::from(r.path.display().to_string())),
                                )
                                .child(
                                    Button::new(("recent-forget", ix))
                                        .icon(IconName::Close)
                                        .ghost()
                                        .xsmall()
                                        .tooltip("Remove from recent")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            cx.stop_propagation();
                                            let forget = forget.clone();
                                            this.app_state.update(cx, |s, cx| {
                                                s.update_data(cx, |d| d.forget_recent(&forget))
                                            });
                                        })),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if let Err(err) = this.enter_workspace(&path, window, cx) {
                                        window.push_notification(
                                            gpui_kit::component::notification::Notification::error(
                                                format!("{err:#}"),
                                            ),
                                            cx,
                                        );
                                    }
                                }))
                        })),
                )
            })
    }
}

impl Focusable for NotefigRoot {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for NotefigRoot {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        v_flex()
            .id("notefig-root")
            .key_context("NotefigRoot")
            .track_focus(&self.focus)
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .on_action(cx.listener(|this, _: &OpenFolder, window, cx| this.prompt_open_folder(window, cx)))
            .on_action(cx.listener(|this, _: &CloseWorkspace, window, cx| this.close_workspace(window, cx)))
            .on_action(cx.listener(|this, _: &ToggleTheme, window, cx| {
                let pref = app_state::toggled(cx);
                this.set_theme(pref, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ThemeSystem, window, cx| {
                this.set_theme(ThemePreference::System, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ThemeLight, window, cx| {
                this.set_theme(ThemePreference::Light, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ThemeDark, window, cx| {
                this.set_theme(ThemePreference::Dark, window, cx)
            }))
            .on_action(cx.listener(|_, _: &Quit, _, cx| cx.quit()))
            .child(self.render_title_bar(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .map(|this| match &self.workspace {
                        Some(ws) => this.child(ws.clone()),
                        None => this.child(self.render_welcome(cx)),
                    }),
            )
    }
}
