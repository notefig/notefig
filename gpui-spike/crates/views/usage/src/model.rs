//! The Usage section's pure logic (`usage-settings.tsx` minus its JSX):
//! which series a chart shows and in what colour, what unit costs chart
//! in, what the detail card says. Tested without GPUI.

use notefig_agent::usage::{Cost, CostType, TokenCounts, Usage};
use notefig_harness_adapters::UsageReporting;
use notefig_i18n::{t, t_args};
use notefig_usage::series::{GroupKey, UsageGrain, UsagePoint, UsageSeries, UsageSlice, WeekdayTokens};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Tokens,
    Cost,
}

pub const RANGES: [u32; 3] = [7, 30, 90];

/// Each range's grain: days up to a month, weeks beyond.
pub fn grain_of(range_days: u32) -> UsageGrain {
    if range_days >= 90 { UsageGrain::Week } else { UsageGrain::Day }
}

pub const PATTERN_DAYS: i64 = 7;

/// Series shown before the rest fold into "Other" — four when exactly four.
pub const TOP_SERIES: usize = 3;

/// A series' colour: one of the four chart tokens, or "Other"'s muted one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartColor {
    Palette(usize),
    Other,
}

pub const OTHER_KEY: &str = "\u{0}other";
pub const NULL_KEY: &str = "\u{0}none";
/// The every-harness choice; no harness id starts with NUL.
pub const ALL: &str = "\u{0}all";

#[derive(Debug, Clone, PartialEq)]
pub struct ChartSeries {
    pub key: String,
    pub name: String,
    pub color: ChartColor,
}

/// One bar or point (`ChartBar`).
#[derive(Debug, Clone, PartialEq)]
pub struct ChartBar {
    /// Under the bar; empty to leave a gap.
    pub axis_label: String,
    /// Heads the tooltip.
    pub title: String,
    /// One per series, in the series' order.
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ShownSeries {
    pub series: Vec<ChartSeries>,
    /// Per slice, one value per series.
    pub values: Vec<Vec<f64>>,
    /// Per series, over every slice.
    pub totals: Vec<f64>,
}

pub fn metric_of(usage: &Usage, metric: Metric) -> f64 {
    match metric {
        Metric::Cost => usage.cost.as_ref().map(|c| c.amount).unwrap_or(0.0),
        Metric::Tokens => usage.tokens.total(),
    }
}

/// Whether a harness's series can show `metric`: cost only from one that
/// reports it.
pub fn shows_metric(metric: Metric, reporting_of: &dyn Fn(&str) -> UsageReporting, key: &GroupKey) -> bool {
    metric != Metric::Cost || key.as_deref().is_some_and(|k| reporting_of(k).cost)
}

/// One colour per harness wherever harnesses sit side by side, by its
/// tokens over the range. Past the palette, none.
pub fn harness_colors(by_harness: &UsageSeries) -> Vec<String> {
    let mut totals: Vec<(String, f64)> = Vec::new();
    for point in &by_harness.points {
        for group in &point.slice.groups {
            if let Some(key) = &group.key {
                match totals.iter_mut().find(|(k, _)| k == key) {
                    Some((_, total)) => *total += group.usage.tokens.total(),
                    None => totals.push((key.clone(), group.usage.tokens.total())),
                }
            }
        }
    }
    totals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    totals.into_iter().map(|(k, _)| k).collect()
}

/// A key's own colour from [`harness_colors`]' ranking.
pub fn color_of(ranked: &[String], key: &GroupKey) -> Option<ChartColor> {
    let key = key.as_ref()?;
    ranked.iter().position(|k| k == key).filter(|i| *i < 4).map(ChartColor::Palette)
}

/// Each key's colour: its own, else the next one no other key has.
pub fn palette_for(keys: &[GroupKey], own: impl Fn(&GroupKey) -> Option<ChartColor>) -> Vec<ChartColor> {
    let own: Vec<Option<ChartColor>> = keys.iter().map(&own).collect();
    let spare: Vec<ChartColor> = (0..4).map(ChartColor::Palette).filter(|c| !own.contains(&Some(*c))).collect();
    let mut spare = spare.into_iter();
    own.into_iter().map(|c| c.or_else(|| spare.next()).unwrap_or(ChartColor::Other)).collect()
}

/// The largest groups as chart series, the rest summed into "Other".
pub fn top_series(
    slices: &[&UsageSlice],
    keys: &[GroupKey],
    metric: Metric,
    name_of: &dyn Fn(&GroupKey) -> String,
    other_name: &str,
    include: &dyn Fn(&GroupKey) -> bool,
    own_color: &dyn Fn(&GroupKey) -> Option<ChartColor>,
) -> ShownSeries {
    let mut total_of: Vec<(GroupKey, f64)> = Vec::new();
    for slice in slices {
        for group in &slice.groups {
            if !include(&group.key) {
                continue;
            }
            let v = metric_of(&group.usage, metric);
            match total_of.iter_mut().find(|(k, _)| *k == group.key) {
                Some((_, t)) => *t += v,
                None => total_of.push((group.key.clone(), v)),
            }
        }
    }
    let total = |key: &GroupKey| total_of.iter().find(|(k, _)| k == key).map(|(_, t)| *t).unwrap_or(0.0);
    let mut ranked: Vec<GroupKey> = keys.iter().filter(|k| total(k) > 0.0).cloned().collect();
    ranked.sort_by(|a, b| total(b).partial_cmp(&total(a)).unwrap_or(std::cmp::Ordering::Equal));
    let shown: Vec<GroupKey> =
        if ranked.len() <= TOP_SERIES + 1 { ranked.clone() } else { ranked[..TOP_SERIES].to_vec() };
    let rest: Vec<GroupKey> = ranked[shown.len()..].to_vec();

    let colors = palette_for(&shown, own_color);
    let mut series: Vec<ChartSeries> = shown
        .iter()
        .zip(colors)
        .map(|(key, color)| ChartSeries { key: key.clone().unwrap_or_else(|| NULL_KEY.into()), name: name_of(key), color })
        .collect();
    if !rest.is_empty() {
        series.push(ChartSeries { key: OTHER_KEY.into(), name: other_name.into(), color: ChartColor::Other });
    }
    let values: Vec<Vec<f64>> = slices
        .iter()
        .map(|slice| {
            let mut row: Vec<f64> = shown
                .iter()
                .map(|key| slice.groups.iter().find(|g| g.key == *key).map(|g| metric_of(&g.usage, metric)).unwrap_or(0.0))
                .collect();
            if !rest.is_empty() {
                row.push(slice.groups.iter().filter(|g| rest.contains(&g.key)).map(|g| metric_of(&g.usage, metric)).sum());
            }
            row
        })
        .collect();
    let totals = (0..series.len()).map(|i| values.iter().map(|row| row[i]).sum()).collect();
    ShownSeries { series, values, totals }
}

/// What a chart's costs are counted in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostUnit {
    pub currency: String,
    pub kind: CostType,
}

