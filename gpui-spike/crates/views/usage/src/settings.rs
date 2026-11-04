//! `UsageSettings` (`usage-settings.tsx`): Settings → Usage. Usage over
//! time — every harness side by side, or one harness by model — beside its
//! breakdown and account limits; the share of input read from cache by day
//! of the week; and the average day hour by hour. Everything reads the
//! usage module's hourly buckets for the chosen range.

use std::rc::Rc;
use std::time::Duration;

use chrono::{Days, Local, TimeZone};
use gpui::{
    AppContext as _,
    AnyElement, App, Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement as _, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use notefig_agent::usage::{CostType, TokenCounts, UsageLimitStatus, UsageLimits};
use notefig_agents::AgentsModule;
use notefig_core::Subscription;
use notefig_harness_adapters::{HarnessAdaptersModule, UsageReporting};
use notefig_i18n::{I18nModule, t, t_args, t_count};
use notefig_ui::{CoreExt as _, icon, rem, sp, tokens};
use notefig_usage::series::{
    GroupKey, UsageGroupBy, UsagePattern, UsageScope, UsageSeries, usage_pattern, usage_series, weekday_tokens,
};
use notefig_usage::{HarnessLimits, UsageApi, UsageModule, start_of_hour};

use crate::charts::{AreaChart, BarChart, Format, OnHover, RadarChart, RadarShape, chart_color};
use crate::format::{
    Locale,
    duration, format_cost, format_cost_compact, format_tokens, hour_label, hour_range, percent, period_labels, until,
    weekday_name,
};
use crate::model::*;

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// Which chart the pointer is over, and where.
#[derive(Default, Clone, Copy)]
struct Hovers {
    detail: Option<usize>,
    pattern: Option<usize>,
    cache: Option<usize>,
}

/// The Usage section. `UsageSettings::new(window, cx)` inside `cx.new`.
pub struct UsageSettings {
    usage: Option<Rc<UsageApi>>,
    /// Metric, range and harness: the controls in the section's title row.
    controls: Entity<UsageControls>,
    /// Drawn here when no settings dialog took them for its title row.
    inline_controls: bool,
    hovers: Hovers,
    /// `useClock(MINUTE_MS)`.
    now: i64,
    /// The bucket ranges asked for, so each loads once.
    requested: Vec<(i64, i64)>,
    _subs: Vec<Subscription>,
    _observe_controls: gpui::Subscription,
    _clock: gpui::Task<()>,
}

impl UsageSettings {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let usage = cx.core().try_use::<UsageModule>();
        // The dialog builds the title-row controls first (`init`); adopt them.
        let taken = cx.try_global::<PendingControls>().and_then(|p| p.0.clone());
        if taken.is_some() {
            cx.set_global(PendingControls(None));
        }
        let inline_controls = taken.is_none();
        let controls = taken.unwrap_or_else(|| cx.new(|_| UsageControls::new()));
        let observe_controls = cx.observe(&controls, |_, _, cx| cx.notify());
        let mut subs = Vec::new();
        if let Some(i18n) = cx.core().try_use::<I18nModule>() {
            subs.push(notefig_ui::observe(cx, move |notify| i18n.subscribe(move || notify())));
        }
        if let Some(usage) = &usage {
            let watched = usage.clone();
            subs.push(notefig_ui::observe(cx, move |notify| watched.subscribe(move || notify())));
            cx.foreground_executor().spawn(usage.preload_limits()).detach();
        }
        // The over-time ranges move on with the clock, by the minute.
        let clock = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(MINUTE_MS as u64)).await;
                if this
                    .update(cx, |this, cx| {
                        this.now = now_ms();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            usage,
            controls,
            inline_controls,
            _observe_controls: observe_controls,
            hovers: Hovers::default(),
            now: now_ms(),
            requested: Vec::new(),
            _subs: subs,
            _clock: clock,
        }
    }

    fn label_of(cx: &App) -> Rc<dyn Fn(&str) -> String> {
        let agents = cx.core().try_use::<AgentsModule>();
        Rc::new(move |id: &str| match &agents {
            Some(agents) => agents.harness_label(id),
            None => notefig_agent::harness::built_in_harnesses()
                .into_iter()
                .find(|h| h.id == id)
                .map(|h| h.label)
                .unwrap_or_else(|| id.to_string()),
        })
    }

    fn active_harnesses(cx: &App) -> Vec<String> {
        match cx.core().try_use::<AgentsModule>() {
            Some(agents) => agents.pickable_harnesses().into_iter().map(|h| h.id).collect(),
            None => vec![],
        }
    }

    /// `useHarnessReporting`: the adapter's declaration, overridden by what
    /// the loaded series and limits show.
    fn reporting_of(by_harness: &UsageSeries, limits: &[String], cx: &App) -> Rc<dyn Fn(&str) -> UsageReporting> {
        let adapters = cx.core().try_use::<HarnessAdaptersModule>();
        let agents = cx.core().try_use::<AgentsModule>();
        let definitions = match &agents {
            Some(agents) => agents.configured_harnesses(),
            None => notefig_agent::harness::built_in_harnesses(),
        };
        let by_harness = by_harness.clone();
        let limits = limits.to_vec();
        Rc::new(move |id: &str| {
            let seen = seen_reporting(&by_harness, &limits, id);
            let def = definitions.iter().find(|h| h.id == id);
            match &adapters {
                Some(adapters) => adapters.reporting(def, seen),
                None => notefig_harness_adapters::reporting_for(def, seen),
            }
        })
    }

    fn hover(&self, set: fn(&mut Hovers, Option<usize>), cx: &mut Context<Self>) -> OnHover {
        let this = cx.entity().downgrade();
        Rc::new(move |index, _, cx| {
            let _ = this.update(cx, |this, cx| {
                let before = (this.hovers.detail, this.hovers.pattern, this.hovers.cache);
                set(&mut this.hovers, index);
                if before != (this.hovers.detail, this.hovers.pattern, this.hovers.cache) {
                    cx.notify();
                }
            });
        })
    }

    fn formatters(unit: &CostUnit, metric: Metric, loc: &Locale) -> (Format, Format) {
        let (l1, l2) = (loc.clone(), loc.clone());
        match metric {
            Metric::Cost => {
                let (u1, u2) = (unit.clone(), unit.clone());
                (
                    Rc::new(move |v| format_cost(&u1.cost(v), &l1)),
                    Rc::new(move |v| format_cost_compact(v, &u2.currency, u2.kind, &l2)),
                )
            }
            Metric::Tokens => (Rc::new(move |v| format_tokens(v, &l1)), Rc::new(move |v| format_tokens(v, &l2))),
        }
    }

    /// The app language's number and date forms (`Intl` in TS).
    fn locale(cx: &App) -> Locale {
        cx.core().try_use::<I18nModule>().map(|i| Locale::for_language(&i.language())).unwrap_or_default()
    }

    // ─── cards ──────────────────────────────────────────────────────────

    fn card(&self, cx: &App) -> gpui::Div {
        let t = tokens(cx);
        div().flex().flex_col().gap(sp(4.)).rounded(t.radius_lg).border_1().border_color(t.border).p(sp(4.)).min_w_0()
    }

    fn title(text: String, cx: &App) -> gpui::Div {
        div().text_size(rem(0.8125)).font_weight(FontWeight::MEDIUM).text_color(tokens(cx).foreground).child(text)
    }

    fn caption(text: String, cx: &App) -> gpui::Div {
        div().text_size(rem(0.625)).text_color(tokens(cx).muted_foreground).child(text)
    }

    fn cap(text: String, cx: &App) -> gpui::Div {
        let t = tokens(cx);
        div()
            .rounded(t.radius_sm)
            .bg(t.muted)
            .px(sp(1.5))
            .py(sp(0.5))
            .text_size(rem(0.625))
            .text_color(t.muted_foreground)
            .child(text)
    }

    fn empty_line(cx: &App) -> AnyElement {
        div().text_size(tokens(cx).text_xs).text_color(tokens(cx).muted_foreground).child(t("usageNoUsageInRange")).into_any_element()
    }
}


