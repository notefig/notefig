//! The document typography of the TS editor: `prose prose-sm
//! dark:prose-invert` (@tailwindcss/typography) plus `tiptap.css`, as the
//! markdown editor's [`ProseStyle`].
//!
//! `prose-sm` is written in 14px design units scaled by the root font size
//! (`rem(14)` = 0.875rem); at the app's 24px root that is ×1.5: 21px body on
//! 36px lines. Vertical rhythm follows the CSS after margin collapsing:
//! `.ProseMirror > * + * { margin-top: .75em }` loses to the larger bottom
//! margins, so paragraphs, list items (their `<p>`s carry 16/14em) and
//! lists all land 24px apart; `h1` leaves 36px below itself; `h2 + *` and
//! `h3 + *` start flush.

use gpui::{App, FontWeight, HighlightStyle, Hsla, Pixels, Rgba, StyleRefinement, Styled as _, div, px, relative, rems};
use gpui_kit::base::text::TextViewStyle;
use markdown_editor::{CheckboxStyle, ListStyle, ProseStyle, QuoteStyle};
use notefig_ui::Tokens;

/// One prose-sm design px at the app's root (24 / 16).
const U: f32 = 1.5;

fn d(v: f32) -> Pixels {
    px(v * U)
}

fn hex(c: u32) -> Hsla {
    Hsla::from(Rgba::from(gpui::rgb(c)))
}

/// The typography plugin's gray palette roles (`prose` / `prose-invert`).
struct Colors {
    body: Hsla,
    headings: Hsla,
    bullets: Hsla,
    counters: Hsla,
    quotes: Hsla,
    quote_borders: Hsla,
    code: Hsla,
}

fn colors(dark: bool) -> Colors {
    if dark {
        Colors {
            body: hex(0xd1d5db),
            headings: hex(0xffffff),
            bullets: hex(0x4b5563),
            counters: hex(0x9ca3af),
            quotes: hex(0xf3f4f6),
            quote_borders: hex(0x374151),
            code: hex(0xffffff),
        }
    } else {
        Colors {
            body: hex(0x374151),
            headings: hex(0x111827),
            bullets: hex(0xd1d5db),
            counters: hex(0x6b7280),
            quotes: hex(0x111827),
            quote_borders: hex(0xe5e7eb),
            code: hex(0x111827),
        }
    }
}

/// The body text colour (`--tw-prose-body`), set as the editor's
/// foreground; the caret stays full contrast (`tiptap.css`).
pub(crate) fn body_color(t: &Tokens) -> Hsla {
    colors(t.dark).body
}

/// The body text's size and line height (set on the editor element).
pub(crate) fn body(_t: &Tokens) -> (Pixels, Pixels) {
    (d(14.), d(24.))
}

