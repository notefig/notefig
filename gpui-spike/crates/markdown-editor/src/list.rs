//! Lists as the host's prose draws them (`ProseStyle::list`), in place of the
//! renderer's own: an outside marker hung before the item's edge, the
//! counters in their own colour, a native-looking checkbox for task items,
//! and each item laid out in its own direction (TS `dir="auto"` on `li`).
//!
//! Only the chrome is drawn here. The items' blocks still render through
//! `BlockNode::render`, so their text leaves report the same geometry.
//!
//! Like the TS list (whose `ul dir="auto"` finds no text of its own, every
//! item carrying its own `dir`), the list itself is always left-to-right: it
//! is padded on the left, and a right-to-left item hangs its marker past
//! the right edge.

use std::sync::Arc;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, Div, FontFeatures, Hsla, Image, ImageFormat, IntoElement, ParentElement, Pixels, Styled,
    Window, div, img,
};
use gpui_kit::base::text::editor_host::{BlockNode, FlowPosition, RenderContext};

use super::notefig_view::ListStyle;

/// Whether `text` reads right to left: its first strong character is
/// Hebrew, Arabic or another right-to-left script (CSS `dir="auto"`). Text
/// with no strong character is left to right.
pub(crate) fn is_rtl_text(text: &str) -> bool {
    for c in text.chars() {
        let cp = c as u32;
        let rtl = matches!(cp,
            0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF);
        if rtl {
            return true;
        }
        if c.is_alphabetic() {
            return false;
        }
    }
    false
}

/// An item's direction, from its first paragraph.
fn item_is_rtl(children: &[BlockNode]) -> bool {
    children.iter().find_map(|child| match child {
        BlockNode::Paragraph(p) => Some(p.children().iter().map(|n| n.text()).collect::<String>()),
        _ => None,
    })
    .is_some_and(|text| is_rtl_text(&text))
}

/// A list whose items are all task items.
pub(crate) fn is_task_list(items: &[BlockNode]) -> bool {
    !items.is_empty() && items.iter().all(|i| matches!(i, BlockNode::ListItem { checked: Some(_), .. }))
}

/// What every list in one render shares.
pub(crate) struct ListCx<'a> {
    pub style: &'a ListStyle,
    pub render_cx: &'a RenderContext,
    /// The block gap below a list, and between top-level items when spaced.
    pub gap: Pixels,
    /// Top-level items a block gap apart (`ProseStyle::list_items_spaced`).
    pub spaced: bool,
    pub body: Pixels,
    pub line_height: Pixels,
}

/// A list: `items` numbered from `start`, with the block gap below unless
/// it closes its flow. `depth` is 0 for a list that is not inside an item.
/// A list that `continues` an earlier chunk of the same list keeps the item
/// gap above its first item.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_list(
    items: &[BlockNode],
    ordered: bool,
    start: Option<u32>,
    depth: usize,
    is_last: bool,
    continues: bool,
    lcx: &ListCx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = lcx.style;
    let task = is_task_list(items);
    // Items sit `li`'s 4/14em margin apart, unless a host spaces top-level
    // ones a block gap apart (task items never are).
    let item_gap = if lcx.spaced && depth == 0 && !task { lcx.gap } else { lcx.body * (4. / 14.) };
    let start = start.unwrap_or(1);
    div()
        .w_full()
        .min_w_0()
        .pl(if task { s.task_indent } else { s.indent - s.item_padding })
        .when(!is_last, |d| d.pb(lcx.gap))
        .children(items.iter().enumerate().map(|(ix, item)| {
            let BlockNode::ListItem { children, checked, .. } = item else {
                return div().into_any_element();
            };
            let rtl = item_is_rtl(children);
            let refs: Vec<&BlockNode> = children.iter().collect();
            let body: Vec<AnyElement> = children
                .iter()
                .enumerate()
                .map(|(child_ix, child)| match child {
                    BlockNode::List { children: nested, ordered, start, .. } => {
                        render_list(nested, *ordered, *start, depth + 1, true, false, lcx, window, cx)
                    }
                    _ => {
                        let flow = FlowPosition::at(&refs, child_ix, true);
                        child.render(child_ix, flow, lcx.render_cx, window, cx)
                    }
                })
                .collect();
            let content = div()
                .flex_1()
                .min_w_0()
                .when(rtl, |d| d.text_right())
                .when(!rtl, |d| d.text_left())
                .children(body);
            let above = if ix > 0 || continues { item_gap } else { Pixels::ZERO };
            let row = div().w_full().min_w_0().relative().pt(above);
            match checked {
                Some(checked) => row
                    .flex()
                    .when(rtl, |d| d.flex_row_reverse())
                    .items_start()
                    .child(checkbox(*checked, lcx, rtl))
                    .child(content),
                None => {
                    let marker = if ordered {
                        let n = start + ix as u32;
                        // The period follows the number in the item's
                        // direction, as the TS marker's does.
                        let label = if rtl { format!(".{n}") } else { format!("{n}.") };
                        div()
                            .text_color(s.number_color)
                            // A `::marker`'s numbers are tabular.
                            .font_features(FontFeatures(Arc::new(vec![("tnum".into(), 1)])))
                            .child(label)
                            .into_any_element()
                    } else {
                        div()
                            .size(s.bullet_size)
                            .rounded_full()
                            .bg(s.bullet_color)
                            .into_any_element()
                    };
                    let gap = if ordered { s.number_gap } else { s.bullet_gap };
                    row.when(!rtl, |d| d.pl(s.item_padding))
                        .when(rtl, |d| d.pr(s.item_padding))
                        .child(
                            // Hung outside the item's start edge, centred on
                            // its first line.
                            div()
                                .absolute()
                                .top(above)
                                .h(lcx.line_height)
                                .flex()
                                .items_center()
                                .whitespace_nowrap()
                                .when(!rtl, |d| d.right_full().pr(gap))
                                .when(rtl, |d| d.left_full().pl(gap))
                                .child(marker),
                        )
                        .child(content)
                }
            }
            .into_any_element()
        }))
        .into_any_element()
}

/// A task item's checkbox, centred on its first line.
fn checkbox(checked: bool, lcx: &ListCx, rtl: bool) -> Div {
    let c = &lcx.style.checkbox;
    div()
        .flex()
        .flex_none()
        .h(lcx.line_height)
        .items_center()
        .when(!rtl, |d| d.mr(c.gap))
        .when(rtl, |d| d.ml(c.gap))
        .child(
            div()
                .flex()
                .size(c.size)
                .items_center()
                .justify_center()
                .rounded(c.radius)
                .border_1()
                .when(!checked, |d| d.bg(c.fill).border_color(c.border))
                .when(checked, |d| {
                    d.bg(c.checked_fill)
                        .border_color(c.checked_fill)
                        .child(img(check_image(c.check)).size(c.size))
                }),
        )
}

/// The check mark in `color`, kept per colour (the host's theme sets it, so
/// it only changes with the appearance).
fn check_image(color: Hsla) -> Arc<Image> {
    thread_local! {
        static CACHE: std::cell::RefCell<Vec<(Hsla, Arc<Image>)>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some((_, image)) = cache.iter().find(|(c, _)| *c == color) {
            return image.clone();
        }
        let rgba = gpui::Rgba::from(color);
        let hex = format!(
            "#{:02x}{:02x}{:02x}",
            (rgba.r * 255.).round() as u8,
            (rgba.g * 255.).round() as u8,
            (rgba.b * 255.).round() as u8
        );
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="{hex}" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter"/></svg>"#
        );
        let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
        cache.push((color, image.clone()));
        image
    })
}
