//! `Workspace` (components/workspace.tsx): the dock over every open
//! workspace with the sidebar showing the focused one — or the welcome
//! screen with nothing open. Waits for the persisted open set so a restored
//! session never flashes welcome.

use gpui::{
    AnyView, AppContext as _, Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement as _, Styled, Window, div,
};
use notefig_core::Subscription;
use notefig_ui::{CoreExt as _, observe, sp, tokens};
use notefig_workspaces::WorkspacesModule;

use crate::shell::WorkspaceShell;
use crate::{OpenFolder, panels};

pub struct WorkspaceRoot {
    shell: Option<Entity<WorkspaceShell>>,
    focused: Option<String>,
    kept: Vec<Subscription>,
    welcome: Option<AnyView>,
    _subs: Vec<Subscription>,
}

impl WorkspaceRoot {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let registry = cx.core().use_::<WorkspacesModule>();
        let r = registry.clone();
        let sub = observe(cx, move |notify| r.subscribe(move || notify()));
        let open = cx.core().workspaces();
        let sub2 = observe(cx, move |notify| open.subscribe(move || notify()));
        let _ = window;
        Self { shell: None, focused: None, kept: Vec::new(), welcome: None, _subs: vec![sub, sub2] }
    }

    /// Keep a subscription for the window's life (the root's theme watch).
    pub fn keep(&mut self, sub: Subscription) {
        self.kept.push(sub);
    }

    fn focused(&self, cx: &Context<Self>) -> Option<String> {
        let core = cx.core();
        let registry = core.use_::<WorkspacesModule>();
        registry.focused().filter(|p| core.workspaces().is_open(p)).or_else(|| core.workspaces().list().last().map(|w| w.path.clone()))
    }
}

impl Render for WorkspaceRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let focused = self.focused(cx);
        if focused != self.focused {
            self.focused = focused.clone();
            if let Some(f) = panels(cx).workspace_focused {
                f(focused.as_deref(), cx);
            }
        }
        let root = div()
            .id("workspace-root")
            .size_full()
            .bg(t.background)
            .text_color(t.foreground)
            .font_family(notefig_ui::theme::FONT_SANS)
            .on_action(cx.listener(|_, _: &OpenFolder, _, cx| open_folder(cx)));
        match focused {
            Some(path) => {
                let shell = match &self.shell {
                    Some(s) => {
                        s.update(cx, |s, cx| s.set_workspace(&path, window, cx));
                        s.clone()
                    }
                    None => {
                        let s = cx.new(|cx| WorkspaceShell::new(&path, window, cx));
                        self.shell = Some(s.clone());
                        s
                    }
                };
                root.child(shell)
            }
            None => {
                let registry = cx.core().use_::<WorkspacesModule>();
                if !registry.is_ready() && cx.core().workspaces().list().is_empty() {
                    return root;
                }
                let welcome = match (&self.welcome, panels(cx).welcome) {
                    (Some(w), _) => Some(w.clone()),
                    (None, Some(ctor)) => {
                        let w = ctor(window, cx);
                        self.welcome = Some(w.clone());
                        Some(w)
                    }
                    (None, None) => None,
                };
                match welcome {
                    Some(w) => root.child(w),
                    None => root.child(fallback_welcome(cx)),
                }
            }
        }
    }
}

/// Until `views/welcome` lands: the logo and "Open Folder".
fn fallback_welcome(cx: &mut Context<WorkspaceRoot>) -> impl IntoElement {
    let t = tokens(cx).clone();
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(sp(4.))
        .child(gpui::img(t.logo_asset()).size(sp(16.)))
        .child(div().text_size(t.text_base).font_weight(FontWeight::SEMIBOLD).child("Notefig"))
        .child(
            div()
                .id("welcome-open-folder")
                .px(sp(3.))
                .py(sp(1.5))
                .rounded(t.radius_md)
                .bg(t.primary)
                .text_color(t.primary_foreground)
                .text_size(t.text_sm)
                .cursor_pointer()
                .child("Open Folder")
                .on_click(cx.listener(|_, _, _, cx| open_folder(cx))),
        )
}

/// `useOpenProjectFromPicker`: the native picker, then open and enter.
pub(crate) fn open_folder(cx: &mut gpui::App) {
    let core = cx.core();
    let platform = core.service::<notefig_platform::PlatformService>();
    let pick = platform.ui.pick_directory("Open Folder");
    cx.foreground_executor()
        .spawn(async move {
            if let Some(path) = pick.await
                && let Err(err) = core.workspace(&path).open().await
            {
                log::error!("opening {path} failed: {err:?}");
            }
        })
        .detach();
}