pub(crate) fn prose_style(t: &Tokens, rtl: bool, cx: &App) -> ProseStyle {
    let c = colors(t.dark);
    let headings = c.headings;
    let theme = gpui_kit::base::Theme::global(cx);
    // GPUI's rem is 16px; the gap is in rems of it.
    let gap = rems(16. * U / 16.);
    let text = TextViewStyle::from_theme(&theme)
        .with_foreground(c.body)
        .with_muted_foreground(c.bullets)
        .with_border(t.border)
        .with_link(c.headings)
        .with_paragraph_gap(gap)
        .with_heading(move |level| {
            // (size, line height, weight, top, bottom); `None` leaves the
            // renderer's own top gap (which subtracts the previous block's).
            let (size, lh, weight, top, bottom): (f32, f32, FontWeight, Option<f32>, f32) = match level {
                // `.ProseMirror > * + * { margin-top: .75em }` beats
                // prose's heading tops, and collapses into the previous
                // block's 24px: a heading starts one block gap down.
                1 => (30., 36. / 30., FontWeight::EXTRA_BOLD, Some(0.), 24.),
                2 => (20., 28. / 20., FontWeight::BOLD, Some(0.), 16.),
                // h3's 8/18em bottom loses to the next block's .75em top.
                3 => (18., 28. / 18., FontWeight::SEMIBOLD, Some(0.), 10.5),
                _ => (14., 20. / 14., FontWeight::SEMIBOLD, Some(0.), 10.5),
            };
            let mut el = div()
                .text_size(d(size))
                .line_height(relative(lh))
                .font_weight(weight)
                .text_color(headings)
                .pb(d(bottom));
            if let Some(top) = top {
                el = el.pt(d(top));
            }
            let mut el = el;
            el.style().clone()
        })
        .with_code_block({
            // `pre`: 12/14em on 20/12 lines, padded 8/12 × 12/12em, on the
            // muted surface (tiptap.css), rounded 4px. Its `code` is 12/14em
            // of that again (prose sizes `code` everywhere, and `pre code`
            // inherits it), on the `pre`'s lines.
            let mut el = div()
                .bg(t.muted)
                .rounded(d(4.))
                .px(d(12.))
                .py(d(8.))
                .text_size(d(12.) * (12. / 14.))
                .line_height(d(20.));
            el.style().clone()
        })
        .with_table_cell({
            // `th, td { padding: .375rem .5rem }` (tiptap.css) around a <p>
            // that keeps prose's 16/14em margins at the table's 12/14 size.
            let p_margin = 18. * 16. / 14.;
            let mut el = div()
                .px(notefig_ui::rem(0.5))
                .py(notefig_ui::rem(0.375) + px(p_margin))
                .text_size(d(12.))
                .line_height(d(18.));
            el.style().clone()
        })
        .with_table_head({
            let mut el = div().bg(t.muted).font_weight(FontWeight::SEMIBOLD);
            el.style().clone()
        })
        .with_inline_code(HighlightStyle {
            color: Some(c.code),
            font_weight: Some(FontWeight::SEMIBOLD),
            background_color: Some(gpui::transparent_black()),
            ..Default::default()
        });
    let _ = StyleRefinement::default();
    ProseStyle {
        text: Some(text),
        list: ListStyle {
            // `ul { padding-inline-start: 22/14em }` + `li { padding-inline-start: 6/14em }`.
            indent: d(28.),
            item_padding: d(6.),
            // Chrome's outside `disc` marker: a 1/3em disc 13px before the
            // item; a `decimal` one ends in a space.
            bullet_color: c.bullets,
            bullet_size: d(14.) / 3.,
            bullet_gap: px(13.),
            number_color: c.counters,
            number_gap: px(6.),
            // A task list's checkbox sits where a bullet list's text starts
            // less the item padding: `ul { padding-inline-start: 22/14em }`.
            task_indent: d(22.),
            // The native checkbox (13px, Chrome's colours for the
            // `color-scheme`), `gap: 0.5rem` before the text (tiptap.css).
            checkbox: if t.dark {
                CheckboxStyle {
                    size: px(13.),
                    radius: px(2.),
                    gap: notefig_ui::rem(0.5),
                    fill: hex(0x3b3b3b),
                    border: hex(0x858585),
                    checked_fill: hex(0x99c8ff),
                    check: hex(0x3b3b3b),
                }
            } else {
                CheckboxStyle {
                    size: px(13.),
                    radius: px(2.),
                    gap: notefig_ui::rem(0.5),
                    fill: hex(0xffffff),
                    border: hex(0x767676),
                    checked_fill: hex(0x0075ff),
                    check: hex(0xffffff),
                }
            },
        },
        list_items_spaced: true,
        rtl,
        // `hr { margin: 40/14em 0 }` with `hr + * { margin-top: 0 }`.
        rule_below: Some(d(40.)),
        // A list right after an h3+ starts a block gap down (its first
        // item's <p> margin), past the heading's own 10.5px.
        list_top_after_heading: d(16.) - px(10.5),
        quote: Some(QuoteStyle {
            // `border-inline-start-width: .25rem`, `padding-inline-start: 20/18em`.
            bar_width: notefig_ui::rem(0.25),
            bar_color: c.quote_borders,
            padding: px(14. * U * 20. / 18.),
            text_color: c.quotes,
            italic: true,
            // `blockquote { font-weight: 500 }`.
            font_weight: FontWeight::MEDIUM,
            curly_quotes: true,
            // `margin: 24/18em` beyond the 24px block gap already there.
            margin: px((14. * U * 24. / 18. - 16. * U).max(0.)),
        }),
    }
}
