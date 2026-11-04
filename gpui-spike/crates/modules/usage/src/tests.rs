//! Ports of `modules/usage/usage.test.ts` and `series.test.ts`.

use std::rc::Rc;

use chrono::{FixedOffset, TimeZone};
use notefig_agent::usage::{
    Cost, CostType, ModelUsage, TokenCounts, TurnUsage, Usage, UsageLimitStatus, UsageLimitWindow, UsageLimits,
    UsageSummary,
};
use notefig_core::testing::TestExecutor;
use notefig_core::{Hooks, Subscription};
use notefig_platform::fake::FakePlatform;

use crate::series::*;
use notefig_agents::agent_events::{AgentUsage, AgentUsageEvent, AgentUsageLimits, AgentUsageLimitsEvent};

use crate::{
    USAGE_BUCKETS_COLLECTION_ID, UsageApi,
    UsageBucket, UsageDeps, create_usage, start_of_hour,
};

const HOUR: i64 = 3_600_000;

fn usd(amount: f64) -> Cost {
    Cost { amount, currency: "USD".into(), kind: CostType::Currency }
}

fn tokens(input: f64, output: f64) -> TokenCounts {
    TokenCounts { input, output, ..Default::default() }
}

fn turn_usage(input: f64, cost: Option<f64>, model: Option<&str>, output: f64) -> TurnUsage {
    let total = Usage { tokens: tokens(input, output), cost: cost.map(usd) };
    TurnUsage { by_model: vec![ModelUsage { model: model.map(String::from), usage: total.clone() }], total }
}

// ─── usage.test.ts ──────────────────────────────────────────────────────────

// 2026-10-06 14:05 UTC.
const T0: i64 = 1_791_295_500_000;

fn event(f: impl FnOnce(&mut AgentUsageEvent)) -> AgentUsageEvent {
    let mut e = AgentUsageEvent {
        task_id: "task_1".into(),
        turn_id: "trn_1".into(),
        workspace_path: "/ws".into(),
        harness_id: "claude-code".into(),
        at: T0,
        usage: turn_usage(10.0, Some(0.1), Some("m"), 1.0),
    };
    f(&mut e);
    e
}

struct Booted {
    hooks: Hooks,
    usage: UsageApi,
    _track: Subscription,
}

/// A booted usage module over `fake`'s db, as the app has it.
fn boot(exec: &Rc<TestExecutor>, fake: &FakePlatform) -> Booted {
    let hooks = Hooks::new(exec.clone(), Rc::new(|err, at| panic!("{at}: {err:#}")));
    let usage = create_usage(UsageDeps { db: fake.db.clone(), hooks: hooks.clone(), executor: exec.clone() });
    let track = usage.track();
    Booted { hooks, usage, _track: track }
}

#[test]
fn folds_agent_usage_into_the_turns_hour_bucket() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let b = boot(&exec, &fake);
    b.hooks.emit::<AgentUsage>(event(|_| {}));
    b.hooks.emit::<AgentUsage>(event(|e| {
        e.turn_id = "trn_2".into();
        e.at = T0 + 60_000;
        e.usage = turn_usage(5.0, Some(0.2), Some("m"), 1.0);
    }));
    b.hooks.emit::<AgentUsage>(event(|e| {
        e.turn_id = "trn_3".into();
        e.at = T0 + HOUR;
    }));
    exec.block_on(b.usage.settled());

    let mut buckets = b.usage.buckets();
    buckets.sort_by_key(|b| b.hour);
    assert_eq!(buckets.len(), 2);
    let first = &buckets[0];
    assert_eq!(first.hour, start_of_hour(T0));
    assert!(first.bucket_id.starts_with("usg_"));
    assert_eq!(first.summary.turns, 2);
    assert_eq!(first.summary.total.tokens.input, 15.0);
    assert!((first.summary.total.cost.as_ref().unwrap().amount - 0.3).abs() < 1e-9);
}

#[test]
fn a_view_loads_only_its_range() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let b = boot(&exec, &fake);
    b.hooks.emit::<AgentUsage>(event(|_| {}));
    b.hooks.emit::<AgentUsage>(event(|e| e.at = T0 + 30 * 24 * HOUR));
    exec.block_on(b.usage.settled());

    let after = boot(&exec, &fake);
    exec.block_on(after.usage.load_buckets(T0 - HOUR, T0 + HOUR));
    assert_eq!(after.usage.buckets().len(), 1, "the later month stays on disk");
    assert_eq!(after.usage.buckets_in(T0 - HOUR, T0 + HOUR)[0].hour, start_of_hour(T0));
}

