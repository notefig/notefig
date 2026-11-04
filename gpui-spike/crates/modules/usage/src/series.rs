//! Views over the hourly buckets (`series.ts`): usage per day, week, month
//! or quarter, and the average day hour by hour — each split by harness or
//! by model — and tokens by day of the week.
//!
//! Buckets cover UTC hours, so every view groups them into the user's local
//! periods here, at read time; nothing coarser is stored, so a change of
//! timezone never leaves days cut at the old one. (In a zone offset by a
//! half hour, a bucket lands in the local hour it starts in.)
//!
//! Each function has a `_in` form taking the zone, which is what the tests
//! call (TS sets `process.env.TZ`); the plain form is the local zone.

use std::collections::HashMap;

use chrono::{Datelike, Days, Local, Months, NaiveDate, TimeZone, Timelike};
use notefig_agent::usage::{Cost, CostType, TokenCounts, Usage};

use crate::usage::{UsageBucket, start_of_hour};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UsageGrain {
    Day,
    Week,
    Month,
    Quarter,
}

/// What a view splits its totals by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UsageGroupBy {
    Harness,
    Model,
}

/// A group's key: a harness id, or a model as the harness named it (`None`
/// when it didn't).
pub type GroupKey = Option<String>;

/// One group's share.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageGroup {
    pub key: GroupKey,
    pub usage: Usage,
}

/// A slice of usage and how it splits; groups follow the view's `keys`
/// order, and only groups with usage in the slice are listed. The total's
/// cost is money only; a group's is in its harness's unit (Devin credits).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSlice {
    pub total: Usage,
    pub turns: f64,
    pub groups: Vec<UsageGroup>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsagePoint {
    /// Local start of the period (epoch ms).
    pub start: i64,
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSeries {
    /// Every period in the range, oldest first — empty ones included, so a
    /// chart's axis has no gaps.
    pub points: Vec<UsagePoint>,
    /// Every group in the range, most tokens first: one order for stacking
    /// and legends.
    pub keys: Vec<GroupKey>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageHourOfDay {
    /// Local hour of day, 0–23.
    pub hour: u32,
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsagePattern {
    /// All 24 hours. Each is the range's usage in that hour divided by the
    /// range's length in days — an average day, so turns and tokens can be
    /// fractional.
    pub hours: Vec<UsageHourOfDay>,
    pub keys: Vec<GroupKey>,
}

/// One harness's tokens per local day of the week, Monday first.
#[derive(Debug, Clone, PartialEq)]
pub struct WeekdayTokens {
    pub harness_id: String,
    pub days: [TokenCounts; 7],
}

/// Which buckets a view reads: those in `[from, to)`, and of one harness
/// when `harness_id` is given.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageScope {
    pub from: i64,
    pub to: i64,
    pub harness_id: Option<String>,
}

const DAY_MS: f64 = 24.0 * 3_600_000.0;

#[derive(Clone, Default)]
struct Accumulator {
    tokens: TokenCounts,
    cost: Option<Cost>,
    turns: f64,
}

#[derive(Clone, Default)]
struct SliceAccumulator {
    total: Accumulator,
    /// Insertion-ordered, as the TS Map.
    groups: Vec<(GroupKey, Accumulator)>,
}

impl SliceAccumulator {
    fn group(&mut self, key: &GroupKey) -> &mut Accumulator {
        let index = match self.groups.iter().position(|(k, _)| k == key) {
            Some(index) => index,
            None => {
                self.groups.push((key.clone(), Accumulator::default()));
                self.groups.len() - 1
            }
        };
        &mut self.groups[index].1
    }
}

/// `addUsage`, in place.
fn accumulate(into: &mut Accumulator, usage: &Usage, turns: f64) {
    into.tokens = into.tokens.add(&usage.tokens);
    into.turns += turns;
    let Some(cost) = &usage.cost else { return };
    match &mut into.cost {
        None => into.cost = Some(cost.clone()),
        Some(kept) if kept.currency == cost.currency => kept.amount += cost.amount,
        // Same rule as `add_usage`: one harness reports in one currency.
        Some(kept) => log::warn!("[usage] dropping {} {}: series is in {}", cost.amount, cost.currency, kept.currency),
    }
}

/// A slice's total spans harnesses, so its cost is money only: credits are
/// a harness's own unit and stay in that harness's group.
fn money_only(usage: &Usage) -> Usage {
    match &usage.cost {
        Some(cost) if cost.kind != CostType::Currency => Usage { tokens: usage.tokens, cost: None },
        _ => usage.clone(),
    }
}

fn add_bucket(slice: &mut SliceAccumulator, bucket: &UsageBucket, group_by: UsageGroupBy) {
    let turns = bucket.summary.turns as f64;
    accumulate(&mut slice.total, &money_only(&bucket.summary.total), turns);
    match group_by {
        UsageGroupBy::Harness => {
            accumulate(slice.group(&Some(bucket.harness_id.clone())), &bucket.summary.total, turns)
        }
        UsageGroupBy::Model => {
            for row in &bucket.summary.by_model {
                accumulate(slice.group(&row.model), &row.usage, 0.0);
            }
        }
    }
}

fn to_usage(acc: &Accumulator, divisor: f64) -> Usage {
    let t = &acc.tokens;
    Usage {
        tokens: TokenCounts {
            input: t.input / divisor,
            cache_read: t.cache_read / divisor,
            cache_write: t.cache_write / divisor,
            output: t.output / divisor,
            thought: t.thought / divisor,
        },
        cost: acc.cost.as_ref().map(|c| Cost { amount: c.amount / divisor, ..c.clone() }),
    }
}

/// Group keys by tokens over the whole range, largest first (stable).
fn rank_keys(slices: &[SliceAccumulator]) -> Vec<GroupKey> {
    let mut totals: Vec<(GroupKey, f64)> = Vec::new();
    for slice in slices {
        for (key, acc) in &slice.groups {
            match totals.iter_mut().find(|(k, _)| k == key) {
                Some((_, total)) => *total += acc.tokens.total(),
                None => totals.push((key.clone(), acc.tokens.total())),
            }
        }
    }
    totals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    totals.into_iter().map(|(k, _)| k).collect()
}

fn to_slice(slice: &SliceAccumulator, keys: &[GroupKey], divisor: f64) -> UsageSlice {
    let groups = keys
        .iter()
        .filter_map(|key| {
            slice
                .groups
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, acc)| UsageGroup { key: key.clone(), usage: to_usage(acc, divisor) })
        })
        .collect();
    UsageSlice { total: to_usage(&slice.total, divisor), turns: slice.total.turns / divisor, groups }
}

