//! `GlobalColumn` (components/editor/global-column.tsx): the rail down the
//! sidebar card's left edge — the Everything view (the logo) on top, one
//! chip per open workspace (the focused one marked), a way to add one, and
//! settings at the foot. A right-click on a chip offers to close it.

use gpui::{
    Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement as _, Styled, Window, anchored, deferred, div, img, point, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use notefig_core::Subscription;
use notefig_sidebar_view::{LastToolModule, SidebarView, read_sidebar_view};
use notefig_tabs::TabsModule;
use notefig_i18n::t as tr;
use notefig_ui::{ButtonStyle, CoreExt as _, IconButton, observe, sp, tokens};

use crate::dialogs::request_close_workspace;
use crate::root::open_folder;
use crate::shell::{show_view, url_params};
use crate::sidebar::project_name;
use crate::{OpenSettings, panels};

pub struct GlobalColumn {
    workspace_path: String,
    add_menu: bool,
    _subs: Vec<Subscription>,
}

/// The chip's letter: the first character of the workspace's name.
fn initial(name: &str) -> String {
    name.trim().chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "?".into())
}

impl GlobalColumn {
    pub fn new(workspace_path: &str, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let open = cx.core().workspaces();
        let sub = observe(cx, move |notify| open.subscribe(move || notify()));
        Self { workspace_path: workspace_path.into(), add_menu: false, _subs: vec![sub] }
    }

    pub fn set_workspace(&mut self, path: &str, cx: &mut Context<Self>) {
        self.workspace_path = path.into();
        cx.notify();
    }
}

/// `onShowWorkspaceTools`: focus a workspace and land on the tool it was
/// last using.
fn show_workspace(path: &str, cx: &mut gpui::App) {
    let core = cx.core();
    let handle = core.workspace(path);
    let tool = handle.get::<LastToolModule>().map(|l| l.get()).unwrap_or(notefig_sidebar_view::WorkspaceTool::Files);
    let focus = handle.focus();
    let path = path.to_string();
    cx.spawn(async move |cx| {
        if focus.await.is_ok() {
            let _ = cx.update(|cx| show_view(SidebarView::Tool(tool), &path, cx));
        }
    })
    .detach();
}

impl Render for GlobalColumn {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let core = cx.core();
        let everything = read_sidebar_view(&url_params(core.use_::<TabsModule>().layout())) == SidebarView::Everything;
        let rows = core.workspaces().list();
        let focused_key = core.workspace(&self.workspace_path).key().to_string();
        let ws = self.workspace_path.clone();
        div()
            .flex()
            .flex_col()
            .flex_none()
            .h_full()
            .w(sp(8.))
            .items_center()
            .pb(sp(1.5))
            .child(
                div().flex().flex_none().h(sp(8.)).items_center().child(
                    IconButton::with_content("rail-everything", img(t.logo_asset()).size(sp(5.)).into_any_element())
                        .style(ButtonStyle::Rail)
                        .pressed(everything)
                        .tooltip(tr("everything"))
                        .on_click(move |_, _, cx| show_view(SidebarView::Everything, &ws, cx)),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .items_center()
                    .gap(sp(1.))
                    .pt(sp(1.5))
                    .children(rows.into_iter().enumerate().map(|(i, row)| {
                        let name = project_name(&row.path);
                        let focused = row.key == focused_key;
                        let path = row.path.clone();
                        let close_path = row.path.clone();
                        div()
                            .id(("rail-chip-wrap", i))
                            .child(
                                IconButton::with_content(
                                    ("rail-chip", i),
                                    div().text_size(t.text_xs).font_weight(FontWeight::SEMIBOLD).child(initial(&name)).into_any_element(),
                                )
                                .style(ButtonStyle::Rail)
                                .pressed(!everything && focused)
                                .tooltip(name)
                                .on_click(move |_, _, cx| show_workspace(&path, cx)),
                            )
                            .context_menu(move |menu, _, _| {
                                let p = close_path.clone();
                                menu.item(PopupMenuItem::new(tr("closeWorkspaceAction")).on_click(move |_, window, cx| {
                                    request_close_workspace(&p, window, cx)
                                }))
                            })
                    }))
                    .child(
                        div()
                            .relative()
                            .child(
                                IconButton::new("rail-add", "plus")
                                    .style(ButtonStyle::Dashed)
                                    .tooltip(tr("addWorkspace"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.add_menu = !this.add_menu;
                                        cx.notify();
                                    })),
                            )
                            .when(self.add_menu, |d| d.child(self.add_menu(window, cx))),
                    )
                    .child(
                        div().mt_auto().child(
                            IconButton::new("rail-settings", "settings")
                                .style(ButtonStyle::Rail)
                                .tooltip(tr("settings"))
                                .on_click(|_, window, cx| {
                                    match panels(cx).open_settings {
                                        Some(open) => open(None, window, cx),
                                        None => window.dispatch_action(Box::new(OpenSettings), cx),
                                    }
                                }),
                        ),
                    ),
            )
    }
}

impl GlobalColumn {
    /// `AddWorkspaceMenu`: the folder picker. (TS also lists up to five
    /// recent projects not open; the recent-projects store is not ported.)
    fn add_menu(&self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let hover = t.accent;
        deferred(
            anchored().offset(point(sp(7.), px(0.))).child(
                div()
                    .id("add-workspace-menu")
                    .occlude()
                    .w(sp(52.))
                    .p(sp(1.))
                    .rounded(t.radius_md)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.popover)
                    .shadow_md()
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                        this.add_menu = false;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .id("add-workspace-open-folder")
                            .px(sp(2.))
                            .py(sp(1.))
                            .rounded(t.radius_sm)
                            .text_size(t.text_xs)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover))
                            .child(tr("openFolder"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.add_menu = false;
                                open_folder(cx);
                                cx.notify();
                            })),
                    ),
            ),
        )
    }
}

#[allow(dead_code)]
fn _assert_entity(_: Entity<GlobalColumn>) {}