#[test]
fn keeps_harnesses_and_workspaces_in_separate_buckets() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let b = boot(&exec, &fake);
    b.hooks.emit::<AgentUsage>(event(|_| {}));
    b.hooks.emit::<AgentUsage>(event(|e| {
        e.harness_id = "devin".into();
        e.usage = turn_usage(3.0, None, Some("m"), 1.0);
    }));
    b.hooks.emit::<AgentUsage>(event(|e| e.workspace_path = "/other".into()));
    exec.block_on(b.usage.settled());
    assert_eq!(b.usage.buckets().len(), 3);
}

#[test]
fn loads_nothing_at_boot_and_still_adds_to_a_stored_hour_after_a_relaunch() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let b = boot(&exec, &fake);
    b.hooks.emit::<AgentUsage>(event(|_| {}));
    exec.block_on(b.usage.settled());

    let after = boot(&exec, &fake);
    assert!(after.usage.buckets().is_empty());

    after.hooks.emit::<AgentUsage>(event(|e| {
        e.turn_id = "trn_2".into();
        e.usage = turn_usage(5.0, Some(0.2), Some("m"), 1.0);
    }));
    exec.block_on(after.usage.settled());
    let stored = fake.db.snapshot(USAGE_BUCKETS_COLLECTION_ID);
    assert_eq!(stored.len(), 1);
    let row = stored.values().next().unwrap();
    assert_eq!(row["turns"], 2);
    assert_eq!(row["hour"], start_of_hour(T0));
    // The TS row shape: the summary flattened beside the bucket's fields.
    assert!(row.get("byModel").is_some() && row.get("bucketId").is_some());
}

fn window(id: &str, utilization: f64, resets_at: Option<f64>) -> UsageLimitWindow {
    UsageLimitWindow { id: id.into(), utilization, resets_at, duration_ms: None }
}

fn limits(status: UsageLimitStatus, windows: Vec<UsageLimitWindow>, using_overage: Option<bool>) -> UsageLimits {
    UsageLimits { status, windows, using_overage }
}

fn report(hooks: &Hooks, task: &str, harness: &str, at: i64, limits: UsageLimits) {
    hooks.emit::<AgentUsageLimits>(AgentUsageLimitsEvent { task_id: task.into(), harness_id: harness.into(), at, limits });
}

#[test]
fn keeps_each_harness_s_newest_limits_one_row_per_harness() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let b = boot(&exec, &fake);
    let l = |u| limits(UsageLimitStatus::Ok, vec![window("five_hour", u, None)], None);
    report(&b.hooks, "task_1", "claude-code", 2, l(0.2));
    report(&b.hooks, "task_2", "claude-code", 3, l(0.5));
    // An older report arriving late doesn't win.
    report(&b.hooks, "task_1", "claude-code", 1, l(0.9));
    report(&b.hooks, "task_3", "other", 1, l(0.1));
    exec.block_on(b.usage.settled());

    let rows = b.usage.limits();
    assert_eq!(rows.len(), 2);
    let claude = rows.iter().find(|r| r.harness_id == "claude-code").unwrap();
    assert!(claude.limits_id.starts_with("ulm_"));
    assert_eq!(claude.at, 3);
    assert_eq!(claude.limits.windows[0].utilization, 0.5);
}

#[test]
fn merges_one_window_reports_drops_windows_once_reset_and_keeps_them_across_a_relaunch() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let b = boot(&exec, &fake);
    let r = |hooks: &Hooks, at, status, windows| report(hooks, "task_1", "claude-code", at, limits(status, windows, Some(false)));
    r(&b.hooks, 10, UsageLimitStatus::Ok, vec![window("five_hour", 0.4, Some(100.0)), window("seven_day", 0.1, Some(1000.0))]);
    r(&b.hooks, 20, UsageLimitStatus::Warning, vec![window("seven_day", 0.8, Some(1000.0))]);
    exec.block_on(b.usage.settled());

    let after = boot(&exec, &fake);
    exec.block_on(after.usage.preload_limits());
    assert_eq!(
        after.usage.limits()[0].limits,
        limits(
            UsageLimitStatus::Warning,
            vec![window("five_hour", 0.4, Some(100.0)), window("seven_day", 0.8, Some(1000.0))],
            Some(false)
        )
    );

    // Past five_hour's reset, a report that leaves it out drops it.
    r(&after.hooks, 200, UsageLimitStatus::Ok, vec![window("seven_day", 0.85, Some(1000.0))]);
    exec.block_on(after.usage.settled());
    assert_eq!(after.usage.limits()[0].limits.windows, vec![window("seven_day", 0.85, Some(1000.0))]);
}

