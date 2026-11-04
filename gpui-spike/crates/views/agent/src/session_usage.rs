//! `session-usage.tsx` (+ `utils/usage-format.ts`): the session's running
//! total in the composer footer (the context meter), and what one turn
//! spent under its prompt. Both read rows the agent subsystem writes: the
//! task row's `usage` (durable) and a turn's `usage` (in memory).

use gpui::{
    AnyElement, App, AppContext as _, ElementId, FontWeight, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _,
};
use notefig_agent::usage::{Cost, CostType, SessionUsage, TurnUsage, Usage};
use notefig_i18n::t as tr;
use notefig_ui::{rem, sp, tokens};

use crate::style::{PopoverSide, anchored_popover, popover_frame, radius_default, text_9, text_10, text_11};

/// `formatTokens`: 950 · 12.3k · 4.5M.
pub fn format_tokens(count: f64) -> String {
    fn trim(value: f64) -> String {
        if value >= 100. {
            format!("{value:.0}")
        } else {
            let s = format!("{value:.1}");
            s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
        }
    }
    if count < 1000. {
        format!("{}", count.round())
    } else if count < 1_000_000. {
        format!("{}k", trim(count / 1000.))
    } else {
        format!("{}M", trim(count / 1_000_000.))
    }
}

/// `formatCost`: $0.34 · $0.0021 · 12.5 credits. Money keeps two
/// significant digits when small; credits are a plain count.
///
/// Deviation: `Intl.NumberFormat` with the user's locale is not available;
/// the common ISO codes get their symbol, anything else trails its code.
pub fn format_cost(money: &Cost) -> String {
    if money.kind == CostType::Credits {
        let s = format!("{:.2}", money.amount);
        let s = s.trim_end_matches('0').trim_end_matches('.');
        return format!("{s} credits");
    }
    let digits = if money.amount != 0. && money.amount.abs() < 0.01 { 4 } else { 2 };
    let amount = format!("{:.*}", digits, money.amount.abs());
    let sign = if money.amount < 0. { "-" } else { "" };
    let symbol = match money.currency.to_ascii_uppercase().as_str() {
        "USD" => Some("$"),
        "EUR" => Some("€"),
        "GBP" => Some("£"),
        "JPY" => Some("¥"),
        _ => None,
    };
    match symbol {
        Some(sym) => format!("{sign}{sym}{amount}"),
        None => format!("{sign}{amount} {}", money.currency),
    }
}

/// What the composer's chip reads: the context fill against the window, or
/// the session's token total before a context window is reported. `None`
/// renders nothing (no turns yet and no context).
pub fn session_chip_label(usage: Option<&SessionUsage>) -> Option<String> {
    let usage = usage?;
    if usage.turns == 0 && usage.context.is_none() {
        return None;
    }
    Some(match usage.context {
        Some(c) => format!("{} / {}", format_tokens(c.used), format_tokens(c.size)),
        None => format_tokens(usage.total.tokens.total()),
    })
}

/// One `label value` row of a stat grid.
#[derive(Clone, Debug, PartialEq)]
pub enum StatRow {
    Stat { label: String, value: String, suffix: Option<String> },
    Divider,
}

fn stat(label: impl Into<String>, value: impl Into<String>) -> StatRow {
    StatRow::Stat { label: label.into(), value: value.into(), suffix: None }
}

/// `TokenStats`.
pub fn token_stats(usage: &Usage, with_cost: bool) -> Vec<StatRow> {
    let tokens = &usage.tokens;
    let mut rows = vec![
        stat(tr("usageInput"), format_tokens(tokens.input)),
        stat(tr("usageOutput"), format_tokens(tokens.output + tokens.thought)),
    ];
    if tokens.cache_read > 0. || tokens.cache_write > 0. {
        rows.push(stat(tr("usageCacheRead"), format_tokens(tokens.cache_read)));
        rows.push(stat(tr("usageCacheWrite"), format_tokens(tokens.cache_write)));
    }
    if with_cost && let Some(cost) = &usage.cost {
        rows.push(StatRow::Divider);
        rows.push(stat(tr("usageCost"), format_cost(cost)));
    }
    rows
}

