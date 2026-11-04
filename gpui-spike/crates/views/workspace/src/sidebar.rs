//! `Sidebar` (components/editor/sidebar.tsx): one floating card that owns
//! the window's header row. Open, the header sits on top and the rest
//! unrolls beneath it: the global rail down the left (logo = Everything,
//! the open workspaces, +, settings) beside the tool tabs and the tool (or
//! the Everything view). Closed, only the header remains, laid into the
//! dock's top-left tab strip (`collapsed_header`).

use std::collections::HashMap;

use gpui::{
    AnyView, AppContext as _, Context, Entity, FontWeight, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Render, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use notefig_core::Subscription;
use notefig_sidebar_view::{SidebarView, WORKSPACE_TOOLS, WorkspaceTool, read_sidebar_view};
use notefig_tabs::TabsModule;
use notefig_ui::{CoreExt as _, IconButton, icon, observe, rem, separator, sp, tokens};

use crate::everything::EverythingPanel;
use crate::global_column::GlobalColumn;
use crate::shell::{set_url_params, show_view, url_params};
use crate::{PanelCtor, ToggleSidebar, panels};

pub const SIDEBAR_DEFAULT_REM: f32 = 15.;
pub const SIDEBAR_MIN_REM: f32 = 10.;
pub const SIDEBAR_MAX_REM: f32 = 26.;

/// Clearance for the macOS traffic lights at the header's start.
pub(crate) fn lights_inset() -> Pixels {
    if cfg!(target_os = "macos") { px(72.) } else { px(0.) }
}

/// `deriveProjectName`: the folder's name.
pub(crate) fn project_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

pub struct Sidebar {
    workspace_path: String,
    rtl: bool,
    width: Pixels,
    resizing: Option<(Pixels, Pixels)>,
    rail: Entity<GlobalColumn>,
    everything: Entity<EverythingPanel>,
    /// One panel per (workspace, tool), built on first show and kept.
    tools: HashMap<(String, WorkspaceTool), AnyView>,
    _subs: Vec<Subscription>,
}

impl Sidebar {
    pub fn new(workspace_path: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tabs = cx.core().use_::<TabsModule>();
        let sub = observe(cx, move |notify| tabs.layout().url().subscribe(Box::new(move || notify())));
        Self {
            workspace_path: workspace_path.into(),
            rtl: false,
            width: crate::sidebar::sidebar_default_width(),
            resizing: None,
            rail: cx.new(|cx| GlobalColumn::new(workspace_path, window, cx)),
            everything: cx.new(|cx| EverythingPanel::new(workspace_path, window, cx)),
            tools: HashMap::new(),
            _subs: vec![sub],
        }
    }

    pub(crate) fn set_rtl(&mut self, rtl: bool) {
        self.rtl = rtl;
    }

    pub fn set_workspace(&mut self, path: &str, _: &mut Window, cx: &mut Context<Self>) {
        self.workspace_path = path.into();
        self.rail.update(cx, |r, cx| r.set_workspace(path, cx));
        self.everything.update(cx, |e, cx| e.set_workspace(path, cx));
        cx.notify();
    }

    pub(crate) fn tool_view(&mut self, tool: WorkspaceTool, window: &mut Window, cx: &mut Context<Self>) -> AnyView {
        let key = (self.workspace_path.clone(), tool);
        if let Some(v) = self.tools.get(&key) {
            return v.clone();
        }
        let p = panels(cx);
        let ctor: Option<PanelCtor> = match tool {
            WorkspaceTool::Files => p.files,
            WorkspaceTool::Search => p.search,
            WorkspaceTool::Git => p.git,
            WorkspaceTool::Sessions => p.sessions,
        };
        let ws = cx.core().workspace(&self.workspace_path);
        let view = match ctor {
            Some(ctor) => ctor(ws, window, cx),
            None => cx.new(|_| Placeholder(format!("{} — not ported yet", tool.label()))).into(),
        };
        self.tools.insert(key, view.clone());
        view
    }
}

pub(crate) fn sidebar_default_width() -> Pixels {
    rem(SIDEBAR_DEFAULT_REM)
}

/// A panel whose crate has not landed yet.
pub(crate) struct Placeholder(pub String);

impl Render for Placeholder {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(sp(4.))
            .text_size(t.text_xs)
            .text_color(t.muted_foreground)
            .child(self.0.clone())
    }
}

