//! The dock (`components/dockable/*` and workspace.tsx's `DockArea`): the
//! layout tree as floating tab strips over their selected tab, splits with
//! draggable dividers, and drag to dock — a tab dragged onto another
//! window's strip moves there, onto a tab reorders, onto a window's edge
//! splits it, onto its middle moves it. Every change is a
//! `notefig_layout::reduce` action handed to `core.tabs.apply_layout`, as
//! the TS dock dispatches to its reducer and hands the layout up.
//!
//! What a tab of each kind shows (TS `tab-types.tsx`): a file → the editor
//! host, an agent session → the chat tab, release notes → its view. A tab's
//! content is built the first time it is shown and kept while the tab is
//! open (`keepMounted`), so switching tabs never rebuilds an editor.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, App, AppContext as _, Bounds, Context, CursorStyle, DragMoveEvent, Entity, InteractiveElement,
    IntoElement, MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render, StatefulInteractiveElement as _,
    Styled, Window, anchored, canvas, deferred, div, point, prelude::FluentBuilder as _, px, relative,
};
use notefig_core::Subscription;
use notefig_documents::DocumentsModule;
use notefig_editors::is_in_tree;
use notefig_layout::{DockAction, LayoutNode, Orientation, PanelNode, SplitDirection, WindowNode, reduce};
use notefig_recent_documents::RecentDocumentsModule;
use notefig_tabs::{TabRef, TabsModule, WindowRect, parse_tab_id};
use notefig_i18n::t as tr;
use notefig_ui::{CoreExt as _, TabStripTab, observe, rem, separator, sp, tokens};
use notefig_workspaces::WorkspacesModule;

use crate::editor_host::EditorHost;
use crate::panels;
use crate::sidebar::{Placeholder, sidebar_default_width, sidebar_header};

/// A tab being dragged.
#[derive(Clone)]
pub struct DraggedTab {
    pub tab_id: String,
    pub label: String,
    pub window_address: Vec<usize>,
    pub window_id: String,
}

/// The drag's ghost: the tab's name in a floating chip.
struct TabGhost(String);

impl Render for TabGhost {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        div()
            .px(sp(3.))
            .py(sp(1.5))
            .rounded(t.radius_md)
            .border_1()
            .border_color(t.border)
            .bg(t.card)
            .shadow_md()
            .text_size(t.text_xs)
            .text_color(t.foreground)
            .child(self.0.clone())
    }
}

/// Where a drop on a window's content lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Zone {
    Center,
    Edge(SplitDirection),
}

/// TS's edge zones are half the window each, nearest edge winning; the
/// middle (a third each way) moves the tab into the window.
fn zone_at(bounds: Bounds<Pixels>, p: Point<Pixels>) -> Zone {
    let fx = ((p.x - bounds.origin.x) / bounds.size.width).clamp(0., 1.);
    let fy = ((p.y - bounds.origin.y) / bounds.size.height).clamp(0., 1.);
    if (fx - 0.5).abs() < 1. / 6. && (fy - 0.5).abs() < 1. / 6. {
        return Zone::Center;
    }
    let candidates = [
        (fx, SplitDirection::Left),
        (1. - fx, SplitDirection::Right),
        (fy, SplitDirection::Top),
        (1. - fy, SplitDirection::Bottom),
    ];
    let (_, dir) = candidates.into_iter().fold((f32::MAX, SplitDirection::Left), |best, c| if c.0 < best.0 { c } else { best });
    Zone::Edge(dir)
}

enum TabContent {
    File(Entity<EditorHost>),
    View(AnyView),
}

struct Resize {
    /// The panel whose children are being resized (root = []).
    address: Vec<usize>,
    /// The divider: between child `index` and `index + 1`.
    index: usize,
    axis: Orientation,
    start: Point<Pixels>,
    sizes: Vec<f64>,
    /// The two children's extent in px at the start.
    span: f32,
}