/// The section's controls (`UsageControls`): Tokens/Cost, the range and the
/// harness. TS portals them into the section's title row
/// (`SettingsSectionActions`); [`crate::init`] registers them there.
pub struct UsageControls {
    metric: Metric,
    range_days: u32,
    chosen: String,
    open_picker: Option<&'static str>,
    /// The harness picker's options and the harness shown, from the data.
    harness: (Vec<(String, String, bool)>, String),
}

/// Controls built for a dialog's title row, waiting for its section.
pub(crate) struct PendingControls(pub Option<Entity<UsageControls>>);
impl gpui::Global for PendingControls {}

impl UsageControls {
    pub fn new() -> Self {
        Self {
            metric: Metric::Tokens,
            range_days: 30,
            chosen: ALL.to_string(),
            open_picker: None,
            harness: (vec![(ALL.to_string(), t_("usageAllHarnesses"), false)], ALL.to_string()),
        }
    }

    /// Build them for a settings dialog's title row; the section adopts them.
    pub(crate) fn for_title_row(cx: &mut App) -> Entity<Self> {
        let controls = cx.new(|_| Self::new());
        cx.set_global(PendingControls(Some(controls.clone())));
        controls
    }

    // ─── controls ───────────────────────────────────────────────────────

    /// `Segmented`: options side by side, the chosen one lit.
    fn segmented(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx).clone();
        let options = [(Metric::Tokens, t_("usageTokens")), (Metric::Cost, t_("usageCost"))];
        div()
            .flex()
            .items_center()
            .gap(sp(0.5))
            .children(options.into_iter().map(|(metric, label)| {
                let on = metric == self.metric;
                let (accent, hover, fg) = (t.accent, t.accent_hover, t.foreground);
                div()
                    .id(SharedString::from(format!("usage-metric-{label}")))
                    .flex()
                    .items_center()
                    .h(sp(6.))
                    .px(sp(2.))
                    .rounded(t.radius_md)
                    .text_size(t.text_xs)
                    .cursor_pointer()
                    .when(on, |d| d.bg(accent).text_color(fg))
                    .when(!on, |d| d.text_color(t.muted_foreground).hover(move |s| s.bg(hover).text_color(fg)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.metric = metric;
                        cx.notify();
                    }))
                    .child(label)
            }))
            .into_any_element()
    }

    /// `Picker`: a compact menu of choices on a ghost trigger.
    fn picker(
        &self,
        id: &'static str,
        value: &str,
        options: Vec<(String, String, bool)>,
        // Harness options lead with the harness's logo (`HarnessLogo size-3`).
        logos: bool,
        on_change: impl Fn(&mut Self, String) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = tokens(cx).clone();
        let logo = move |v: &str, color: gpui::Hsla| -> Option<AnyElement> {
            (logos && v != ALL).then(|| notefig_view_agent::harness_logo(v, sp(3.), color))
        };
        let current = options.iter().find(|(v, _, _)| v == value).map(|(_, l, _)| l.clone()).unwrap_or_default();
        let open = self.open_picker == Some(id);
        let entity = cx.entity();
        let on_change = Rc::new(on_change);
        let value = value.to_string();
        let trigger = Button::new(SharedString::from(format!("usage-picker-{id}")))
            .ghost()
            .h(sp(6.))
            .px(sp(2.))
            .text_size(t.text_xs)
            .text_color(if open { t.foreground } else { t.muted_foreground })
            .when(open, |b| b.bg(t.accent))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(sp(1.))
                    .text_size(t.text_xs)
                    .font_weight(FontWeight::NORMAL)
                    .children(logo(&value, if open { t.foreground } else { t.muted_foreground }))
                    .child(current)
                    .child(icon("chevron-down").size(sp(3.)).text_color(t.muted_foreground).opacity(0.6)),
            );
        let menu = {
            let t = t.clone();
            let entity = entity.clone();
            div()
                .id(SharedString::from(format!("usage-picker-menu-{id}")))
                .occlude()
                .min_w(rem(9.))
                .p(sp(1.))
                .flex()
                .flex_col()
                .rounded(t.radius_md)
                .border_1()
                .border_color(t.border)
                .bg(t.popover)
                .shadow_md()
                .on_mouse_down_out({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            if this.open_picker == Some(id) {
                                this.open_picker = None;
                                cx.notify();
                            }
                        })
                    }
                })
                .children(options.iter().map(|(v, label, greyed)| {
                    let entity = entity.clone();
                    let on_change = on_change.clone();
                    let picked = v.clone();
                    let selected = *v == value;
                    let accent = t.accent;
                    div()
                        .id(SharedString::from(format!("usage-option-{id}-{v}")))
                        .flex()
                        .items_center()
                        .gap(sp(1.5))
                        .px(sp(2.))
                        .py(sp(1.5))
                        .rounded(t.radius_sm)
                        .text_size(t.text_xs)
                        .text_color(if *greyed { t.muted_foreground } else { t.popover_foreground })
                        .cursor_pointer()
                        .hover(move |s| s.bg(accent))
                        .on_click(move |_, _, cx| {
                            let picked = picked.clone();
                            let on_change = on_change.clone();
                            entity.update(cx, |this, cx| {
                                on_change(this, picked);
                                this.open_picker = None;
                                cx.notify();
                            })
                        })
                        .child(
                            div()
                                .flex()
                                .flex_1()
                                .items_center()
                                .gap(sp(1.5))
                                .whitespace_nowrap()
                                .children(logo(v, if *greyed { t.muted_foreground } else { t.popover_foreground }))
                                .child(label.clone()),
                        )
                        .when(selected, |d| d.child(icon("check").size(sp(3.)).text_color(t.popover_foreground)))
                }))
        };
        div()
            .relative()
            .child(trigger.on_click(move |_, _, cx| {
                entity.update(cx, |this, cx| {
                    this.open_picker = if this.open_picker == Some(id) { None } else { Some(id) };
                    cx.notify();
                })
            }))
            .when(open, |d| {
                // `DropdownMenuContent align="end"`: under the trigger, right-aligned.
                d.child(gpui::deferred(div().absolute().top_full().right_0().mt(sp(1.)).child(menu)).with_priority(1))
            })
            .into_any_element()
    }

}

