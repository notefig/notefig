//! The agent views' shared look: the Tailwind classes and `styles.css`
//! bits `components/agent/*` lean on, ported onto `notefig_ui`'s tokens.
//!
//! Additive API (the settings/widget porter uses it too): sizes as
//! functions of the TS root font (`rem`), the shadcn `Button` variants and
//! sizes ([`button`]), popover and menu frames, and the colour mixes the TS
//! writes as `/40`-style opacities.

use gpui::{
    App, Div, ElementId, FontWeight, Hsla, InteractiveElement, Pixels, Stateful,
    Styled, div, prelude::FluentBuilder as _, px,
};
use notefig_ui::{Tokens, rem, sp, tokens};

/// `text-[0.5625rem]` (9px at the TS 16px base).
pub fn text_9() -> Pixels {
    rem(0.5625)
}

/// `text-[0.625rem]` / `text-[10px]`.
pub fn text_10() -> Pixels {
    rem(0.625)
}

/// `text-[0.6875rem]` / `text-[11px]`.
pub fn text_11() -> Pixels {
    rem(0.6875)
}

/// `leading-relaxed` at a given size.
pub fn leading_relaxed(size: Pixels) -> Pixels {
    size * 1.625
}

/// `leading-snug` at a given size.
pub fn leading_snug(size: Pixels) -> Pixels {
    size * 1.375
}

/// `rounded-xl` (0.75rem).
pub fn radius_xl() -> Pixels {
    rem(0.75)
}

/// `rounded-2xl` (1rem).
pub fn radius_2xl() -> Pixels {
    rem(1.)
}

/// `rounded` (0.25rem).
pub fn radius_default() -> Pixels {
    rem(0.25)
}

/// The mono font (`font-mono`).
pub fn mono() -> &'static str {
    notefig_ui::theme::FONT_MONO
}

/// `bg-background bg-gradient-to-b from-X/a to-X/a`: a tint laid over an
/// opaque base (the TS trick so a floating card hides what is under it),
/// flattened to one colour.
pub fn tint_over(base: Hsla, tint: Hsla, opacity: f32) -> Hsla {
    let b = gpui::Rgba::from(base);
    let t = gpui::Rgba::from(tint);
    let mix = |x: f32, y: f32| x * (1. - opacity) + y * opacity;
    Hsla::from(gpui::Rgba {
        r: mix(b.r, t.r),
        g: mix(b.g, t.g),
        b: mix(b.b, t.b),
        a: 1.,
    })
}

/// shadcn `Button`'s `variant`.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ButtonVariant {
    /// `bg-primary text-primary-foreground hover:bg-primary/90`.
    #[default]
    Default,
    /// `border border-input bg-background hover:bg-accent`.
    Outline,
    /// `hover:bg-accent`.
    Ghost,
    /// `bg-secondary hover:bg-secondary/80`.
    Secondary,
    /// `bg-destructive text-destructive-foreground`.
    Destructive,
}

/// shadcn `Button`'s `size`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ButtonSize {
    /// `h-10 px-4 py-2`.
    #[default]
    Default,
    /// `h-9 rounded-md px-3`.
    Sm,
    /// `h-10 w-10`.
    Icon,
}

/// A shadcn `<Button>`: `inline-flex items-center justify-center gap-2
/// rounded-md text-sm font-medium`, its variant and size, and
/// `disabled:opacity-50`. Add children and a click handler on the result.
pub fn button(
    id: impl Into<ElementId>,
    variant: ButtonVariant,
    size: ButtonSize,
    disabled: bool,
    cx: &App,
) -> Stateful<Div> {
    let t = tokens(cx);
    let (bg, fg, hover_bg, border) = variant_colors(t, variant);
    let el = div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(sp(2.))
        .rounded(t.radius_md)
        .text_size(t.text_sm)
        .font_weight(FontWeight::MEDIUM)
        .whitespace_nowrap()
        .text_color(fg)
        .when_some(bg, |d, bg| d.bg(bg))
        .when_some(border, |d, b| d.border_1().border_color(b));
    let el = match size {
        ButtonSize::Default => el.h(sp(10.)).px(sp(4.)).py(sp(2.)),
        ButtonSize::Sm => el.h(sp(9.)).px(sp(3.)),
        ButtonSize::Icon => el.size(sp(10.)),
    };
    if disabled {
        return el.opacity(0.5);
    }
    let hover_fg = matches!(variant, ButtonVariant::Outline | ButtonVariant::Ghost).then_some(t.accent_foreground);
    el.cursor_pointer().hover(move |s| {
        let s = s.bg(hover_bg);
        match hover_fg {
            Some(fg) => s.text_color(fg),
            None => s,
        }
    })
}