// ─── series.test.ts ─────────────────────────────────────────────────────────

/// A whole-hour zone stands in for "local": a local hour start is then
/// also a UTC hour start, which is what a bucket's `hour` is.
fn zone() -> FixedOffset {
    FixedOffset::east_opt(2 * 3600).unwrap()
}

/// `new Date(2026, month, day, hour)` in [`zone`] (month 0-based).
fn at(month: u32, day: u32, hour: u32) -> i64 {
    zone().with_ymd_and_hms(2026, month + 1, day, hour, 0, 0).unwrap().timestamp_millis()
}

fn turn(input: f64, cost: Option<f64>, model: Option<&str>) -> TurnUsage {
    turn_usage(input, cost, model, 0.0)
}

fn bucket(hour: i64, usage: TurnUsage, harness: &str, turns: u64) -> UsageBucket {
    UsageBucket {
        summary: UsageSummary { total: usage.total, by_model: usage.by_model, turns },
        bucket_id: format!("usg_{hour}_{harness}"),
        hour,
        harness_id: harness.into(),
        workspace_path: "/ws".into(),
    }
}

fn claude(hour: i64, usage: TurnUsage) -> UsageBucket {
    bucket(hour, usage, "claude", 1)
}

fn scope(from: i64, to: i64) -> UsageScope {
    UsageScope { from, to, harness_id: None }
}

fn key(k: &str) -> GroupKey {
    Some(k.to_string())
}

#[test]
fn period_start_finds_the_local_day_month_and_quarter() {
    let z = zone();
    let t = at(7, 20, 15); // Aug 20, 15:00
    assert_eq!(period_start_in(&z, t, UsageGrain::Day), at(7, 20, 0));
    assert_eq!(period_start_in(&z, t, UsageGrain::Week), at(7, 17, 0)); // Monday
    assert_eq!(period_start_in(&z, at(7, 23, 0), UsageGrain::Week), at(7, 17, 0)); // from a Sunday
    assert_eq!(period_start_in(&z, t, UsageGrain::Month), at(7, 1, 0));
    assert_eq!(period_start_in(&z, t, UsageGrain::Quarter), at(6, 1, 0));
}

#[test]
fn series_totals_money_only_and_a_harness_s_credits_stay_in_its_group() {
    let mut credited = turn(100.0, None, Some("m"));
    credited.total.cost = Some(Cost { amount: 4.0, currency: "devin-credit".into(), kind: CostType::Credits });
    // Saved before costs were typed: money (serde's default).
    let legacy: Cost = serde_json::from_value(serde_json::json!({"amount": 0.1, "currency": "USD"})).unwrap();
    let mut legacy_turn = turn(10.0, None, Some("m"));
    legacy_turn.total.cost = Some(legacy);
    let series = usage_series_in(
        &zone(),
        &[claude(at(9, 1, 10), legacy_turn), bucket(at(9, 1, 11), credited, "devin", 1)],
        &scope(at(9, 1, 0), at(9, 2, 0)),
        UsageGrain::Day,
        UsageGroupBy::Harness,
    );
    let day = &series.points[0].slice;
    assert_eq!(day.total.cost.as_ref().unwrap().amount, 0.1);
    assert_eq!(day.total.cost.as_ref().unwrap().currency, "USD");
    let groups: Vec<_> = day
        .groups
        .iter()
        .map(|g| (g.key.clone(), g.usage.cost.as_ref().map(|c| (c.amount, c.currency.clone()))))
        .collect();
    assert_eq!(
        groups,
        vec![(key("devin"), Some((4.0, "devin-credit".into()))), (key("claude"), Some((0.1, "USD".into())))]
    );
}