impl Render for UsageControls {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (options, chosen) = self.harness.clone();
        div()
            .flex()
            .items_center()
            .justify_end()
            .gap(sp(1.))
            .child(self.segmented(cx))
            .child(self.picker(
                "range",
                &self.range_days.to_string(),
                RANGES.iter().map(|d| (d.to_string(), t_count("usageRangeDays", *d as i64), false)).collect(),
                false,
                |this, v| this.range_days = v.parse().unwrap_or(30),
                cx,
            ))
            .child(self.picker("harness", &chosen, options, true, |this, v| this.chosen = v, cx))
    }
}

fn t_(key: &str) -> String {
    t(key)
}

/// Local midnight `days` after the one `at` falls on.
fn local_day(at: i64, days: i64) -> i64 {
    let date = Local.timestamp_millis_opt(at).single().map(|d| d.date_naive()).unwrap_or_default();
    let date = if days >= 0 { date + Days::new(days as u64) } else { date - Days::new((-days) as u64) };
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight"))
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or(at)
}

fn breakdown_row(name: String, color: gpui::Hsla, value: String, share: Option<i64>, muted: bool, cx: &App) -> gpui::Div {
    let t = tokens(cx);
    div()
        .flex()
        .items_center()
        .gap(sp(2.))
        .when(muted, |d| d.opacity(0.6))
        .child(div().size(sp(2.)).flex_none().rounded_full().bg(color))
        .child(div().min_w_0().flex_1().truncate().child(name))
        .child(div().font_weight(FontWeight::MEDIUM).child(value))
        .child(
            div()
                .w(sp(8.))
                .flex()
                .justify_end()
                .text_color(t.muted_foreground)
                .child(share.map(|s| format!("{s}%")).unwrap_or_default()),
        )
}