fn variant_colors(t: &Tokens, variant: ButtonVariant) -> (Option<Hsla>, Hsla, Hsla, Option<Hsla>) {
    match variant {
        ButtonVariant::Default => (Some(t.primary), t.primary_foreground, t.primary.opacity(0.9), None),
        ButtonVariant::Outline => (Some(t.background), t.foreground, t.accent, Some(t.input)),
        ButtonVariant::Ghost => (None, t.foreground, t.accent, None),
        ButtonVariant::Secondary => (Some(t.secondary), t.secondary_foreground, t.secondary.opacity(0.8), None),
        ButtonVariant::Destructive => {
            (Some(t.destructive), t.destructive_foreground, t.destructive.opacity(0.9), None)
        }
    }
}

/// The floating popover frame (`PopoverContent`, `DropdownMenuContent`):
/// `rounded-md border bg-popover text-popover-foreground shadow-md`.
pub fn popover_frame(cx: &App) -> Div {
    let t = tokens(cx);
    div()
        .rounded(t.radius_md)
        .border_1()
        .border_color(t.border)
        .bg(t.popover)
        .text_color(t.popover_foreground)
        .shadow_md()
}

/// A menu row (`DropdownMenuItem`, `ContextMenuItem`, `CommandItem`):
/// `rounded-sm px-2 py-1.5 text-sm gap-2`, `bg-accent` when highlighted
/// or hovered.
pub fn menu_item(id: impl Into<ElementId>, highlighted: bool, cx: &App) -> Stateful<Div> {
    let t = tokens(cx);
    let accent = t.accent;
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(sp(2.))
        .px(sp(2.))
        .py(sp(1.5))
        .rounded(t.radius_sm)
        .text_size(t.text_sm)
        .cursor_pointer()
        .when(highlighted, |d| d.bg(accent))
        .hover(move |s| s.bg(accent))
}

/// A hairline rule (`border-t border-border`).
pub fn rule(cx: &App) -> Div {
    div().h(px(1.)).w_full().flex_none().bg(tokens(cx).border)
}

/// Where a floating panel opens from its trigger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopoverSide {
    /// `side="top" align="end"`: above, right edges aligned.
    AboveEnd,
    /// `side="top" align="start"`.
    AboveStart,
    /// `side="bottom" align="start"`.
    BelowStart,
    /// `side="bottom" align="end"`.
    BelowEnd,
}

/// A floating panel anchored to the element it is a child of (give that
/// element `.relative()`): drawn above everything (`deferred`), kept on
/// screen, `sideOffset` 4px. `content` brings its own frame
/// ([`popover_frame`]) and its own `on_mouse_down_out` to dismiss.
pub fn anchored_popover(side: PopoverSide, content: impl gpui::IntoElement) -> gpui::AnyElement {
    use gpui::{Anchor as Corner, IntoElement as _, ParentElement as _, anchored, deferred};
    let gap = px(4.);
    let (corner, at) = match side {
        PopoverSide::AboveEnd => (Corner::BottomRight, div().absolute().top_0().right_0()),
        PopoverSide::AboveStart => (Corner::BottomLeft, div().absolute().top_0().left_0()),
        PopoverSide::BelowStart => (Corner::TopLeft, div().absolute().bottom_0().left_0()),
        PopoverSide::BelowEnd => (Corner::TopRight, div().absolute().bottom_0().right_0()),
    };
    let offset = match side {
        PopoverSide::AboveEnd | PopoverSide::AboveStart => gpui::point(px(0.), -gap),
        _ => gpui::point(px(0.), gap),
    };
    at.child(deferred(anchored().anchor(corner).offset(offset).snap_to_window_with_margin(px(8.)).child(content)).with_priority(1))
        .into_any_element()
}