/// The header row's content (`SidebarHeader`): the lights' clearance, then
/// one tab-like button — the workspace's name and the open/close glyph —
/// that toggles the sidebar wherever it is clicked.
pub(crate) fn sidebar_header(workspace_path: &str, collapsed: bool, cx: &gpui::App) -> impl IntoElement {
    let t = tokens(cx);
    let hover = t.accent_hover;
    div()
        .flex()
        .h_full()
        .min_w_0()
        .flex_1()
        .items_stretch()
        .child(div().flex_none().w(lights_inset()))
        .child(
            div()
                .id("sidebar-header-toggle")
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(sp(1.5))
                .pl(sp(2.5))
                .pr(sp(1.5))
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleSidebar), cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(t.text_xs)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(t.foreground)
                        .child(project_name(workspace_path)),
                )
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .size(sp(5.))
                        .items_center()
                        .justify_center()
                        .rounded(t.radius_md)
                        .text_color(if collapsed { t.muted_foreground } else { t.foreground })
                        .when(!collapsed, |d| d.bg(t.accent))
                        .child(icon(if collapsed { "panel-left" } else { "panel-left-close" }).text_color(if collapsed { t.muted_foreground } else { t.foreground })),
                ),
        )
}

impl Render for Sidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let tabs = cx.core().use_::<TabsModule>();
        let view = read_sidebar_view(&url_params(tabs.layout()));
        let ws = self.workspace_path.clone();
        let body: gpui::AnyElement = match view {
            SidebarView::Everything => self.everything.clone().into_any_element(),
            SidebarView::Tool(tool) => {
                let content = self.tool_view(tool, window, cx);
                div()
                    .flex()
                    .flex_col()
                    .size_full()
                    .min_h_0()
                    .child(
                        div()
                            .flex_none()
                            .px(sp(1.5))
                            .child(
                                div().flex().h(sp(8.)).items_center().gap(sp(0.5)).children(WORKSPACE_TOOLS.iter().map(|candidate| {
                                    let candidate = *candidate;
                                    let ws = ws.clone();
                                    IconButton::new(("tool", candidate as usize), candidate.icon())
                                        .size(sp(7.), sp(5.))
                                        .pressed(candidate == tool)
                                        .tooltip(candidate.label())
                                        .on_click(move |_, _, cx| show_view(SidebarView::Tool(candidate), &ws, cx))
                                })),
                            )
                            .child(separator(false, cx).mx_0()),
                    )
                    .child(div().flex().flex_col().flex_1().min_h_0().child(content))
                    .into_any_element()
            }
        };
        let resizing = self.resizing.is_some();
        div()
            .id("sidebar")
            .relative()
            .flex()
            .flex_col()
            .flex_none()
            .min_h_0()
            .w(self.width)
            .child(
                notefig_ui::card(cx)
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .h(t.header_height)
                            .bg(t.chrome_wash)
                            .child(sidebar_header(&self.workspace_path, false, cx)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_h_0()
                            .when(self.rtl, |d| d.flex_row_reverse())
                            .child(self.rail.clone())
                            .child(separator(true, cx))
                            .child(div().flex().flex_col().flex_1().min_w_0().min_h_0().child(body)),
                    ),
            )
            // The resize handle on the card's end edge.
            .child(
                div()
                    .id("sidebar-resize")
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right(px(-6.))
                    .w(sp(2.))
                    .cursor_col_resize()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, e: &MouseDownEvent, _, cx| {
                            this.resizing = Some((e.position.x, this.width));
                            cx.stop_propagation();
                        }),
                    ),
            )
            .when(resizing, |d| {
                d.child(crate::dock::drag_capture(
                    window,
                    gpui::CursorStyle::ResizeLeftRight,
                    cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                        if let Some((x0, w0)) = this.resizing {
                            this.width = (w0 + (e.position.x - x0)).clamp(rem(SIDEBAR_MIN_REM), rem(SIDEBAR_MAX_REM));
                            cx.notify();
                        }
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _, cx| {
                        this.resizing = None;
                        cx.notify();
                    }),
                ))
            })
    }
}

/// Collapse the sidebar (`?sidebar=closed`).
#[allow(dead_code)]
pub(crate) fn collapse(cx: &mut gpui::App) {
    let layout = cx.core().use_::<TabsModule>().layout().clone();
    let mut params = url_params(&layout);
    params.set(notefig_sidebar_view::SIDEBAR_COLLAPSED_PARAM, "closed");
    set_url_params(&layout, &params, false);
}