pub struct DockView {
    workspace_path: String,
    rtl: bool,
    sidebar_collapsed: bool,
    contents: HashMap<String, TabContent>,
    drop_hint: Option<(String, Zone)>,
    resize: Option<Resize>,
    /// Each panel's children's pixel extents, from the last paint.
    extents: Rc<RefCell<HashMap<Vec<usize>, Vec<f32>>>>,
    rects: Rc<RefCell<Vec<(String, WindowRect)>>>,
    last_active: Option<String>,
    /// Each window's strip scroller, and the tab it last scrolled to.
    strips: HashMap<String, (gpui::ScrollHandle, String)>,
    _subs: Vec<Subscription>,
}

/// The address of a window and the orientation of the panel holding it.
pub(crate) fn address_of_window(layout: &[LayoutNode], id: &str) -> Option<(Vec<usize>, Orientation)> {
    fn walk(nodes: &[LayoutNode], id: &str, orientation: Orientation, prefix: &mut Vec<usize>) -> Option<(Vec<usize>, Orientation)> {
        for (i, node) in nodes.iter().enumerate() {
            prefix.push(i);
            match node {
                LayoutNode::Window(w) if w.id == id => return Some((prefix.clone(), orientation)),
                LayoutNode::Panel(p) => {
                    let o = p.orientation.unwrap_or(flip(orientation));
                    if let Some(found) = walk(&p.children, id, o, prefix) {
                        return Some(found);
                    }
                }
                _ => {}
            }
            prefix.pop();
        }
        None
    }
    walk(layout, id, Orientation::Row, &mut Vec::new())
}

fn flip(o: Orientation) -> Orientation {
    match o {
        Orientation::Row => Orientation::Column,
        Orientation::Column => Orientation::Row,
    }
}

/// A full-window layer that owns the mouse while a divider or the sidebar
/// edge is dragged, so the drag keeps going past the element.
pub(crate) fn drag_capture(
    window: &mut Window,
    cursor: CursorStyle,
    on_move: impl Fn(&MouseMoveEvent, &mut Window, &mut App) + 'static,
    on_up: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let size = window.viewport_size();
    deferred(
        anchored().position(point(px(0.), px(0.))).child(
            div()
                .id("drag-capture")
                .occlude()
                .w(size.width)
                .h(size.height)
                .cursor(cursor)
                .on_mouse_move(on_move)
                .on_mouse_up(MouseButton::Left, on_up),
        ),
    )
    .with_priority(10)
}

impl DockView {
    pub fn new(workspace_path: &str, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let tabs = core.use_::<TabsModule>();
        let docs = core.use_::<DocumentsModule>();
        let reg = core.use_::<WorkspacesModule>();
        let store = core.use_::<notefig_agents::AgentStoreModule>();
        let subs = vec![
            observe(cx, move |notify| tabs.subscribe(move || notify())),
            observe(cx, move |notify| docs.subscribe(move || notify())),
            observe(cx, move |notify| reg.subscribe(move || notify())),
            // Session titles name agent tabs.
            observe(cx, move |notify| store.subscribe(move || notify())),
        ];
        Self {
            workspace_path: workspace_path.into(),
            rtl: false,
            sidebar_collapsed: false,
            contents: HashMap::new(),
            drop_hint: None,
            resize: None,
            extents: Rc::default(),
            rects: Rc::default(),
            last_active: None,
            strips: HashMap::new(),
            _subs: subs,
        }
    }

    pub fn set_workspace(&mut self, path: &str) {
        self.workspace_path = path.into();
    }

    pub fn set_rtl(&mut self, rtl: bool) {
        self.rtl = rtl;
    }

    pub fn set_sidebar_collapsed(&mut self, collapsed: bool) {
        self.sidebar_collapsed = collapsed;
    }

    fn apply(&mut self, action: DockAction, cx: &mut Context<Self>) {
        let tabs = cx.core().use_::<TabsModule>();
        let next = reduce(&tabs.layout().read(), action);
        tabs.apply_layout(next);
        cx.notify();
    }