impl CostUnit {
    pub fn usd() -> Self {
        Self { currency: "USD".into(), kind: CostType::Currency }
    }
    pub fn cost(&self, amount: f64) -> Cost {
        Cost { amount, currency: self.currency.clone(), kind: self.kind }
    }
}

/// The unit some slices' costs are in: the first one seen that `accept`s.
pub fn cost_unit_of<'a>(slices: impl IntoIterator<Item = &'a UsageSlice>, accept: impl Fn(&Cost) -> bool) -> Option<CostUnit> {
    for slice in slices {
        for group in &slice.groups {
            if let Some(cost) = &group.usage.cost
                && accept(cost)
            {
                return Some(CostUnit { currency: cost.currency.clone(), kind: cost.kind });
            }
        }
    }
    None
}

pub fn point_slices(points: &[UsagePoint]) -> Vec<&UsageSlice> {
    points.iter().map(|p| &p.slice).collect()
}

/// The unit one harness's cost charts in: its own when it bills in
/// credits, the stacked views' money when it reports cost, else none.
pub fn harness_cost_unit(series: &UsageSeries, reporting: UsageReporting, money: &CostUnit) -> Option<CostUnit> {
    cost_unit_of(series.points.iter().map(|p| &p.slice), |c| c.kind == CostType::Credits)
        .or_else(|| reporting.cost.then(|| money.clone()))
}

/// Usage that names no model has no breakdown to chart.
pub fn names_no_models(keys: &[GroupKey]) -> bool {
    !keys.is_empty() && keys.iter().all(Option::is_none)
}

/// The detail chart greyed: its overlay and the description that replaces
/// the caption.
#[derive(Debug, Clone, PartialEq)]
pub struct Disabled {
    pub overlay: String,
    pub note: String,
}

pub fn detail_chart_disabled(no_cost: bool, unnamed: bool, all: bool, name: &str) -> Option<Disabled> {
    if no_cost {
        return Some(Disabled {
            overlay: t("usageNoCostData"),
            note: if all { t("usageAllNoCost") } else { t_args("usageDetailNoCost", &[("name", name)]) },
        });
    }
    if unnamed {
        return Some(Disabled {
            overlay: t("usageNoModelData"),
            note: t_args("usageNoModelNames", &[("name", name)]),
        });
    }
    None
}

/// One harness's cache-chart entry: the largest three, the rest as Other.
#[derive(Debug, Clone, PartialEq)]
pub struct CacheEntry {
    pub key: String,
    pub name: String,
    pub color: ChartColor,
    pub days: [TokenCounts; 7],
}

pub fn add_days(a: &[TokenCounts; 7], b: &[TokenCounts; 7]) -> [TokenCounts; 7] {
    std::array::from_fn(|i| a[i].add(&b[i]))
}

pub fn sum_days(days: &[TokenCounts; 7]) -> TokenCounts {
    days.iter().fold(TokenCounts::default(), |s, d| s.add(d))
}

