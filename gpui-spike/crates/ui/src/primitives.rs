//! The chrome's building blocks, each a port of a recurring class string in
//! the TS app. Use these rather than re-deriving the look:
//!
//! | primitive | TS |
//! |---|---|
//! | [`card`] | `SHELL_CARD_CLASS`: `rounded-lg border border-border bg-card shadow-sm` |
//! | [`icon`] | a `lucide-react` icon, by its kebab-case name |
//! | [`IconButton`] | the rail's `ColumnButton`, the tool tabs, toolbar buttons: `rounded-md`, `bg-accent` when pressed, `hover:bg-accent/60` |
//! | [`TabStripTab`] | `components/dockable/components/Tab.tsx` |
//! | [`section_header`] | `text-[10px] uppercase tracking-wide text-muted-foreground` labels |
//! | [`list_row`] | a selectable row: `rounded-md`, `hover:bg-accent/60`, `bg-accent` selected |
//! | [`kbd`] | a shortcut hint |
//! | [`separator`] | `SidebarSeparator`: a 1px `bg-border` rule |
//!
//! Sizes come from [`crate::theme`] (`rem`, `sp`, `Tokens`).

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement,
    ParentElement, Pixels, RenderOnce, SharedString, Stateful, StatefulInteractiveElement, Styled,
    Svg, Window, div, prelude::FluentBuilder as _, px, svg,
};
use gpui_kit::component::tooltip::Tooltip;

use crate::theme::{sp, tokens};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A Lucide icon by its file name (`"panel-left-close"`, `"git-branch"`).
/// Size it with `.size(..)` (default: the chrome's `size-3.5`). GPUI's svg
/// does NOT inherit the text colour as `lucide-react`'s `currentColor`
/// does: always give it `.text_color(..)` (or use [`icon_colored`]).
pub fn icon(name: &str) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(sp(3.5)).flex_none()
}

/// [`icon`] in `color`.
pub fn icon_colored(name: &str, color: Hsla) -> Svg {
    icon(name).text_color(color)
}

/// The floating card every piece of shell chrome sits on.
pub fn card(cx: &App) -> Div {
    let t = tokens(cx);
    div()
        .rounded(t.radius_lg)
        .border_1()
        .border_color(t.border)
        .bg(t.card)
        .shadow_sm()
}

/// A 1px rule. Horizontal rules have `mx-2`; vertical ones `my-2`
/// (`SidebarSeparator`); override with margins on the result.
pub fn separator(vertical: bool, cx: &App) -> Div {
    let t = tokens(cx);
    let d = div().flex_none().bg(t.border);
    if vertical { d.w(px(1.)).my(sp(2.)) } else { d.h(px(1.)).mx(sp(2.)) }
}

/// A small caps label over a group of rows.
pub fn section_header(label: impl Into<SharedString>, cx: &App) -> Div {
    let t = tokens(cx);
    div()
        .px(sp(2.))
        .py(sp(1.))
        .text_size(t.text_2xs)
        .font_weight(FontWeight::MEDIUM)
        .text_color(t.muted_foreground)
        .child(label.into().to_uppercase())
}

/// A shortcut hint, e.g. `kbd("⌘P", cx)`.
pub fn kbd(text: impl Into<SharedString>, cx: &App) -> Div {
    let t = tokens(cx);
    div()
        .flex_none()
        .px(sp(1.))
        .rounded(t.radius_sm)
        .border_1()
        .border_color(t.border)
        .bg(t.muted)
        .text_size(t.text_2xs)
        .text_color(t.muted_foreground)
        .child(text.into())
}

/// A selectable row: `rounded-md`, hover tint, `bg-accent` when selected.
/// Add children, padding and a click handler on the result.
pub fn list_row(id: impl Into<ElementId>, selected: bool, cx: &App) -> Stateful<Div> {
    let t = tokens(cx);
    let hover = t.accent_hover;
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(sp(1.5))
        .px(sp(2.))
        .rounded(t.radius_md)
        .text_size(t.text_sm)
        .text_color(t.foreground)
        .cursor_pointer()
        .when(selected, |d| d.bg(t.accent))
        .when(!selected, |d| d.hover(move |s| s.bg(hover)))
}

/// What an [`IconButton`] looks like at rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ButtonStyle {
    /// Transparent, `hover:bg-accent/60`, `bg-accent` when pressed.
    #[default]
    Ghost,
    /// The rail's chips: `hover:bg-accent`; pressed adds `shadow-sm ring-1 ring-border`.
    Rail,
    /// The rail's "+": a dashed border.
    Dashed,
}