fn midnight<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).expect("midnight");
    match tz.from_local_datetime(&naive).earliest() {
        Some(at) => at.timestamp_millis(),
        // A DST gap at midnight: the first instant after it.
        None => tz
            .from_local_datetime(&(naive + chrono::Duration::hours(1)))
            .earliest()
            .map(|at| at.timestamp_millis())
            .unwrap_or_else(|| naive.and_utc().timestamp_millis()),
    }
}

fn local_date<Tz: TimeZone>(tz: &Tz, at: i64) -> NaiveDate {
    tz.timestamp_millis_opt(at).single().map(|d| d.date_naive()).unwrap_or_default()
}

/// Local start of the period `at` falls in. Weeks start on Monday.
pub fn period_start(at: i64, grain: UsageGrain) -> i64 {
    period_start_in(&Local, at, grain)
}

pub fn period_start_in<Tz: TimeZone>(tz: &Tz, at: i64, grain: UsageGrain) -> i64 {
    let d = local_date(tz, at);
    let date = match grain {
        UsageGrain::Day => d,
        UsageGrain::Week => d - Days::new(d.weekday().num_days_from_monday() as u64),
        UsageGrain::Month => d.with_day(1).expect("day 1"),
        UsageGrain::Quarter => {
            NaiveDate::from_ymd_opt(d.year(), d.month0() / 3 * 3 + 1, 1).expect("quarter start")
        }
    };
    midnight(tz, date)
}

/// Local start of the period after the one starting at `start`.
fn next_period<Tz: TimeZone>(tz: &Tz, start: i64, grain: UsageGrain) -> i64 {
    let d = local_date(tz, start);
    let date = match grain {
        UsageGrain::Day => d + Days::new(1),
        UsageGrain::Week => d + Days::new(7),
        UsageGrain::Month => d + Months::new(1),
        UsageGrain::Quarter => d + Months::new(3),
    };
    midnight(tz, date)
}

fn in_scope(bucket: &UsageBucket, first_hour: i64, scope: &UsageScope) -> bool {
    bucket.hour >= first_hour
        && bucket.hour < scope.to
        && scope.harness_id.as_ref().is_none_or(|h| *h == bucket.harness_id)
}

/// Usage per local period over `[from, to)`, split by harness or model.
pub fn usage_series(buckets: &[UsageBucket], scope: &UsageScope, grain: UsageGrain, group_by: UsageGroupBy) -> UsageSeries {
    usage_series_in(&Local, buckets, scope, grain, group_by)
}