pub fn cache_entries(
    harnesses: &[WeekdayTokens],
    label_of: &dyn Fn(&str) -> String,
    own_color: &dyn Fn(&GroupKey) -> Option<ChartColor>,
    other_name: &str,
) -> Vec<CacheEntry> {
    let shown = if harnesses.len() <= TOP_SERIES + 1 { harnesses } else { &harnesses[..TOP_SERIES] };
    let keys: Vec<GroupKey> = shown.iter().map(|h| Some(h.harness_id.clone())).collect();
    let colors = palette_for(&keys, own_color);
    let mut entries: Vec<CacheEntry> = shown
        .iter()
        .zip(colors)
        .map(|(h, color)| CacheEntry { key: h.harness_id.clone(), name: label_of(&h.harness_id), color, days: h.days })
        .collect();
    let rest = &harnesses[shown.len()..];
    if !rest.is_empty() {
        let days = rest.iter().fold([TokenCounts::default(); 7], |acc, h| add_days(&acc, &h.days));
        entries.push(CacheEntry { key: OTHER_KEY.into(), name: other_name.into(), color: ChartColor::Other, days });
    }
    entries
}

/// Thin out axis labels to about six, counted back from the newest bar.
pub fn every_nth(count: usize) -> impl Fn(usize) -> bool {
    let every = count.div_ceil(6).max(1);
    move |index| (count - 1 - index) % every == 0
}

/// The harness ids the picker offers: the used ones first, then every
/// live one, then any that only reported limits.
pub fn harness_ids(by_harness: &UsageSeries, active: &[String], limits: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: &str| {
        if !ids.iter().any(|i| i == id) {
            ids.push(id.to_string());
        }
    };
    for key in by_harness.keys.iter().flatten() {
        add(key);
    }
    for id in active {
        add(id);
    }
    for id in limits {
        add(id);
    }
    ids
}

/// What each harness has shown it reports, across the loaded series and
/// limits (`useHarnessReporting`'s `seen`).
pub fn seen_reporting(by_harness: &UsageSeries, limits: &[String], harness_id: &str) -> UsageReporting {
    let cost = by_harness.points.iter().any(|p| {
        p.slice.groups.iter().any(|g| {
            g.key.as_deref() == Some(harness_id) && g.usage.cost.as_ref().is_some_and(|c| c.kind == CostType::Currency)
        })
    });
    UsageReporting { cost, limits: limits.iter().any(|h| h == harness_id) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_usage::series::UsageGroup;

    fn slice(groups: &[(&str, f64)]) -> UsageSlice {
        UsageSlice {
            total: Usage::default(),
            turns: 1.0,
            groups: groups
                .iter()
                .map(|(k, v)| UsageGroup {
                    key: Some(k.to_string()),
                    usage: Usage { tokens: TokenCounts { input: *v, ..Default::default() }, cost: None },
                })
                .collect(),
        }
    }

    #[test]
    fn top_series_folds_past_three_into_other_but_keeps_exactly_four() {
        let keys: Vec<GroupKey> = ["a", "b", "c", "d", "e"].iter().map(|k| Some(k.to_string())).collect();
        let s = slice(&[("a", 5.0), ("b", 4.0), ("c", 3.0), ("d", 2.0), ("e", 1.0)]);
        let shown = top_series(&[&s], &keys, Metric::Tokens, &|k| k.clone().unwrap(), "Other", &|_| true, &|_| None);
        assert_eq!(shown.series.len(), 4);
        assert_eq!(shown.series[3].key, OTHER_KEY);
        assert_eq!(shown.values[0], vec![5.0, 4.0, 3.0, 3.0]);
        assert_eq!(shown.totals, vec![5.0, 4.0, 3.0, 3.0]);

        let four = slice(&[("a", 5.0), ("b", 4.0), ("c", 3.0), ("d", 2.0)]);
        let shown = top_series(&[&four], &keys[..4], Metric::Tokens, &|k| k.clone().unwrap(), "Other", &|_| true, &|_| None);
        assert_eq!(shown.series.len(), 4);
        assert!(shown.series.iter().all(|s| s.key != OTHER_KEY));
    }

    #[test]
    fn palette_keeps_a_harness_s_own_colour_and_hands_out_the_spares() {
        let keys = vec![Some("x".to_string()), Some("y".to_string())];
        let colors = palette_for(&keys, |k| (k.as_deref() == Some("y")).then_some(ChartColor::Palette(0)));
        assert_eq!(colors, vec![ChartColor::Palette(1), ChartColor::Palette(0)]);
    }

    #[test]
    fn axis_labels_thin_out_from_the_newest() {
        let shown: Vec<usize> = (0..30).filter(|i| every_nth(30)(*i)).collect();
        assert_eq!(shown, vec![4, 9, 14, 19, 24, 29]);
        assert!((0..7).all(|i| every_nth(7)(i) == ((6 - i) % 2 == 0)));
    }

    #[test]
    fn grain_follows_the_range() {
        assert_eq!(grain_of(7), UsageGrain::Day);
        assert_eq!(grain_of(30), UsageGrain::Day);
        assert_eq!(grain_of(90), UsageGrain::Week);
    }
}