/// A square (or `w`×`h`) button holding an icon or any small content: the
/// rail's `ColumnButton`, the sidebar's tool tabs, the toolbar's buttons.
#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    content: Option<AnyElement>,
    icon: Option<(SharedString, Pixels)>,
    width: Pixels,
    height: Pixels,
    pressed: bool,
    disabled: bool,
    style: ButtonStyle,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    /// A button showing the Lucide icon `name` at `size-3.5`, `size-6` square.
    pub fn new(id: impl Into<ElementId>, name: &str) -> Self {
        let mut this = Self::with_content(id, div().into_any_element());
        this.content = None;
        this.icon = Some((name.to_string().into(), sp(3.5)));
        this
    }

    /// The icon's size (`size-4` in the editor toolbar).
    pub fn icon_size(mut self, size: Pixels) -> Self {
        if let Some((_, s)) = &mut self.icon {
            *s = size;
        }
        self
    }

    /// A button around arbitrary content (the rail's letters and logo).
    pub fn with_content(id: impl Into<ElementId>, content: AnyElement) -> Self {
        Self {
            id: id.into(),
            content: Some(content),
            icon: None,
            width: sp(6.),
            height: sp(6.),
            pressed: false,
            disabled: false,
            style: ButtonStyle::Ghost,
            tooltip: None,
            on_click: None,
        }
    }

    pub fn size(mut self, width: Pixels, height: Pixels) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    /// `aria-pressed`: the selected tool, the active toolbar mark.
    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn style(mut self, style: ButtonStyle) -> Self {
        self.style = style;
        self
    }

    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(text.into());
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for IconButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx);
        let (fg, muted, accent, hover, border) =
            (t.foreground, t.muted_foreground, t.accent, t.accent_hover, t.border);
        let rail = self.style == ButtonStyle::Rail;
        let group: SharedString = format!("iconbtn-{:?}", self.id).into();
        let mut el = div()
            .id(self.id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(self.width)
            .h(self.height)
            .rounded(t.radius_md)
            .text_color(if self.pressed { fg } else { muted })
            .group(group.clone())
            .when_some(self.content, |d, c| d.child(c))
            .when_some(self.icon, |d, (name, size)| {
                d.child(
                    icon(&name)
                        .size(size)
                        .text_color(if self.pressed { fg } else { muted })
                        .when(!self.disabled, |s| s.group_hover(group.clone(), move |s| s.text_color(fg))),
                )
            });
        el = match self.style {
            ButtonStyle::Dashed => el.border_1().border_dashed().border_color(border),
            _ => el,
        };
        if self.pressed {
            el = el.bg(accent);
            if rail {
                el = el.shadow_sm().border_1().border_color(border);
            }
        } else if !self.disabled {
            let bg = if rail || self.style == ButtonStyle::Dashed { accent } else { hover };
            el = el.hover(move |s| s.bg(bg).text_color(fg));
        }
        if self.disabled {
            el = el.opacity(0.5);
        } else {
            el = el.cursor_pointer();
            if let Some(f) = self.on_click {
                el = el.on_click(move |e, w, cx| f(e, w, cx));
            }
        }
        if let Some(text) = self.tooltip {
            el = el.tooltip(move |w, cx| Tooltip::new(text.clone()).build(w, cx));
        }
        el
    }
}

/// One tab in a dock window's strip (`Tab.tsx`): the name at `text-xs
/// font-medium`, `px-3`, ruled at the sides when selected; the close
/// button shows on hover (and at half strength on the selected tab).
#[derive(IntoElement)]
pub struct TabStripTab {
    id: ElementId,
    label: SharedString,
    selected: bool,
    dirty: bool,
    leading: Option<AnyElement>,
    on_select: Option<ClickHandler>,
    on_close: Option<ClickHandler>,
}

impl TabStripTab {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, selected: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            selected,
            dirty: false,
            leading: None,
            on_select: None,
            on_close: None,
        }
    }

    /// Show the unsaved dot in place of the close button at rest.
    pub fn dirty(mut self, dirty: bool) -> Self {
        self.dirty = dirty;
        self
    }

    /// An icon before the name (an agent tab's status glyph).
    pub fn leading(mut self, el: impl IntoElement) -> Self {
        self.leading = Some(el.into_any_element());
        self
    }

    /// Selecting runs on mouse down, as `onPointerDown` does in TS.
    pub fn on_select(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(f));
        self
    }

    pub fn on_close(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for TabStripTab {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = tokens(cx);
        let group: SharedString = format!("tab-{:?}", self.id).into();
        let fg = t.foreground;
        let close_hover: Hsla = t.muted_foreground.opacity(0.2);
        let selected = self.selected;
        let dirty = self.dirty;
        let mut tab = div()
            .id(self.id.clone())
            .group(group.clone())
            .relative()
            .flex()
            .flex_none()
            .h_full()
            .items_center()
            .border_x_1()
            .bg(t.background)
            .text_size(t.text_xs)
            .line_height(t.leading_xs)
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .when(selected, |d| d.border_color(t.border).text_color(t.foreground))
            .when(!selected, |d| {
                d.border_color(gpui::transparent_black())
                    .text_color(t.muted_foreground)
                    .opacity(0.7)
                    .hover(move |s| s.opacity(1.).text_color(fg))
            })
            .when_some(self.leading, |d, l| d.child(div().pl(sp(2.)).child(l)))
            .child(div().px(sp(3.)).py(sp(1.5)).whitespace_nowrap().child(self.label));
        if let Some(f) = self.on_select {
            tab = tab.on_mouse_down(gpui::MouseButton::Left, move |e, w, cx| {
                let click = ClickEvent::Mouse(gpui::MouseClickEvent {
                    down: e.clone(),
                    up: gpui::MouseUpEvent {
                        button: e.button,
                        position: e.position,
                        modifiers: e.modifiers,
                        click_count: e.click_count,
                    },
                });
                f(&click, w, cx);
            });
        }
        if let Some(f) = self.on_close {
            let close_id = ElementId::NamedChild(std::sync::Arc::new(self.id.clone()), "close".into());
            let rest = if selected { 0.5 } else { 0. };
            tab = tab.child(
                div()
                    .id(close_id)
                    .mr(sp(1.))
                    .p(sp(0.5))
                    .rounded(t.radius_sm)
                    .relative()
                    .child(icon("x").size(px(14.)).text_color(fg).opacity(if dirty { 0. } else { rest }).group_hover(group.clone(), |s| s.opacity(1.)))
                    .when(dirty, |d| {
                        d.child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .group_hover(group.clone(), |s| s.invisible())
                                .child(div().size(px(7.)).rounded_full().bg(fg.opacity(0.6))),
                        )
                    })
                    .hover(move |s| s.bg(close_hover))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |e, w, cx| {
                        cx.stop_propagation();
                        f(e, w, cx);
                    }),
            );
        }
        tab
    }
}