/// The chip popover's rows: context, the session's tokens and cost, and a
/// per-model split when more than one model ran.
pub fn session_stats(usage: &SessionUsage) -> Vec<StatRow> {
    let mut rows = Vec::new();
    if let Some(c) = usage.context {
        rows.push(StatRow::Stat {
            label: tr("usageContext"),
            value: format_tokens(c.used),
            suffix: Some(format!(" / {}", format_tokens(c.size))),
        });
    }
    if usage.turns > 0 {
        rows.extend(token_stats(&usage.total, true));
    }
    if usage.by_model.len() > 1 {
        rows.push(StatRow::Divider);
        for row in &usage.by_model {
            rows.push(stat(
                row.model.clone().unwrap_or_else(|| tr("usageUnknownModel")),
                format_tokens(row.usage.tokens.total()),
            ));
        }
    }
    rows
}

/// `StatGrid`: quiet labels left, the numbers set apart on the right.
pub fn stat_grid(rows: &[StatRow], cx: &App) -> AnyElement {
    let t = tokens(cx);
    let (muted, fg, border) = (t.muted_foreground, t.foreground, t.border);
    let mut labels = div().flex().flex_col().gap(sp(0.5)).flex_none();
    let mut values = div().flex().flex_col().gap(sp(0.5)).items_end().flex_none();
    let mut out = div().flex().flex_col();
    let flush = |labels: &mut gpui::Div, values: &mut gpui::Div, out: &mut gpui::Div| {
        let l = std::mem::replace(labels, div().flex().flex_col().gap(sp(0.5)).flex_none());
        let v = std::mem::replace(values, div().flex().flex_col().gap(sp(0.5)).items_end().flex_none());
        let section = div().flex().gap(sp(4.)).justify_between().child(l).child(v);
        *out = std::mem::replace(out, div()).child(section);
    };
    for row in rows {
        match row {
            StatRow::Stat { label, value, suffix } => {
                labels = labels.child(
                    div().h(rem(1.)).flex().items_end().max_w(rem(10.)).truncate().text_size(text_10()).text_color(muted).child(label.clone()),
                );
                values = values.child(
                    div()
                        .h(rem(1.))
                        .flex()
                        .items_end()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(value.clone())
                        .when_some(suffix.clone(), |d, s| {
                            d.child(div().font_weight(FontWeight::NORMAL).text_color(muted).child(s))
                        }),
                );
            }
            StatRow::Divider => {
                flush(&mut labels, &mut values, &mut out);
                out = out.child(div().my(sp(0.5)).h(gpui::px(1.)).bg(border));
            }
        }
    }
    flush(&mut labels, &mut values, &mut out);
    out.into_any_element()
}

/// `SessionUsageChip`: the context meter in the composer footer; a click
/// opens what the session has spent. `open` and `on_toggle` are the
/// popover's state, which the composer holds.
pub fn session_usage_chip(
    id: impl Into<ElementId>,
    usage: Option<&SessionUsage>,
    open: bool,
    on_toggle: impl Fn(bool, &mut Window, &mut App) + 'static,
    cx: &App,
) -> Option<AnyElement> {
    let label = session_chip_label(usage)?;
    let usage = usage?.clone();
    let t = tokens(cx);
    let (muted, fg, accent) = (t.muted_foreground, t.foreground, t.accent);
    let on_toggle = std::rc::Rc::new(on_toggle);
    let toggle = on_toggle.clone();
    let chip = div()
        .id(id)
        .flex()
        .h(sp(4.))
        .items_center()
        .px(sp(1.))
        .rounded(radius_default())
        .text_size(text_9())
        .line_height(sp(4.))
        .text_color(muted)
        .cursor_pointer()
        .when(open, |d| d.bg(accent).text_color(fg))
        .hover(move |s| s.bg(accent).text_color(fg))
        .child(label)
        .on_click(move |_, window, cx| toggle(!open, window, cx));
    let panel = open.then(|| {
        let close = on_toggle.clone();
        anchored_popover(
            PopoverSide::AboveEnd,
            popover_frame(cx)
                .id("session-usage-details")
                .min_w(rem(10.))
                .max_w(rem(18.))
                .p(sp(2.))
                .text_size(text_11())
                .child(stat_grid(&session_stats(&usage), cx))
                .on_mouse_down_out(move |_, window, cx| close(false, window, cx)),
        )
    });
    Some(div().relative().child(chip).children(panel).into_any_element())
}

