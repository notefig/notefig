//! The shadcn controls the settings surfaces use (`@notefig/ui` `Switch`,
//! `Checkbox`, `Select`, `Button`), drawn to the TS sizes with the Notefig
//! tokens. gpui-kit's own controls are smaller and differently shaped, so
//! these are hand-built.

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, anchored, deferred,
    div, prelude::FluentBuilder as _, px,
};
use notefig_ui::{icon, rem, sp, tokens};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `Switch`: `h-[1.15rem] w-8`, thumb `size-4`.
pub fn switch(
    id: impl Into<ElementId>,
    checked: bool,
    disabled: bool,
    on_toggle: impl Fn(bool, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let t = tokens(cx);
    let (w, h, thumb) = (rem(2.), rem(1.15), rem(1.));
    let track = if checked { t.primary } else { t.input };
    let knob = if checked {
        t.background
    } else if t.dark {
        t.foreground
    } else {
        t.background
    };
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .w(w)
        .h(h)
        .px(px(1.))
        .rounded_full()
        .bg(track)
        .when(disabled, |d| d.opacity(0.5))
        .when(!disabled, |d| d.cursor_pointer())
        .when(checked, |d| d.justify_end())
        .child(div().size(thumb).rounded_full().bg(knob))
        .when(!disabled, |d| d.on_click(move |_, window, cx| on_toggle(!checked, window, cx)))
        .into_any_element()
}

/// `Checkbox`: `size-4 rounded-[4px]`, a check on `bg-primary`.
pub fn checkbox(
    id: impl Into<ElementId>,
    checked: bool,
    disabled: bool,
    on_toggle: impl Fn(bool, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let t = tokens(cx);
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(rem(1.))
        .rounded(px(4.))
        .border_1()
        .border_color(if checked { t.primary } else { t.input })
        .when(checked, |d| d.bg(t.primary))
        .when(disabled, |d| d.opacity(0.5))
        .when(checked, |d| d.child(icon("check").size(rem(0.875)).text_color(t.primary_foreground)))
        .when(!disabled, |d| d.cursor_pointer().on_click(move |_, window, cx| on_toggle(!checked, window, cx)))
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonVariant {
    Primary,
    Secondary,
    Ghost,
}

/// `Button size="sm"`: `h-8 rounded-md px-3 gap-1.5 text-sm font-medium`.
pub struct Button {
    id: ElementId,
    variant: ButtonVariant,
    label: SharedString,
    leading: Option<AnyElement>,
    disabled: bool,
    compact: bool,
    on_click: Option<Click>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            variant: ButtonVariant::Secondary,
            label: label.into(),
            leading: None,
            disabled: false,
            compact: false,
            on_click: None,
        }
    }
    pub fn variant(mut self, v: ButtonVariant) -> Self {
        self.variant = v;
        self
    }
    pub fn leading(mut self, el: impl IntoElement) -> Self {
        self.leading = Some(el.into_any_element());
        self
    }
    pub fn disabled(mut self, d: bool) -> Self {
        self.disabled = d;
        self
    }
    /// `h-7 px-2.5 text-xs` (the feedback form's `COMPACT_BUTTON`).
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }
    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Box::new(f));
        self
    }

    pub fn render(self, cx: &App) -> AnyElement {
        let t = tokens(cx);
        let (bg, fg, hover) = match self.variant {
            ButtonVariant::Primary => (t.primary, t.primary_foreground, t.primary.opacity(0.9)),
            ButtonVariant::Secondary => (t.secondary, t.secondary_foreground, t.secondary.opacity(0.8)),
            ButtonVariant::Ghost => (gpui::transparent_black(), t.foreground, t.accent),
        };
        let on_click = self.on_click;
        div()
            .id(self.id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(sp(1.5))
            .h(if self.compact { sp(7.) } else { sp(9.) })
            .px(if self.compact { sp(2.5) } else { sp(3.) })
            .rounded(t.radius_md)
            .bg(bg)
            .text_color(fg)
            .text_size(if self.compact { t.text_xs } else { t.text_sm })
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .when(self.disabled, |d| d.opacity(0.5))
            .when(!self.disabled, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
            .children(self.leading)
            .child(self.label)
            .when_some(on_click.filter(|_| !self.disabled), |d, f| d.on_click(move |e, w, cx| f(e, w, cx)))
            .into_any_element()
    }
}

/// `Select`: a trigger (`h-9 rounded-md border border-input px-3`, the
/// value, a chevron) and, when `open`, its menu of options under it.
#[allow(clippy::too_many_arguments)]
pub fn select(
    id: &'static str,
    width: gpui::Pixels,
    value: &str,
    options: Vec<(String, SharedString)>,
    open: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + 'static,
    on_pick: impl Fn(String, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let t = tokens(cx);
    let label = options
        .iter()
        .find(|(v, _)| v == value)
        .map(|(_, l)| l.clone())
        .unwrap_or_else(|| value.to_string().into());
    let on_toggle = std::rc::Rc::new(on_toggle);
    let on_pick = std::rc::Rc::new(on_pick);
    let toggle = on_toggle.clone();
    let trigger = div()
        .id(ElementId::Name(format!("{id}-trigger").into()))
        .flex()
        .items_center()
        .justify_between()
        .gap(sp(2.))
        .w(width)
        .h(sp(9.))
        .px(sp(3.))
        .rounded(t.radius_md)
        .border_1()
        .border_color(t.input)
        .text_size(t.text_sm)
        .text_color(t.foreground)
        .cursor_pointer()
        .child(div().truncate().child(label))
        .child(icon("chevron-down").size(rem(1.)).text_color(t.muted_foreground).opacity(0.5))
        .on_click(move |_, w, cx| toggle(w, cx));
    let menu = open.then(|| {
        let dismiss = on_toggle.clone();
        let rows = options.into_iter().enumerate().map(|(i, (v, l))| {
            let pick = on_pick.clone();
            let selected = v == value;
            div()
                .id(ElementId::Name(format!("{id}-opt-{i}").into()))
                .flex()
                .items_center()
                .justify_between()
                .gap(sp(2.))
                .py(sp(1.5))
                .pl(sp(2.))
                .pr(sp(2.))
                .rounded(t.radius_sm)
                .text_size(t.text_sm)
                .cursor_pointer()
                .hover(|s| s.bg(t.accent))
                .child(l)
                .when(selected, |d| d.child(icon("check").size(rem(1.)).text_color(t.popover_foreground)))
                .on_click(move |_, w, cx| pick(v.clone(), w, cx))
        });
        deferred(
            anchored().snap_to_window().child(
                div()
                    .id(ElementId::Name(format!("{id}-menu").into()))
                    .occlude()
                    .mt(sp(1.))
                    .min_w(width)
                    .p(sp(1.))
                    .rounded(t.radius_md)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.popover)
                    .text_color(t.popover_foreground)
                    .shadow_md()
                    .children(rows)
                    .on_mouse_down_out(move |_, w, cx| dismiss(w, cx)),
            ),
        )
        .with_priority(1)
    });
    div().flex_none().child(trigger).children(menu).into_any_element()
}

/// `SettingRow`: title and description on the start side, the control on
/// the end side (`flex items-start justify-between gap-4 py-2`).
pub fn setting_row(title: impl Into<SharedString>, description: impl Into<SharedString>, control: impl IntoElement, cx: &App) -> AnyElement {
    let t = tokens(cx);
    div()
        .flex()
        .items_start()
        .justify_between()
        .gap(sp(4.))
        .py(sp(2.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().text_size(t.text_sm).font_weight(FontWeight::MEDIUM).child(title.into()))
                .child(div().text_size(t.text_sm).text_color(t.muted_foreground).child(description.into())),
        )
        .child(div().flex_none().child(control))
        .into_any_element()
}

/// `text-lg font-semibold` headings.
pub fn heading(text: impl Into<SharedString>) -> gpui::Div {
    div().text_size(rem(1.125)).line_height(rem(1.75)).font_weight(FontWeight::SEMIBOLD).child(text.into())
}