    /// The tab's name (`tab-types.tsx`'s `build().name`).
    fn tab_label(&self, tab_id: &str, cx: &App) -> String {
        match parse_tab_id(tab_id) {
            TabRef::File { path, .. } => std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path),
            TabRef::Agent { task_id, .. } => {
                let title = panels(cx).agent_title.and_then(|f| f(&task_id, cx)).unwrap_or_else(|| "Session".into());
                // Session titles are first-prompt text: a shorter ellipsis.
                if title.chars().count() > 24 {
                    format!("{}…", title.chars().take(23).collect::<String>().trim_end())
                } else {
                    title
                }
            }
            TabRef::ReleaseNotes { .. } => "Release notes".into(),
        }
    }

    fn content(&mut self, tab_id: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.contents.contains_key(tab_id) {
            let content = match parse_tab_id(tab_id) {
                TabRef::File { path, .. } => TabContent::File(cx.new(|cx| EditorHost::new(&path, window, cx))),
                TabRef::Agent { task_id, .. } => {
                    let ws = cx.core().workspace(&self.workspace_path);
                    TabContent::View(match panels(cx).chat_tab {
                        Some(ctor) => ctor(ws, task_id, window, cx),
                        None => cx.new(|_| Placeholder("Agent chat — not ported yet".into())).into(),
                    })
                }
                TabRef::ReleaseNotes { .. } => TabContent::View(match panels(cx).release_notes {
                    Some(ctor) => ctor(window, cx).0,
                    None => cx.new(|_| Placeholder("Release notes — not ported yet".into())).into(),
                }),
            };
            self.contents.insert(tab_id.to_string(), content);
        }
        match &self.contents[tab_id] {
            TabContent::File(e) => e.clone().into_any_element(),
            TabContent::View(v) => v.clone().into_any_element(),
        }
    }

    /// `StaleTabPruning`: drop file tabs in no open workspace (once the
    /// open set has loaded), except mid-rename.
    fn prune_stale(&self, layout: &[LayoutNode], cx: &mut Context<Self>) {
        let core = cx.core();
        if !core.use_::<WorkspacesModule>().is_ready() {
            return;
        }
        let open: Vec<String> = core.workspaces().list().into_iter().map(|w| w.path).collect();
        if open.is_empty() {
            return;
        }
        let tabs = core.use_::<TabsModule>();
        let renaming = tabs.renaming();
        let stale: Vec<String> = notefig_layout::extract_tab_ids(layout)
            .into_iter()
            .filter(|id| matches!(parse_tab_id(id), TabRef::File { .. }))
            .filter(|id| !renaming.contains_key(id) && !open.iter().any(|ws| is_in_tree(ws, id)))
            .collect();
        if stale.is_empty() {
            return;
        }
        let next = stale.iter().fold(layout.to_vec(), |l, id| notefig_layout::remove_tab_from_layout(&l, id));
        cx.defer(move |cx| cx.core().use_::<TabsModule>().apply_layout(next));
    }

    fn render_node(
        &mut self,
        node: &LayoutNode,
        address: Vec<usize>,
        orientation: Orientation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match node {
            LayoutNode::Window(w) => self.render_window(w, address, orientation, window, cx),
            LayoutNode::Panel(p) => self.render_panel(p, address, p.orientation.unwrap_or(flip(orientation)), window, cx),
        }
    }

    fn render_panel(&mut self, p: &PanelNode, address: Vec<usize>, o: Orientation, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.render_children(&p.children, address, o, window, cx)
    }

    fn render_children(&mut self, children: &[LayoutNode], address: Vec<usize>, o: Orientation, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let row = o == Orientation::Row;
        let extents = self.extents.clone();
        let sizes: Vec<f64> = children.iter().map(|c| c.size().unwrap_or(1.)).collect();
        let n = children.len();
        // `flex_1`, not `size_full`: a percentage of a stretched flex item is
        // indefinite in taffy, which collapsed the content to zero height.
        let rtl = self.rtl;
        let mut el = div().flex().flex_1().min_w_0().min_h_0().when(!row, |d| d.flex_col()).when(row && rtl, |d| d.flex_row_reverse());
        for (i, child) in children.iter().enumerate() {
            let mut a = address.clone();
            a.push(i);
            let rendered = self.render_node(child, a, o, window, cx);
            let grow = sizes[i] as f32;
            let ex = extents.clone();
            let key = address.clone();
            let mut cell = div().relative().flex().min_w_0().min_h_0().overflow_hidden().child(rendered).child(
                canvas(
                    move |bounds, _, _| {
                        let mut map = ex.borrow_mut();
                        let list = map.entry(key.clone()).or_insert_with(|| vec![0.; n]);
                        list.resize(n, 0.);
                        list[i] = if row { f32::from(bounds.size.width) } else { f32::from(bounds.size.height) };
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            );
            {
                let style = cell.style();
                style.flex_grow = Some(grow);
                style.flex_shrink = Some(1.);
                style.flex_basis = Some(relative(0.).into());
            }
            el = el.child(cell);
            if i + 1 < n {
                el = el.child(self.render_divider(&address, i, o, cx));
            }
        }
        el.into_any_element()
    }

    fn render_divider(&mut self, address: &[usize], index: usize, o: Orientation, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let row = o == Orientation::Row;
        let address = address.to_vec();
        let ring = t.ring.opacity(0.3);
        let active = self.resize.as_ref().is_some_and(|r| r.address == address && r.index == index);
        div()
            .id(gpui::ElementId::Name(format!("divider-{address:?}-{index}").into()))
            .flex_none()
            .relative()
            // `--dockable-gap: 1px`, drawn as a hairline below the strips,
            // with the panel handle's grip in the middle; the grab area is
            // wider than the line.
            .when(row, |d| d.w(px(1.)).h_full().mt(t.header_height + px(2.) + sp(2.)))
            .when(!row, |d| d.h(px(1.)).w_full())
            .bg(if active { ring } else { t.border })
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .flex_none()
                    .relative()
                    // Centred on the pane, not the line below the strip.
                    .when(row, |d| d.top(-(t.header_height + px(2.) + sp(2.)) / 2.))
                    .bg(t.background)
                    .py(sp(1.))
                    .child(
                        notefig_ui::icon(if row { "grip-vertical" } else { "grip-horizontal" })
                            .size(sp(4.))
                            .text_color(t.muted_foreground),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .when(row, |d| d.top_0().bottom_0().left(px(-4.)).w(px(9.)).cursor_col_resize())
                    .when(!row, |d| d.left_0().right_0().top(px(-4.)).h(px(9.)).cursor_row_resize())
                    .hover(move |s| s.bg(ring)),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &gpui::MouseDownEvent, _, cx| {
                    let tabs = cx.core().use_::<TabsModule>();
                    let layout = tabs.layout().read();
                    let children: Vec<LayoutNode> = if address.is_empty() {
                        layout.as_ref().clone()
                    } else {
                        match node_at(&layout, &address) {
                            Some(LayoutNode::Panel(p)) => p.children.clone(),
                            _ => return,
                        }
                    };
                    let sizes: Vec<f64> = children.iter().map(|c| c.size().unwrap_or(1.)).collect();
                    let ex = this.extents.borrow().get(&address).cloned().unwrap_or_default();
                    let span = ex.get(index).copied().unwrap_or(0.) + ex.get(index + 1).copied().unwrap_or(0.);
                    this.resize = Some(Resize { address: address.clone(), index, axis: o, start: e.position, sizes, span });
                    cx.stop_propagation();
                    cx.notify();
                }),
            )
            .into_any_element()
    }

    fn render_window(&mut self, w: &WindowNode, address: Vec<usize>, orientation: Orientation, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx).clone();
        let core = cx.core();
        let docs = core.use_::<DocumentsModule>();
        let top_left = address.iter().all(|i| *i == 0);
        let leading_active = top_left && self.sidebar_collapsed;
        let window_id = w.id.clone();
        let rects = self.rects.clone();

        // The strip's tabs.
        let strip_tabs: Vec<AnyElement> = w
            .children
            .iter()
            .enumerate()
            .map(|(i, tab_id)| {
                let label = self.tab_label(tab_id, cx);
                let selected = *tab_id == w.selected;
                let dirty = docs.is_dirty(tab_id);
                let (select_id, close_id) = (tab_id.clone(), tab_id.clone());
                let drag = DraggedTab { tab_id: tab_id.clone(), label: label.clone(), window_address: address.clone(), window_id: w.id.clone() };
                let (target, target_addr, target_win) = (tab_id.clone(), address.clone(), w.id.clone());
                let ring = t.ring;
                div()
                    .id(gpui::ElementId::Name(format!("tab-{}-{i}", w.id).into()))
                    .h_full()
                    .flex_none()
                    .when(i == 0, |d| d.ml(px(-1.)))
                    .on_drag(drag, |d: &DraggedTab, _, _, cx| cx.new(|_| TabGhost(d.label.clone())))
                    .drag_over::<DraggedTab>(move |s, _, _, _| s.border_l_2().border_color(ring))
                    .on_drop(cx.listener(move |this, d: &DraggedTab, _, cx| {
                        if d.window_id == target_win {
                            this.apply(DockAction::ReorderTabs { source_tab_id: d.tab_id.clone(), target_tab_id: target.clone(), address: target_addr.clone() }, cx);
                        } else {
                            this.apply(DockAction::MoveTab { tab_id: d.tab_id.clone(), source_window_address: d.window_address.clone(), target_window_address: target_addr.clone() }, cx);
                        }
                    }))
                    .child(
                        TabStripTab::new(gpui::ElementId::Name(format!("tabbtn-{}-{i}", w.id).into()), label, selected)
                            .dirty(dirty)
                            .on_select(move |_, _, cx| cx.core().use_::<TabsModule>().select(&select_id))
                            .on_close(move |_, _, cx| cx.core().use_::<TabsModule>().close(&close_id)),
                    )
                    .into_any_element()
            })
            .collect();

        // A newly selected tab scrolls into view in an overflowing strip.
        let entry = self.strips.entry(w.id.clone()).or_insert_with(|| (gpui::ScrollHandle::new(), String::new()));
        if entry.1 != w.selected {
            entry.1 = w.selected.clone();
            if let Some(ix) = w.children.iter().position(|c| *c == w.selected) {
                entry.0.scroll_to_item(ix);
            }
        }
        let strip_scroll = entry.0.clone();
        let strip_addr = address.clone();
        let strip_win = w.id.clone();
        let ring = t.ring;
        let strip = div()
            .id(gpui::ElementId::Name(format!("strip-{}", w.id).into()))
            .relative()
            .flex()
            .flex_none()
            .min_w_0()
            .h(t.header_height + px(2.))
            .rounded(t.radius_lg)
            .border_1()
            .border_color(t.border)
            .bg(t.card)
            .overflow_hidden()
            .when(leading_active, |d| d.mr(sp(2.)))
            .when(!leading_active, |d| d.mx(sp(2.)))
            .drag_over::<DraggedTab>(move |s, _, _, _| s.border_color(ring))
            .on_drop(cx.listener(move |this, d: &DraggedTab, _, cx| {
                if d.window_id != strip_win {
                    this.apply(DockAction::MoveTab { tab_id: d.tab_id.clone(), source_window_address: d.window_address.clone(), target_window_address: strip_addr.clone() }, cx);
                }
            }))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(t.chrome_wash),
            )
            .when(top_left, |d| d.child(self.collapsed_header(cx)))
            .child(
                div()
                    .id(gpui::ElementId::Name(format!("strip-scroll-{}", w.id).into()))
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .items_stretch()
                    .overflow_x_scroll()
                    .when(self.rtl, |d| d.flex_row_reverse())
                    .track_scroll(&strip_scroll)
                    .children(strip_tabs),
            );

        // The content: the selected tab, and drop zones while dragging.
        let selected = w.selected.clone();
        let content = if selected.is_empty() { None } else { Some(self.content(&selected, window, cx)) };
        let hint = self.drop_hint.as_ref().filter(|(id, _)| *id == w.id).map(|(_, z)| *z);
        let (drop_addr, drop_win, move_win) = (address.clone(), w.id.clone(), w.id.clone());
        let hide_zones = false;
        let single = w.children.len() == 1;
        let content_box = div()
            .id(gpui::ElementId::Name(format!("content-{}", w.id).into()))
            .relative()
            .flex()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .when_some(content, |d, c| d.child(div().absolute().inset_0().flex().px(sp(2.)).child(c)))
            .on_drag_move(cx.listener(move |this, e: &DragMoveEvent<DraggedTab>, _, cx| {
                if !e.bounds.contains(&e.event.position) {
                    if this.drop_hint.as_ref().is_some_and(|(id, _)| *id == move_win) {
                        this.drop_hint = None;
                        cx.notify();
                    }
                    return;
                }
                let zone = zone_at(e.bounds, e.event.position);
                let d = e.drag(cx);
                let same_single = d.window_id == move_win && single;
                let next = if same_single { None } else { Some((move_win.clone(), zone)) };
                if this.drop_hint != next {
                    this.drop_hint = next;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(move |this, d: &DraggedTab, _, cx| {
                let zone = this.drop_hint.take().filter(|(id, _)| *id == drop_win).map(|(_, z)| z);
                match zone {
                    Some(Zone::Center) if d.window_id != drop_win => this.apply(
                        DockAction::MoveTab { tab_id: d.tab_id.clone(), source_window_address: d.window_address.clone(), target_window_address: drop_addr.clone() },
                        cx,
                    ),
                    Some(Zone::Edge(direction)) => this.apply(
                        DockAction::SplitWindow {
                            tab_id: d.tab_id.clone(),
                            source_window_address: d.window_address.clone(),
                            target_window_address: drop_addr.clone(),
                            direction,
                            orientation,
                        },
                        cx,
                    ),
                    _ => cx.notify(),
                }
            }))
            .when_some(hint.filter(|_| !hide_zones), |d, zone| d.child(zone_preview(zone, cx)));

        let fw_id = window_id.clone();
        div()
            .id(gpui::ElementId::Name(format!("window-{}", w.id).into()))
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .on_mouse_down(MouseButton::Left, move |_, _, cx| cx.core().use_::<TabsModule>().focused_window().set(&fw_id))
            .child(strip)
            .child(content_box)
            .child(
                canvas(
                    move |bounds, _, _| {
                        let r = WindowRect {
                            left: f32::from(bounds.origin.x),
                            top: f32::from(bounds.origin.y),
                            right: f32::from(bounds.origin.x + bounds.size.width),
                            bottom: f32::from(bounds.origin.y + bounds.size.height),
                        };
                        let mut list = rects.borrow_mut();
                        list.retain(|(id, _)| *id != window_id);
                        list.push((window_id.clone(), r));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .into_any_element()
    }

    /// `CollapsedSidebarHeader`: the sidebar's header laid into the top-left
    /// strip while the sidebar is closed; nothing while it is open.
    fn collapsed_header(&self, cx: &mut Context<Self>) -> AnyElement {
        if !self.sidebar_collapsed {
            return div().into_any_element();
        }
        let w = sidebar_default_width() - px(1.);
        div()
            .flex()
            .flex_none()
            .h_full()
            .w(w)
            .child(sidebar_header(&self.workspace_path, true, cx))
            .child(separator(true, cx).my(sp(1.5)))
            .into_any_element()
    }
}

fn node_at<'a>(layout: &'a [LayoutNode], address: &[usize]) -> Option<&'a LayoutNode> {
    let (first, rest) = address.split_first()?;
    let mut node = layout.get(*first)?;
    for i in rest {
        match node {
            LayoutNode::Panel(p) => node = p.children.get(*i)?,
            LayoutNode::Window(_) => return None,
        }
    }
    Some(node)
}

/// Where the tab would land: the half (or the whole) of the window.
fn zone_preview(zone: Zone, cx: &App) -> impl IntoElement {
    let t = tokens(cx);
    let fill = t.ring.opacity(0.3);
    let d = div().absolute().bg(fill).rounded(t.radius_lg);
    match zone {
        Zone::Center => d.inset_0(),
        Zone::Edge(SplitDirection::Left) => d.top_0().bottom_0().left_0().w(relative(0.5)),
        Zone::Edge(SplitDirection::Right) => d.top_0().bottom_0().right_0().w(relative(0.5)),
        Zone::Edge(SplitDirection::Top) => d.left_0().right_0().top_0().h(relative(0.5)),
        Zone::Edge(SplitDirection::Bottom) => d.left_0().right_0().bottom_0().h(relative(0.5)),
    }
}

impl Render for DockView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let core = cx.core();
        let tabs = core.use_::<TabsModule>();
        let layout = tabs.layout().read();
        self.prune_stale(&layout, cx);

        // Drop the content of tabs that left the layout.
        let open: HashSet<String> = notefig_layout::extract_tab_ids(&layout).into_iter().collect();
        self.contents.retain(|id, _| open.contains(id));
        self.strips.retain(|id, _| notefig_layout::find_window_by_id(&layout, id).is_some());
        if !cx.has_active_drag() {
            self.drop_hint = None;
        }

        // The window rects of the last paint, for `focus_window`.
        tabs.focused_window().set_rects(self.rects.borrow().clone());
        self.rects.borrow_mut().retain(|(id, _)| notefig_layout::find_window_by_id(&layout, id).is_some());

        // The Everything view's recent documents: whatever file tab is in front.
        let active = tabs.active_tab_id();
        if active != self.last_active {
            self.last_active = active.clone();
            // Tab activation focuses the tab's surface once it is up
            // (TS: the arbiter's `when-mounted` intent on select).
            let controllers = tabs.controllers().clone();
            controllers.set_active_tab(active.as_deref());
            if let Some(tab) = active.clone() {
                cx.defer(move |_| {
                    controllers.request_focus(&tab, notefig_tabs::FocusTiming::WhenMounted, false);
                });
            }
            if let Some(path) = active.filter(|a| notefig_tabs::is_file_tab_id(a)) {
                let touch = core.use_::<RecentDocumentsModule>().touch(&path, notefig_recent_documents::now_ms());
                cx.foreground_executor().spawn(async move { let _ = touch.await; }).detach();
            }
        }

        let body = if layout.is_empty() {
            // `DockArea` with no tabs: the header row, then the message.
            div()
                .flex()
                .flex_col()
                .flex_1()
                .gap(t.shell_gap)
                .child(
                    notefig_ui::card(cx)
                        .relative()
                        .flex()
                        .flex_none()
                        .h(t.header_height + px(2.))
                        .overflow_hidden()
                        .when(self.sidebar_collapsed, |d| d.mr(sp(2.)))
                        .when(!self.sidebar_collapsed, |d| d.mx(sp(2.)))
                        .child(div().absolute().inset_0().bg(t.chrome_wash))
                        .child(self.collapsed_header(cx)),
                )
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .p(sp(4.))
                        .text_color(t.muted_foreground)
                        .text_size(t.text_sm)
                        .child(tr("noFileSelected")),
                )
                .into_any_element()
        } else {
            self.render_children(&layout, Vec::new(), Orientation::Row, window, cx)
        };

        let resizing = self.resize.is_some();
        let axis_cursor = match self.resize.as_ref().map(|r| r.axis) {
            Some(Orientation::Column) => CursorStyle::ResizeUpDown,
            _ => CursorStyle::ResizeLeftRight,
        };
        div()
            .id("dock")
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(body)
            .when(resizing, |d| {
                d.child(drag_capture(
                    window,
                    axis_cursor,
                    cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                        let Some(r) = &this.resize else { return };
                        if r.span <= 0. {
                            return;
                        }
                        let delta = match r.axis {
                            Orientation::Row => f32::from(e.position.x - r.start.x),
                            Orientation::Column => f32::from(e.position.y - r.start.y),
                        };
                        let (a, b) = (r.sizes[r.index], r.sizes[r.index + 1]);
                        let pair = a + b;
                        let moved = (delta / r.span) as f64 * pair;
                        let min = pair * 0.1;
                        let na = (a + moved).clamp(min, pair - min);
                        let mut sizes = r.sizes.clone();
                        sizes[r.index] = na;
                        sizes[r.index + 1] = pair - na;
                        let address = r.address.clone();
                        let tabs = cx.core().use_::<TabsModule>();
                        let next = reduce(&tabs.layout().read(), DockAction::Resize { sizes, address });
                        // Resizes replace the history entry: one per drag.
                        tabs.layout().update(next, notefig_layout::LayoutUpdateOptions { replace: true, params: None });
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _, cx| {
                        this.resize = None;
                        cx.notify();
                    }),
                ))
            })
            .map(|d| {
                let _ = rem(0.);
                d
            })
    }
}