/// `TurnUsageLabel`: under a prompt, what its turn spent, with the split in
/// a tooltip. Live turns only: replayed ones carry no usage.
pub fn turn_usage_label(id: impl Into<ElementId>, usage: Option<&TurnUsage>, cx: &App) -> Option<AnyElement> {
    let usage = usage?.clone();
    let t = tokens(cx);
    let text: SharedString = format!("{} {}", format_tokens(usage.total.tokens.total()), t_unit()).into();
    Some(
        div()
            .id(id)
            .text_size(text_10())
            .text_color(t.muted_foreground)
            .child(text)
            .tooltip(move |_window, cx| {
                let rows = token_stats(&usage.total, false);
                cx.new(|_| UsageTooltip { rows }).into()
            })
            .into_any_element(),
    )
}

fn t_unit() -> String {
    tr("usageTokensUnit")
}

struct UsageTooltip {
    rows: Vec<StatRow>,
}

impl gpui::Render for UsageTooltip {
    fn render(&mut self, _: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        popover_frame(cx).p(sp(2.)).text_size(text_11()).child(stat_grid(&self.rows, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_agent::usage::{ContextWindow, ModelUsage, TokenCounts};

    #[test]
    fn tokens_format_compactly() {
        assert_eq!(format_tokens(950.), "950");
        assert_eq!(format_tokens(12_345.), "12.3k");
        assert_eq!(format_tokens(12_000.), "12k");
        assert_eq!(format_tokens(200_000.), "200k");
        assert_eq!(format_tokens(4_500_000.), "4.5M");
        assert_eq!(format_tokens(123_456_789.), "123M");
    }

    #[test]
    fn cost_formats_money_and_credits() {
        let usd = |amount| Cost { amount, currency: "USD".into(), kind: CostType::Currency };
        assert_eq!(format_cost(&usd(0.34)), "$0.34");
        assert_eq!(format_cost(&usd(0.0021)), "$0.0021");
        assert_eq!(format_cost(&usd(0.)), "$0.00");
        assert_eq!(format_cost(&Cost { amount: 12.5, currency: "credits".into(), kind: CostType::Credits }), "12.5 credits");
        assert_eq!(format_cost(&Cost { amount: 1., currency: "XYZ".into(), kind: CostType::Currency }), "1.00 XYZ");
    }

    fn session(turns: u64, context: Option<ContextWindow>) -> SessionUsage {
        SessionUsage {
            total: Usage { tokens: TokenCounts { input: 1000., output: 500., ..Default::default() }, cost: None },
            by_model: vec![],
            turns,
            context,
        }
    }

    #[test]
    fn chip_reads_context_then_total_then_nothing() {
        assert_eq!(session_chip_label(None), None);
        assert_eq!(session_chip_label(Some(&session(0, None))), None);
        assert_eq!(session_chip_label(Some(&session(2, None))).as_deref(), Some("1.5k"));
        let ctx = Some(ContextWindow { used: 12_100., size: 200_000. });
        assert_eq!(session_chip_label(Some(&session(0, ctx))).as_deref(), Some("12.1k / 200k"));
    }

    #[test]
    fn stats_list_cache_cost_and_models() {
        let mut usage = session(1, None);
        usage.total.tokens.cache_read = 10.;
        usage.total.cost = Some(Cost { amount: 0.5, currency: "USD".into(), kind: CostType::Currency });
        usage.by_model = vec![
            ModelUsage { model: Some("opus".into()), usage: Usage::default() },
            ModelUsage { model: None, usage: Usage::default() },
        ];
        let rows = session_stats(&usage);
        let labels: Vec<String> = rows
            .iter()
            .map(|r| match r {
                StatRow::Stat { label, .. } => label.clone(),
                StatRow::Divider => "-".into(),
            })
            .collect();
        assert_eq!(labels, ["Input", "Output", "Cache read", "Cache write", "-", "Cost", "-", "opus", "Unknown model"]);
    }

    #[test]
    fn cache_rows_only_when_cached() {
        let usage = Usage { tokens: TokenCounts { input: 5., ..Default::default() }, cost: None };
        assert_eq!(token_stats(&usage, true).len(), 2);
    }
}