#[test]
fn series_adds_hours_into_local_days_gaps_included_split_by_harness() {
    let series = usage_series_in(
        &zone(),
        &[
            claude(at(9, 1, 9), turn(10.0, Some(0.1), Some("m"))),
            bucket(at(9, 1, 17), turn(5.0, Some(0.2), Some("m")), "claude", 2),
            bucket(at(9, 1, 17), turn(100.0, None, Some("m")), "devin", 1),
            claude(at(9, 3, 8), turn(1.0, Some(0.05), Some("m"))),
        ],
        &scope(at(9, 1, 0), at(9, 4, 0)),
        UsageGrain::Day,
        UsageGroupBy::Harness,
    );
    assert_eq!(series.points.iter().map(|p| p.start).collect::<Vec<_>>(), vec![at(9, 1, 0), at(9, 2, 0), at(9, 3, 0)]);
    assert_eq!(series.keys, vec![key("devin"), key("claude")]);
    let (first, empty, third) = (&series.points[0].slice, &series.points[1].slice, &series.points[2].slice);
    assert_eq!(first.turns, 4.0);
    assert_eq!(first.total.tokens.input, 115.0);
    assert!((first.total.cost.as_ref().unwrap().amount - 0.3).abs() < 1e-9);
    assert_eq!(
        first.groups.iter().map(|g| (g.key.clone(), g.usage.tokens.input)).collect::<Vec<_>>(),
        vec![(key("devin"), 100.0), (key("claude"), 15.0)]
    );
    assert!(first.groups[0].usage.cost.is_none());
    assert_eq!(empty.turns, 0.0);
    assert!(empty.groups.is_empty());
    assert_eq!(third.groups.iter().map(|g| g.key.clone()).collect::<Vec<_>>(), vec![key("claude")]);
}

#[test]
fn series_splits_by_model_an_unnamed_model_as_none() {
    let series = usage_series_in(
        &zone(),
        &[
            claude(
                at(9, 1, 9),
                TurnUsage {
                    total: turn(30.0, None, None).total,
                    by_model: vec![
                        turn(20.0, None, Some("big")).by_model[0].clone(),
                        turn(10.0, None, None).by_model[0].clone(),
                    ],
                },
            ),
            claude(at(9, 1, 10), turn(5.0, None, Some("big"))),
        ],
        &scope(at(9, 1, 0), at(9, 2, 0)),
        UsageGrain::Day,
        UsageGroupBy::Model,
    );
    assert_eq!(series.keys, vec![key("big"), None]);
    assert_eq!(
        series.points[0].slice.groups.iter().map(|g| (g.key.clone(), g.usage.tokens.input)).collect::<Vec<_>>(),
        vec![(key("big"), 25.0), (None, 10.0)]
    );
}

#[test]
fn series_keeps_to_one_harness_when_asked() {
    let series = usage_series_in(
        &zone(),
        &[claude(at(9, 1, 9), turn(10.0, None, Some("a"))), bucket(at(9, 1, 9), turn(99.0, None, Some("b")), "devin", 1)],
        &UsageScope { from: at(9, 1, 0), to: at(9, 2, 0), harness_id: Some("claude".into()) },
        UsageGrain::Day,
        UsageGroupBy::Model,
    );
    assert_eq!(series.keys, vec![key("a")]);
    assert_eq!(series.points[0].slice.total.tokens.input, 10.0);
}

#[test]
fn series_adds_days_into_monday_started_weeks() {
    let series = usage_series_in(
        &zone(),
        &[claude(at(9, 4, 9), turn(1.0, None, Some("m"))), claude(at(9, 5, 9), turn(2.0, None, Some("m")))],
        &scope(at(9, 1, 0), at(9, 13, 0)),
        UsageGrain::Week,
        UsageGroupBy::Harness,
    );
    // Oct 1 2026 is a Thursday: its week starts Monday Sep 28.
    assert_eq!(
        series.points.iter().map(|p| (p.start, p.slice.total.tokens.input)).collect::<Vec<_>>(),
        vec![(at(8, 28, 0), 1.0), (at(9, 5, 0), 2.0), (at(9, 12, 0), 0.0)]
    );
}

#[test]
fn series_groups_by_month_and_quarter_and_leaves_out_buckets_outside_the_range() {
    let buckets = [
        claude(at(5, 30, 12), turn(1.0, None, Some("m"))), // June: before the range
        claude(at(6, 2, 12), turn(2.0, None, Some("m"))),
        claude(at(7, 31, 23), turn(4.0, None, Some("m"))),
        claude(at(9, 1, 0), turn(8.0, None, Some("m"))),
        claude(at(11, 31, 0), turn(16.0, None, Some("m"))), // past `to`
    ];
    let range = scope(at(6, 1, 0), at(11, 1, 0));
    let months = usage_series_in(&zone(), &buckets, &range, UsageGrain::Month, UsageGroupBy::Harness);
    assert_eq!(
        months.points.iter().map(|p| (p.start, p.slice.total.tokens.input)).collect::<Vec<_>>(),
        vec![(at(6, 1, 0), 2.0), (at(7, 1, 0), 4.0), (at(8, 1, 0), 0.0), (at(9, 1, 0), 8.0), (at(10, 1, 0), 0.0)]
    );
    let quarters = usage_series_in(&zone(), &buckets, &range, UsageGrain::Quarter, UsageGroupBy::Harness);
    assert_eq!(
        quarters.points.iter().map(|p| (p.start, p.slice.total.tokens.input)).collect::<Vec<_>>(),
        vec![(at(6, 1, 0), 6.0), (at(9, 1, 0), 8.0)]
    );
}