pub fn usage_series_in<Tz: TimeZone>(
    tz: &Tz,
    buckets: &[UsageBucket],
    scope: &UsageScope,
    grain: UsageGrain,
    group_by: UsageGroupBy,
) -> UsageSeries {
    let mut starts = Vec::new();
    let mut slot_of: HashMap<i64, usize> = HashMap::new();
    let mut start = period_start_in(tz, scope.from, grain);
    while start < scope.to {
        slot_of.insert(start, starts.len());
        starts.push(start);
        start = next_period(tz, start, grain);
    }
    let mut slices = vec![SliceAccumulator::default(); starts.len()];

    // Buckets come several to an hour (one per harness × workspace).
    let mut start_of_bucket_hour: HashMap<i64, i64> = HashMap::new();
    let first_hour = start_of_hour(scope.from);
    for bucket in buckets {
        if !in_scope(bucket, first_hour, scope) {
            continue;
        }
        let start = *start_of_bucket_hour
            .entry(bucket.hour)
            .or_insert_with(|| period_start_in(tz, bucket.hour, grain));
        // In a half-hour zone the range's first UTC hour starts before its
        // first local period; it overlaps that period, so it counts there.
        let slot = slot_of
            .get(&start)
            .copied()
            .or_else(|| starts.first().filter(|first| start < **first).map(|_| 0));
        if let Some(slot) = slot {
            add_bucket(&mut slices[slot], bucket, group_by);
        }
    }

    let keys = rank_keys(&slices);
    UsageSeries {
        points: slices
            .iter()
            .zip(starts)
            .map(|(slice, start)| UsagePoint { start, slice: to_slice(slice, &keys, 1.0) })
            .collect(),
        keys,
    }
}

/// The average day over `[from, to)`: usage per local hour of day, divided
/// by the range's length in days.
pub fn usage_pattern(buckets: &[UsageBucket], scope: &UsageScope, group_by: UsageGroupBy) -> UsagePattern {
    usage_pattern_in(&Local, buckets, scope, group_by)
}

pub fn usage_pattern_in<Tz: TimeZone>(
    tz: &Tz,
    buckets: &[UsageBucket],
    scope: &UsageScope,
    group_by: UsageGroupBy,
) -> UsagePattern {
    let mut slices = vec![SliceAccumulator::default(); 24];
    let mut hour_of_day: HashMap<i64, u32> = HashMap::new();
    let first_hour = start_of_hour(scope.from);
    for bucket in buckets {
        if !in_scope(bucket, first_hour, scope) {
            continue;
        }
        let hour = *hour_of_day.entry(bucket.hour).or_insert_with(|| {
            tz.timestamp_millis_opt(bucket.hour).single().map(|d| d.hour()).unwrap_or(0)
        });
        add_bucket(&mut slices[hour as usize], bucket, group_by);
    }
    let days = ((scope.to - scope.from) as f64 / DAY_MS).max(1.0);
    let keys = rank_keys(&slices);
    UsagePattern {
        hours: slices
            .iter()
            .enumerate()
            .map(|(hour, slice)| UsageHourOfDay { hour: hour as u32, slice: to_slice(slice, &keys, days) })
            .collect(),
        keys,
    }
}

/// Tokens per local day of the week over `[from, to)`, per harness, the
/// most tokens first.
pub fn weekday_tokens(buckets: &[UsageBucket], scope: &UsageScope) -> Vec<WeekdayTokens> {
    weekday_tokens_in(&Local, buckets, scope)
}

pub fn weekday_tokens_in<Tz: TimeZone>(tz: &Tz, buckets: &[UsageBucket], scope: &UsageScope) -> Vec<WeekdayTokens> {
    let mut by_harness: Vec<WeekdayTokens> = Vec::new();
    let mut weekday_of: HashMap<i64, usize> = HashMap::new();
    let first_hour = start_of_hour(scope.from);
    for bucket in buckets {
        if !in_scope(bucket, first_hour, scope) {
            continue;
        }
        let weekday = *weekday_of
            .entry(bucket.hour)
            .or_insert_with(|| local_date(tz, bucket.hour).weekday().num_days_from_monday() as usize);
        let index = match by_harness.iter().position(|h| h.harness_id == bucket.harness_id) {
            Some(index) => index,
            None => {
                by_harness.push(WeekdayTokens { harness_id: bucket.harness_id.clone(), days: Default::default() });
                by_harness.len() - 1
            }
        };
        let day = &mut by_harness[index].days[weekday];
        *day = day.add(&bucket.summary.total.tokens);
    }
    let size_of = |h: &WeekdayTokens| h.days.iter().map(TokenCounts::total).sum::<f64>();
    by_harness.sort_by(|a, b| size_of(b).partial_cmp(&size_of(a)).unwrap_or(std::cmp::Ordering::Equal));
    by_harness
}
