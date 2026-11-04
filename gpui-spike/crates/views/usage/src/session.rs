//! Usage readouts in the chat (`session-usage.tsx`): the session's running
//! total in the composer footer, and what one turn spent under its prompt.
//! Both read rows the agent subsystem writes; the agent view places them.

use gpui::{
    AnyElement, App, FontWeight, InteractiveElement, StatefulInteractiveElement as _, IntoElement, ParentElement, RenderOnce, SharedString, Styled,
    Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::tooltip::Tooltip;
use notefig_agent::usage::{SessionUsage, TurnUsage, Usage};
use notefig_i18n::t;
use notefig_ui::{rem, sp, tokens};

use crate::format::{Locale, format_cost, format_tokens};

/// The app language's number forms.
fn locale(cx: &App) -> Locale {
    use notefig_ui::CoreExt as _;
    cx.core().try_use::<notefig_i18n::I18nModule>().map(|i| Locale::for_language(&i.language())).unwrap_or_default()
}

/// Label/value rows: quiet labels on the left, the numbers set apart on the
/// right so they scan as a column.
fn stat(label: String, value: AnyElement, cx: &App) -> [AnyElement; 2] {
    let t = tokens(cx);
    [
        div().max_w(rem(10.)).truncate().text_size(rem(0.625)).text_color(t.muted_foreground).child(label).into_any_element(),
        div().flex().justify_end().font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(value).into_any_element(),
    ]
}

fn divider(cx: &App) -> [AnyElement; 2] {
    let t = tokens(cx);
    [
        div().my(sp(0.5)).h(px(1.)).bg(t.border).into_any_element(),
        div().my(sp(0.5)).h(px(1.)).bg(t.border).into_any_element(),
    ]
}

fn text(s: String) -> AnyElement {
    div().child(s).into_any_element()
}

fn token_stats(usage: &Usage, with_cost: bool, cx: &App) -> Vec<AnyElement> {
    let loc = locale(cx);
    let tk = &usage.tokens;
    let mut out: Vec<AnyElement> = Vec::new();
    out.extend(stat(t("usageInput"), text(format_tokens(tk.input, &loc)), cx));
    out.extend(stat(t("usageOutput"), text(format_tokens(tk.output + tk.thought, &loc)), cx));
    if tk.cache_read > 0.0 || tk.cache_write > 0.0 {
        out.extend(stat(t("usageCacheRead"), text(format_tokens(tk.cache_read, &loc)), cx));
        out.extend(stat(t("usageCacheWrite"), text(format_tokens(tk.cache_write, &loc)), cx));
    }
    if with_cost && let Some(cost) = &usage.cost {
        out.extend(divider(cx));
        out.extend(stat(t("usageCost"), text(format_cost(cost, &loc)), cx));
    }
    out
}

/// A two-column grid (`grid-cols-[auto_auto] gap-x-4 gap-y-0.5`), laid out
/// as rows of pairs.
fn stat_grid(cells: Vec<AnyElement>) -> gpui::Div {
    let mut rows = div().flex().flex_col().gap(sp(0.5));
    let mut it = cells.into_iter();
    while let (Some(a), Some(b)) = (it.next(), it.next()) {
        rows = rows.child(div().flex().items_baseline().justify_between().gap(sp(4.)).child(a).child(b));
    }
    rows
}

/// What the session has spent, as the chip's popover shows it.
pub fn session_usage_details(usage: &SessionUsage, cx: &App) -> gpui::Div {
    let loc = locale(cx);
    let mut cells: Vec<AnyElement> = Vec::new();
    let t_ = tokens(cx).clone();
    if let Some(context) = usage.context {
        cells.extend(stat(
            t("usageContext"),
            div()
                .flex()
                .child(format_tokens(context.used, &loc))
                .child(
                    div()
                        .font_weight(FontWeight::NORMAL)
                        .text_color(t_.muted_foreground)
                        .child(format!(" / {}", format_tokens(context.size, &loc))),
                )
                .into_any_element(),
            cx,
        ));
    }
    if usage.turns > 0 {
        cells.extend(token_stats(&usage.total, true, cx));
    }
    if usage.by_model.len() > 1 {
        cells.extend(divider(cx));
        for row in &usage.by_model {
            cells.extend(stat(
                row.model.clone().unwrap_or_else(|| t("usageUnknownModel")),
                text(format_tokens(row.usage.tokens.total(), &loc)),
                cx,
            ));
        }
    }
    stat_grid(cells).text_size(rem(0.6875))
}

/// Composer footer: tokens in context against the window's limit; a click
/// opens what the session has spent. Before the harness reports a context
/// window, the session's token total stands in.
#[derive(IntoElement)]
pub struct SessionUsageChip {
    id: SharedString,
    usage: Option<SessionUsage>,
}

impl SessionUsageChip {
    pub fn new(id: impl Into<SharedString>, usage: Option<SessionUsage>) -> Self {
        Self { id: id.into(), usage }
    }
}

impl RenderOnce for SessionUsageChip {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let Some(usage) = self.usage.filter(|u| u.turns > 0 || u.context.is_some()) else {
            return div().into_any_element();
        };
        let t_ = tokens(cx).clone();
        let loc = locale(cx);
        let label = match usage.context {
            Some(c) => format!("{} / {}", format_tokens(c.used, &loc), format_tokens(c.size, &loc)),
            None => format_tokens(usage.total.tokens.total(), &loc),
        };
        let trigger = Button::new(self.id.clone())
            .ghost()
            .h(sp(4.))
            .px(sp(1.))
            .text_size(rem(0.5625))
            .text_color(t_.muted_foreground)
            .tooltip(t("usageSessionTitle"))
            .child(label);
        Popover::new(SharedString::from(format!("{}-details", self.id)))
            .anchor(gpui::Anchor::BottomRight)
            .trigger(trigger)
            .content(move |_, _, cx| {
                div().min_w(rem(10.)).max_w(rem(18.)).child(session_usage_details(&usage, cx))
            })
            .into_any_element()
    }
}

/// Under a prompt: what its turn spent, in tokens. Live turns only —
/// replayed ones carry no usage, so nothing renders rather than a wrong zero.
#[derive(IntoElement)]
pub struct TurnUsageLabel {
    id: SharedString,
    usage: Option<TurnUsage>,
}

impl TurnUsageLabel {
    pub fn new(id: impl Into<SharedString>, usage: Option<TurnUsage>) -> Self {
        Self { id: id.into(), usage }
    }
}

impl RenderOnce for TurnUsageLabel {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let Some(usage) = self.usage else { return div().into_any_element() };
        let t_ = tokens(cx).clone();
        let loc = locale(cx);
        let total = usage.total.clone();
        div()
            .id(self.id)
            .text_size(rem(0.625))
            .text_color(t_.muted_foreground)
            .child(format!("{} {}", format_tokens(usage.total.tokens.total(), &loc), t("usageTokensUnit")))
            .tooltip(move |window, cx| {
                let total = total.clone();
                Tooltip::element(move |_, cx| stat_grid(token_stats(&total, false, cx)).text_size(rem(0.6875))).build(window, cx)
            })
            .when(false, |d| d)
            .into_any_element()
    }
}