#[test]
fn series_in_a_half_hour_zone_counts_the_utc_hour_that_straddles_the_first_midnight() {
    let kolkata = FixedOffset::east_opt(5 * 3600 + 1800).unwrap();
    let from = kolkata.with_ymd_and_hms(2026, 10, 6, 0, 0, 0).unwrap().timestamp_millis();
    let to = kolkata.with_ymd_and_hms(2026, 10, 7, 0, 0, 0).unwrap().timestamp_millis();
    let first_hour = start_of_hour(from); // 23:30 local, Oct 5
    assert_eq!(first_hour, from - 1_800_000);
    let series = usage_series_in(
        &kolkata,
        &[claude(first_hour, turn(7.0, None, Some("m")))],
        &scope(from, to),
        UsageGrain::Day,
        UsageGroupBy::Harness,
    );
    assert_eq!(series.points.len(), 1);
    assert_eq!(series.points[0].slice.total.tokens.input, 7.0);
}

#[test]
fn pattern_averages_each_local_hour_of_day_over_the_range_s_days() {
    let pattern = usage_pattern_in(
        &zone(),
        &[
            claude(at(9, 1, 9), turn(70.0, Some(0.7), Some("m"))),
            bucket(at(9, 4, 9), turn(70.0, Some(0.7), Some("m")), "devin", 1),
            claude(at(9, 6, 22), turn(14.0, None, Some("m"))),
            claude(at(8, 30, 9), turn(1_000.0, None, Some("m"))), // before the range
        ],
        &scope(at(9, 1, 0), at(9, 8, 0)),
        UsageGroupBy::Harness,
    );
    assert_eq!(pattern.hours.len(), 24);
    let nine = &pattern.hours[9].slice;
    assert_eq!(nine.total.tokens.input, 20.0);
    assert!((nine.total.cost.as_ref().unwrap().amount - 0.2).abs() < 1e-9);
    assert!((nine.turns - 2.0 / 7.0).abs() < 1e-9);
    assert_eq!(
        nine.groups.iter().map(|g| (g.key.clone(), g.usage.tokens.input)).collect::<Vec<_>>(),
        vec![(key("claude"), 10.0), (key("devin"), 10.0)]
    );
    assert_eq!(pattern.hours[22].slice.total.tokens.input, 2.0);
    assert_eq!(pattern.hours[0].slice.turns, 0.0);
}

#[test]
fn weekday_tokens_adds_each_local_weekday_per_harness_monday_first_largest_first() {
    // 2026-10-05 is a Monday; the 11th the Sunday after.
    let harnesses = weekday_tokens_in(
        &zone(),
        &[
            claude(at(9, 5, 9), turn(10.0, None, Some("m"))),
            claude(at(9, 5, 15), turn(5.0, None, Some("m"))),
            claude(at(9, 11, 23), turn(7.0, None, Some("m"))),
            bucket(at(9, 6, 9), turn(100.0, None, Some("m")), "devin", 1),
            claude(at(9, 12, 9), turn(1.0, None, Some("m"))),
        ],
        &scope(at(9, 5, 0), at(9, 12, 0)),
    );
    let got: Vec<_> = harnesses.iter().map(|h| (h.harness_id.clone(), h.days.map(|t| t.input))).collect();
    assert_eq!(
        got,
        vec![
            ("devin".to_string(), [0.0, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            ("claude".to_string(), [15.0, 0.0, 0.0, 0.0, 0.0, 0.0, 7.0]),
        ]
    );
}

#[test]
fn weekday_tokens_keeps_to_one_harness_when_asked() {
    let harnesses = weekday_tokens_in(
        &zone(),
        &[claude(at(9, 5, 9), turn(10.0, None, Some("m"))), bucket(at(9, 6, 9), turn(100.0, None, Some("m")), "devin", 1)],
        &UsageScope { from: at(9, 5, 0), to: at(9, 12, 0), harness_id: Some("claude".into()) },
    );
    assert_eq!(harnesses.iter().map(|h| h.harness_id.clone()).collect::<Vec<_>>(), vec!["claude"]);
}