fn meter(fraction: f64, color: gpui::Hsla, cx: &App) -> gpui::Div {
    let t = tokens(cx);
    div()
        .h(sp(1.5))
        .w_full()
        .overflow_hidden()
        .rounded_full()
        .bg(t.foreground.opacity(0.1))
        .child(div().h_full().rounded_full().w(gpui::relative(fraction.clamp(0.0, 1.0) as f32)).bg(color))
}

fn utilization_color(utilization: f64, cx: &App) -> gpui::Hsla {
    let t = tokens(cx);
    if utilization >= 0.9 {
        t.destructive
    } else if utilization >= 0.7 {
        t.warning
    } else {
        t.foreground
    }
}

fn limit_windows(limits: &UsageLimits, now: i64, cx: &App) -> gpui::Div {
    let t = tokens(cx).clone();
    let mut col = div().flex().flex_col().gap(sp(2.));
    if limits.windows.is_empty() {
        // With no windows to show, a reported warning or block is all there is.
        let (text, color) = match limits.status {
            UsageLimitStatus::Warning => (t_("usageLimitWarning"), t.warning),
            UsageLimitStatus::Blocked => (t_("usageLimitBlocked"), t.destructive),
            _ => (t_("usageLimitsNoWindows"), t.muted_foreground),
        };
        col = col.child(div().text_color(color).child(text));
    }
    for window in &limits.windows {
        // A stored report outlives its windows: one past its reset has
        // started over, whatever it last read.
        let reset = window.resets_at.is_some_and(|r| r <= now as f64);
        let utilization = if reset { 0.0 } else { window.utilization };
        let mut meta: Vec<String> = Vec::new();
        if let Some(d) = window.duration_ms.filter(|d| *d > 0.0) {
            meta.push(t_args("usageWindow", &[("duration", &duration(d))]));
        }
        if reset {
            meta.push(t_("usageWindowReset"));
        } else if let Some(r) = window.resets_at {
            meta.push(t_args("usageResetsIn", &[("time", &until(r, now))]));
        }
        col = col.child(
            div()
                .flex()
                .flex_col()
                .gap(sp(1.))
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .gap(sp(2.))
                        .child(div().font_family(notefig_ui::theme::FONT_MONO).text_size(rem(0.625)).child(window.id.clone()))
                        .child(div().font_weight(FontWeight::MEDIUM).child(if reset {
                            "—".to_string()
                        } else {
                            format!("{}%", (utilization * 100.0).round() as i64)
                        })),
                )
                .child(meter(utilization, utilization_color(utilization, cx), cx))
                .when(!meta.is_empty(), |d| {
                    d.child(div().text_size(rem(0.625)).text_color(t.muted_foreground).child(meta.join(" · ")))
                }),
        );
    }
    col
}

impl Render for UsageSettings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let Some(usage) = self.usage.clone() else {
            return div().text_size(t.text_xs).text_color(t.muted_foreground).child(t_("usageNoUsageInRange")).into_any_element();
        };
        let now = self.now;
        let loc = Self::locale(cx);
        let (metric, range_days, chosen_raw) = {
            let c = self.controls.read(cx);
            (c.metric, c.range_days, c.chosen.clone())
        };
        let grain = grain_of(range_days);
        // `useRanges`: whole local days, and the last seven days to the hour.
        let day_start = local_day(now, 0);
        let range = UsageScope { from: local_day(day_start, -(range_days as i64 - 1)), to: local_day(day_start, 1), harness_id: None };
        let hour_end = start_of_hour(now) + HOUR_MS;
        let pattern_range = (hour_end - PATTERN_DAYS * DAY_MS, hour_end);

        // `useBuckets`: each view's range loads on demand.
        for (from, to) in [(range.from, range.to), pattern_range] {
            if !self.requested.contains(&(from, to)) {
                self.requested.push((from, to));
                cx.foreground_executor().spawn(usage.load_buckets(from, to)).detach();
            }
        }
        let in_range = usage.buckets_in(range.from, range.to);
        let by_harness = usage_series(&in_range, &range, grain, UsageGroupBy::Harness);
        let limits: Vec<HarnessLimits> = usage.limits();
        let limit_ids: Vec<String> = limits.iter().map(|l| l.harness_id.clone()).collect();
        let label_of = Self::label_of(cx);
        let reporting_of = Self::reporting_of(&by_harness, &limit_ids, cx);
        let ids = harness_ids(&by_harness, &Self::active_harnesses(cx), &limit_ids);
        let chosen = if ids.contains(&chosen_raw) { chosen_raw } else { ALL.to_string() };
        let all = chosen == ALL;
        let (scope_harness, group_by) =
            if all { (None, UsageGroupBy::Harness) } else { (Some(chosen.clone()), UsageGroupBy::Model) };
        let pattern = usage_pattern(
            &usage.buckets_in(pattern_range.0, pattern_range.1),
            &UsageScope { from: pattern_range.0, to: pattern_range.1, harness_id: scope_harness.clone() },
            group_by,
        );
        let money = cost_unit_of(by_harness.points.iter().map(|p| &p.slice), |c| c.kind == CostType::Currency)
            .unwrap_or_else(CostUnit::usd);
        let own = if all { None } else { cost_unit_of(pattern.hours.iter().map(|h| &h.slice), |_| true) };
        let ranked = harness_colors(&by_harness);
        let own_color = {
            let ranked = ranked.clone();
            move |k: &GroupKey| color_of(&ranked, k)
        };
        let metric_name = if metric == Metric::Cost { t_("usageCost") } else { t_("usageTokens") };
        let range_name = t_count("usageRangeDays", range_days as i64);
        let grain_name = t_(&format!("usageGrain_{}", if grain == notefig_usage::series::UsageGrain::Week { "week" } else { "day" })).to_lowercase();

        // ── controls: the harness picker's options come from the data ──
        let picker_options: Vec<(String, String, bool)> = std::iter::once((ALL.to_string(), t_("usageAllHarnesses"), false))
            .chain(ids.iter().map(|id| {
                let r = reporting_of(id);
                (id.clone(), label_of(id), (metric == Metric::Cost || !r.limits) && !r.cost)
            }))
            .collect();
        let shown = (picker_options, chosen.clone());
        if self.controls.read(cx).harness != shown {
            self.controls.update(cx, |c, cx| {
                c.harness = shown;
                cx.notify();
            });
        }

        let wide = window.viewport_size().width >= px(1280.);

        // ── detail card ──
        let series = if all {
            by_harness.clone()
        } else {
            usage_series(&in_range, &UsageScope { harness_id: Some(chosen.clone()), ..range.clone() }, grain, UsageGroupBy::Model)
        };
        let reporting = (!all).then(|| reporting_of(&chosen));
        let name = if all { t_("usageAllHarnesses") } else { label_of(&chosen) };
        let unit = if all {
            series.keys.iter().any(|k| shows_metric(Metric::Cost, &*reporting_of, k)).then(|| money.clone())
        } else {
            harness_cost_unit(&series, reporting.unwrap_or_default(), &money)
        };
        let no_cost = metric == Metric::Cost && unit.is_none();
        let unnamed = !all && names_no_models(&series.keys);
        let shown_metric = if no_cost { Metric::Tokens } else { metric };
        let disabled = detail_chart_disabled(no_cost, unnamed, all, &name);
        let description = disabled.as_ref().map(|d| d.note.clone()).unwrap_or_else(|| {
            let m = if shown_metric == Metric::Cost { t_("usageCost") } else { t_("usageTokens") };
            t_args(
                if all { "usageAllDesc" } else { "usageDetailDesc" },
                &[("metric", &m), ("grain", &grain_name), ("range", &range_name)],
            )
        });
        let slices = point_slices(&series.points);
        let other = t_("usageOther");
        let unknown = t_("usageUnknownModel");
        let (shown, without_cost) = if all {
            let r = reporting_of.clone();
            let include = move |k: &GroupKey| shows_metric(shown_metric, &*r, k);
            let lo = label_of.clone();
            let shown = top_series(&slices, &series.keys, shown_metric, &|k| lo(k.as_deref().unwrap_or("")), &other, &include, &own_color);
            let without: Vec<String> = series.keys.iter().flatten().filter(|k| !include(&Some((*k).clone()))).map(|k| label_of(k)).collect();
            (shown, without)
        } else {
            let unknown = unknown.clone();
            (
                top_series(&slices, &series.keys, shown_metric, &move |k| k.clone().unwrap_or_else(|| unknown.clone()), &other, &|_| true, &|_| None),
                vec![],
            )
        };
        let (format, format_axis) = Self::formatters(unit.as_ref().unwrap_or(&money), shown_metric, &loc);
        let week_of = |date: &str| t_args("usageWeekOf", &[("date", date)]);
        let labelled = every_nth(series.points.len());
        let bars: Vec<ChartBar> = series
            .points
            .iter()
            .enumerate()
            .zip(&shown.values)
            .map(|((i, p), values)| {
                let (axis, title) = period_labels(grain, p.start, week_of, &loc);
                ChartBar { axis_label: if labelled(i) { axis } else { String::new() }, title, values: values.clone() }
            })
            .collect();
        let period_chart: AnyElement = if series.points.iter().all(|p| p.slice.turns == 0.0) {
            Self::empty_line(cx)
        } else if let Some(d) = &disabled {
            BarChart {
                id: "usage-chart-detail".into(),
                series: shown.series.clone(),
                bars,
                format: format.clone(),
                format_axis,
                height: rem(13.5),
                overlay: Some(d.overlay.clone()),
                hovered: self.hovers.detail,
                on_hover: self.hover(|h, v| h.detail = v, cx),
            }
            .into_any_element()
        } else {
            AreaChart {
                id: "usage-chart-detail".into(),
                series: shown.series.clone(),
                bars,
                format: format.clone(),
                format_axis,
                height: rem(13.5),
                hovered: self.hovers.detail,
                on_hover: self.hover(|h, v| h.detail = v, cx),
            }
            .into_any_element()
        };
        let harness_title: AnyElement = match reporting {
            None => Self::title(name.clone(), cx).into_any_element(),
            Some(r) => {
                let cost_cap = match &unit {
                    None => t_("usageCapTokensOnly"),
                    Some(u) if u.kind == CostType::Credits => t_("usageCapCredits"),
                    Some(_) => t_("usageCapCost"),
                };
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(sp(1.5))
                    .child(Self::title(name.clone(), cx))
                    .child(Self::cap(cost_cap, cx))
                    .child(Self::cap(if r.limits { t_("usageCapLimits") } else { t_("usageCapNoLimits") }, cx))
                    .into_any_element()
            }
        };
        let detail_card = self
            .card(cx)
            .child(div().child(harness_title).child(Self::caption(description, cx)))
            .child(period_chart);

        // ── breakdown + limits card ──
        let sum: f64 = shown.totals.iter().sum();
        let breakdown: AnyElement = if unnamed {
            div()
                .text_color(t.muted_foreground)
                .opacity(0.6)
                .child(t_args("usageNoModelNames", &[("name", &name)]))
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .gap(sp(2.))
                .when(shown.series.is_empty(), |d| d.child(div().text_color(t.muted_foreground).child(t_("usageNoUsageInRange"))))
                .when(sum > 0.0, |d| {
                    d.child(
                        div()
                            .flex()
                            .h(sp(1.5))
                            .gap(px(1.))
                            .overflow_hidden()
                            .rounded_full()
                            .bg(t.foreground.opacity(0.1))
                            .children(shown.series.iter().zip(&shown.totals).map(|(s, total)| {
                                div().h_full().w(gpui::relative((total / sum) as f32)).bg(chart_color(s.color, cx))
                            })),
                    )
                })
                .children(shown.series.iter().zip(&shown.totals).map(|(s, total)| {
                    breakdown_row(
                        s.name.clone(),
                        chart_color(s.color, cx),
                        format(*total),
                        Some(if sum > 0.0 { (total / sum * 100.0).round() as i64 } else { 0 }),
                        false,
                        cx,
                    )
                }))
                .children(without_cost.iter().map(|h| {
                    breakdown_row(h.clone(), chart_color(ChartColor::Other, cx), t_("usageNoCostData"), None, true, cx)
                }))
                .into_any_element()
        };
        let limits_panel: Option<AnyElement> = match reporting {
            Some(r) if !r.limits => Some(
                div()
                    .text_color(t.muted_foreground)
                    .opacity(0.6)
                    .child(t_args("usageLimitsUnsupported", &[("name", &name)]))
                    .into_any_element(),
            ),
            Some(_) => Some(match limits.iter().find(|l| l.harness_id == chosen) {
                None => div().text_color(t.muted_foreground).child(t_("usageLimitsNone")).into_any_element(),
                Some(row) => limit_windows(&row.limits, now, cx).into_any_element(),
            }),
            None if limits.is_empty() => None,
            None => Some(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(3.))
                    .children(limits.iter().map(|row| {
                        div()
                            .flex()
                            .flex_col()
                            .gap(sp(1.5))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(sp(1.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(notefig_view_agent::harness_logo(&row.harness_id, sp(3.), t.foreground))
                                    .child(label_of(&row.harness_id)),
                            )
                            .child(limit_windows(&row.limits, now, cx))
                    }))
                    .into_any_element(),
            ),
        };
        let breakdown_card = self
            .card(cx)
            .child(Self::title(if all { t_("usageByHarness") } else { t_("usageByModel") }, cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(4.))
                    .text_size(rem(0.625))
                    .child(breakdown)
                    .children(limits_panel),
            );

        // ── cache card ──
        let harnesses = weekday_tokens(&in_range, &UsageScope { harness_id: scope_harness.clone(), ..range.clone() });
        let days: [TokenCounts; 7] = harnesses.iter().fold([TokenCounts::default(); 7], |acc, h| add_days(&acc, &h.days));
        let total = sum_days(&days);
        let whole = total.cache_hit_rate();
        let tokens_now = self.hovers.cache.map(|h| days[h]).unwrap_or(total);
        let rate = tokens_now.cache_hit_rate();
        let counts = t_args(
            "usageCacheDetail",
            &[
                ("read", &format_tokens(tokens_now.cache_read, &loc)),
                ("input", &format_tokens(tokens_now.input + tokens_now.cache_read + tokens_now.cache_write, &loc)),
            ],
        );
        let per_harness = all && harnesses.len() > 1;
        let entries = if per_harness {
            cache_entries(&harnesses, &*label_of, &own_color, &other)
        } else {
            vec![]
        };
        let shapes: Vec<RadarShape> = if per_harness {
            entries
                .iter()
                .map(|e| RadarShape { color: e.color, values: e.days.iter().map(TokenCounts::cache_hit_rate).collect() })
                .collect()
        } else {
            vec![RadarShape { color: ChartColor::Palette(0), values: days.iter().map(TokenCounts::cache_hit_rate).collect() }]
        };
        let hovered_day = self.hovers.cache;
        let cache_card = self
            .card(cx)
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(sp(3.))
                    .child(
                        div()
                            .min_w_0()
                            .child(Self::title(t_("usageCacheTitle"), cx))
                            .when(whole.is_some(), |d| d.child(Self::caption(counts.clone(), cx).truncate())),
                    )
                    .when(whole.is_some(), |d| {
                        d.child(
                            div()
                                .flex_none()
                                .flex()
                                .gap(px(4.))
                                .text_size(rem(0.625))
                                .text_color(t.muted_foreground)
                                .child(match hovered_day {
                                    None => t_("usageCacheHitRate"),
                                    Some(h) => weekday_name(h, &loc),
                                })
                                .child(
                                    div()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(t.foreground)
                                        .child(rate.map(percent).unwrap_or_else(|| "—".into())),
                                ),
                        )
                    }),
            )
            .child(match whole {
                None => Self::empty_line(cx),
                Some(_) => RadarChart {
                    id: "usage-chart-cache".into(),
                    labels: (0..7).map(|i| weekday_name(i, &loc)).collect(),
                    shapes,
                    hovered: hovered_day,
                    on_hover: self.hover(|h, v| h.cache = v, cx),
                }
                .into_any_element(),
            })
            .when(per_harness && whole.is_some(), |d| {
                d.child(div().flex().flex_col().gap(sp(1.)).text_size(rem(0.625)).children(entries.iter().map(|e| {
                    let rate = match hovered_day {
                        None => sum_days(&e.days).cache_hit_rate(),
                        Some(h) => e.days[h].cache_hit_rate(),
                    };
                    div()
                        .flex()
                        .items_center()
                        .gap(sp(2.))
                        .pt(sp(1.))
                        .child(div().size(sp(2.)).flex_none().rounded_full().bg(chart_color(e.color, cx)))
                        .child(div().min_w_0().flex_1().truncate().text_color(t.muted_foreground).child(e.name.clone()))
                        .child(div().font_weight(FontWeight::MEDIUM).child(rate.map(percent).unwrap_or_else(|| "—".into())))
                })))
            });

        // ── pattern card ──
        let pattern_unit = own.unwrap_or_else(|| money.clone());
        let (p_format, p_axis) = Self::formatters(&pattern_unit, metric, &loc);
        let hour_slices: Vec<_> = pattern.hours.iter().map(|h| &h.slice).collect();
        let p_shown = if all {
            let r = reporting_of.clone();
            let m = metric;
            let lo = label_of.clone();
            top_series(&hour_slices, &pattern.keys, m, &|k| lo(k.as_deref().unwrap_or("")), &other, &move |k| shows_metric(m, &*r, k), &own_color)
        } else {
            top_series(&hour_slices, &pattern.keys, metric, &move |k| k.clone().unwrap_or_else(|| unknown.clone()), &other, &|_| true, &|_| None)
        };
        let pattern_empty = p_shown.values.iter().all(|row| row.iter().all(|v| *v == 0.0));
        let pattern_card = self
            .card(cx)
            .child(
                div().child(Self::title(t_("usageDailyPattern"), cx)).child(Self::caption(
                    t_args("usagePatternDesc", &[("metric", &metric_name.to_lowercase()), ("count", &PATTERN_DAYS.to_string())]),
                    cx,
                )),
            )
            .child(if pattern_empty {
                Self::empty_line(cx)
            } else {
                pattern_chart(&pattern, &p_shown, p_format, p_axis, &loc, self.hovers.pattern, self.hover(|h, v| h.pattern = v, cx))
            });

        // `xl:grid-cols-[2fr_1fr]` / `[1fr_2fr]`: side by side when wide.
        let row = |a: gpui::Div, a_grow: f32, b: gpui::Div, b_grow: f32| {
            if wide {
                div().flex().gap(sp(4.)).child(a.flex_grow(a_grow).flex_basis(gpui::relative(0.))).child(b.flex_grow(b_grow).flex_basis(gpui::relative(0.)))
            } else {
                div().flex().flex_col().gap(sp(4.)).child(a).child(b)
            }
        };
        div()
            .id("usage-settings")
            .flex()
            .flex_col()
            .gap(sp(4.))
            .pt(sp(2.))
            .text_color(t.foreground)
            .when(self.inline_controls, |d| d.child(self.controls.clone()))
            .child(row(detail_card, 2., breakdown_card, 1.))
            .child(row(cache_card, 1., pattern_card, 2.))
            .into_any_element()
    }
}

fn pattern_chart(
    pattern: &UsagePattern,
    shown: &ShownSeries,
    format: Format,
    format_axis: Format,
    loc: &Locale,
    hovered: Option<usize>,
    on_hover: OnHover,
) -> AnyElement {
    BarChart {
        id: "usage-chart-pattern".into(),
        series: shown.series.clone(),
        bars: pattern
            .hours
            .iter()
            .zip(&shown.values)
            .map(|(slot, values)| ChartBar {
                axis_label: if slot.hour % 3 == 0 { hour_label(slot.hour, loc) } else { String::new() },
                title: hour_range(slot.hour, loc),
                values: values.clone(),
            })
            .collect(),
        format,
        format_axis,
        height: px(180.),
        overlay: None,
        hovered,
        on_hover,
    }
    .into_any_element()
}

#[allow(unused)]
fn _assert_entity(_: Entity<UsageSettings>) {}
