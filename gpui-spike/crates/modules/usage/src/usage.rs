use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_agent::usage::{UsageLimits, UsageSummary};
use notefig_core::{Executor, Hooks, Listeners, Subscription};
use notefig_platform::Db;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use notefig_agents::agent_events::{AgentUsage, AgentUsageEvent, AgentUsageLimits, AgentUsageLimitsEvent};

pub const USAGE_BUCKETS_COLLECTION_ID: &str = "usage-buckets";
pub const USAGE_LIMITS_COLLECTION_ID: &str = "usage-limits";

const HOUR_MS: i64 = 3_600_000;

/// One UTC hour × harness × workspace, stored as the TS row: the summary's
/// fields flattened beside the bucket's own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    #[serde(flatten)]
    pub summary: UsageSummary,
    /// `usg_` — an entity id; buckets are found by `hour`, never by id.
    pub bucket_id: String,
    /// Epoch ms at the start of the UTC hour the bucket covers.
    pub hour: i64,
    pub harness_id: String,
    pub workspace_path: String,
}

/// A harness account's limits as last reported — one row per harness,
/// replaced by each report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessLimits {
    /// `ulm_` — minted when the harness first reported.
    pub limits_id: String,
    pub harness_id: String,
    /// When the report arrived (epoch ms).
    pub at: i64,
    pub limits: UsageLimits,
}

/// The start of the UTC hour `at` falls in.
pub fn start_of_hour(at: i64) -> i64 {
    at.div_euclid(HOUR_MS) * HOUR_MS
}

/// A new limits report over the stored one. A harness may report one
/// window at a time (Claude names the window an event is about), so the
/// windows it left out are kept until they reset; the rest — status,
/// overage — is the new report's.
pub fn merge_limits(previous: &UsageLimits, next: &UsageLimits, at: i64) -> UsageLimits {
    let reported = |id: &str| next.windows.iter().find(|w| w.id == id);
    let mut windows: Vec<_> = previous
        .windows
        .iter()
        .filter(|w| reported(&w.id).is_some() || w.resets_at.is_none_or(|r| r > at as f64))
        .map(|w| reported(&w.id).unwrap_or(w).clone())
        .collect();
    for window in &next.windows {
        if !previous.windows.iter().any(|kept| kept.id == window.id) {
            windows.push(window.clone());
        }
    }
    UsageLimits { windows, ..next.clone() }
}

fn new_limits_id() -> String {
    // Same id scheme as the buckets' (`shared/agent/ids.ts`), `ulm_` prefix.
    let id = notefig_agent::ids::new_usage_bucket_id();
    format!("ulm{}", &id[3..])
}

/// One persisted table, loaded whole once (the TS persisted collection).
struct Table<T> {
    name: &'static str,
    db: Rc<dyn Db>,
    rows: RefCell<BTreeMap<String, T>>,
    hydrated: Cell<bool>,
    preload: RefCell<Option<Shared<LocalBoxFuture<'static, ()>>>>,
    /// Range reads made or in flight, by `[from, to)`.
    ranges: RefCell<HashMap<(i64, i64), Shared<LocalBoxFuture<'static, ()>>>>,
}

impl<T: Clone + Serialize + DeserializeOwned + 'static> Table<T> {
    fn new(name: &'static str, db: Rc<dyn Db>) -> Rc<Self> {
        Rc::new(Self {
            name,
            db,
            rows: RefCell::default(),
            hydrated: Cell::new(false),
            preload: RefCell::new(None),
            ranges: RefCell::default(),
        })
    }

    fn preload(self: &Rc<Self>, changed: Listeners<()>) -> LocalBoxFuture<'static, ()> {
        if let Some(p) = self.preload.borrow().clone() {
            return p.boxed_local();
        }
        let this = self.clone();
        let fut = async move {
            match this.db.load(this.name).await {
                Ok(rows) => {
                    let mut map = this.rows.borrow_mut();
                    for (key, value) in rows {
                        match serde_json::from_value::<T>(value) {
                            // A write that landed while we loaded wins.
                            Ok(row) => {
                                map.entry(key).or_insert(row);
                            }
                            Err(err) => log::warn!("[usage] skipping a bad {} row {key}: {err}", this.name),
                        }
                    }
                }
                Err(err) => log::error!("[usage] loading {} failed: {err:#}", this.name),
            }
            this.hydrated.set(true);
            changed.emit();
        }
        .boxed_local()
        .shared();
        *self.preload.borrow_mut() = Some(fut.clone());
        fut.boxed_local()
    }

    /// Load the rows whose `field` is in `[from, to)` into memory (an
    /// on-demand range read); rows already in memory win.
    fn load_range(self: &Rc<Self>, field: &'static str, from: i64, to: i64, changed: Listeners<()>) -> LocalBoxFuture<'static, ()> {
        let key = (from, to);
        if let Some(p) = self.ranges.borrow().get(&key).cloned() {
            return p.boxed_local();
        }
        let this = self.clone();
        let fut = async move {
            match this.db.load_range(this.name, field, from as f64, to as f64).await {
                Ok(rows) => {
                    let mut map = this.rows.borrow_mut();
                    for (key, value) in rows {
                        if let Ok(row) = serde_json::from_value::<T>(value) {
                            map.entry(key).or_insert(row);
                        }
                    }
                }
                Err(err) => log::error!("[usage] loading {} [{from}, {to}) failed: {err:#}", this.name),
            }
            changed.emit();
        }
        .boxed_local()
        .shared();
        self.ranges.borrow_mut().insert(key, fut.clone());
        fut.boxed_local()
    }

    fn put(&self, key: String, row: T) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let value = serde_json::to_value(&row);
        self.rows.borrow_mut().insert(key.clone(), row);
        match value {
            Ok(value) => self.db.put(self.name, &key, value),
            Err(err) => futures::future::ready(Err(err.into())).boxed_local(),
        }
    }

    fn all(&self) -> Vec<T> {
        self.rows.borrow().values().cloned().collect()
    }
}

/// What usage is built from.
pub struct UsageDeps {
    /// The platform db (`ctx.service::<PlatformService>().db`).
    pub db: Rc<dyn Db>,
    /// Where settled turns' usage and harnesses' limits are announced.
    pub hooks: Hooks,
    /// Where the serialized writes run.
    pub executor: Rc<dyn Executor>,
}

struct Inner {
    buckets: Rc<Table<UsageBucket>>,
    limits: Rc<Table<HarnessLimits>>,
    hooks: Hooks,
    executor: Rc<dyn Executor>,
    /// The last write queued; each waits for the one before.
    writes: RefCell<Shared<LocalBoxFuture<'static, ()>>>,
    changed: Listeners<()>,
}

/// `core.use_::<UsageModule>()`: the time series, read-only — it is
/// written from the agent hooks alone.
#[derive(Clone)]
pub struct UsageApi {
    inner: Rc<Inner>,
}

pub fn create_usage(deps: UsageDeps) -> UsageApi {
    UsageApi {
        inner: Rc::new(Inner {
            buckets: Table::new(USAGE_BUCKETS_COLLECTION_ID, deps.db.clone()),
            limits: Table::new(USAGE_LIMITS_COLLECTION_ID, deps.db),
            hooks: deps.hooks,
            executor: deps.executor,
            writes: RefCell::new(futures::future::ready(()).boxed_local().shared()),
            changed: Listeners::new(),
        }),
    }
}

impl UsageApi {
    /// Load the stored buckets of the hours overlapping `[from, to)` (the
    /// collection syncs on demand: a view loads its range, out of the db's
    /// range query). A range already loaded, or loading, is joined.
    pub fn load_buckets(&self, from: i64, to: i64) -> LocalBoxFuture<'static, ()> {
        self.inner.buckets.load_range("hour", start_of_hour(from), to, self.inner.changed.clone())
    }

    /// Every bucket in memory (`buckets.toArray`): none until a range loads.
    pub fn buckets(&self) -> Vec<UsageBucket> {
        self.inner.buckets.all()
    }

    /// The hourly buckets overlapping `[from, to)`. Hours are UTC, so a
    /// range starting mid-hour (a local midnight in a half-hour zone)
    /// includes that whole hour.
    pub fn buckets_in(&self, from: i64, to: i64) -> Vec<UsageBucket> {
        let first_hour = start_of_hour(from);
        self.inner
            .buckets
            .rows
            .borrow()
            .values()
            .filter(|b| b.hour >= first_hour && b.hour < to)
            .cloned()
            .collect()
    }

    /// Load the limits rows (small, so whole).
    pub fn preload_limits(&self) -> LocalBoxFuture<'static, ()> {
        self.inner.limits.preload(self.inner.changed.clone())
    }

    /// One row per harness that has reported limits.
    pub fn limits(&self) -> Vec<HarnessLimits> {
        self.inner.limits.all()
    }

    /// Called when buckets or limits load or change.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.changed.subscribe(move |_| listener())
    }

    /// Resolves once every usage heard so far is durable.
    pub fn settled(&self) -> LocalBoxFuture<'static, ()> {
        self.inner.writes.borrow().clone().boxed_local()
    }

    /// Boot: listen for turns' usage and harnesses' limits.
    pub fn track(&self) -> Subscription {
        let a = self.clone();
        let b = self.clone();
        Subscription::join(vec![
            self.inner.hooks.on::<AgentUsage, _>(move |detail| {
                let detail = detail.clone();
                let inner = a.inner.clone();
                a.serialized(async move { write(&inner, detail).await }, "Failed to record a turn's usage:");
            }),
            self.inner.hooks.on::<AgentUsageLimits, _>(move |detail| {
                let detail = detail.clone();
                let inner = b.inner.clone();
                b.serialized(async move { write_limits(&inner, detail).await }, "Failed to record a harness's limits:");
            }),
        ])
    }

    /// Writes run one at a time, each to durability, so two turns landing
    /// in the same hour (or two limit reports from one harness) can never
    /// both find no row and insert two.
    fn serialized(&self, run: impl std::future::Future<Output = anyhow::Result<()>> + 'static, failure: &'static str) {
        let prev = self.inner.writes.borrow().clone();
        let next = async move {
            prev.await;
            if let Err(err) = run.await {
                log::error!("{failure} {err:#}");
            }
        }
        .boxed_local()
        .shared();
        *self.inner.writes.borrow_mut() = next.clone();
        self.inner.executor.spawn(next.boxed_local());
    }
}

async fn write(inner: &Rc<Inner>, detail: AgentUsageEvent) -> anyhow::Result<()> {
    let hour = start_of_hour(detail.at);
    // The hour's buckets, out of the db if no view has them in memory.
    inner.buckets.load_range("hour", hour, hour + HOUR_MS, inner.changed.clone()).await;
    // The hour's bucket for this harness and workspace.
    let existing = inner
        .buckets
        .rows
        .borrow()
        .values()
        .find(|b| b.hour == hour && b.harness_id == detail.harness_id && b.workspace_path == detail.workspace_path)
        .cloned();
    let bucket = match existing {
        Some(mut bucket) => {
            bucket.summary = bucket.summary.add_turn(&detail.usage);
            bucket
        }
        None => UsageBucket {
            summary: UsageSummary::default().add_turn(&detail.usage),
            bucket_id: notefig_agent::ids::new_usage_bucket_id(),
            hour,
            harness_id: detail.harness_id,
            workspace_path: detail.workspace_path,
        },
    };
    let put = inner.buckets.put(bucket.bucket_id.clone(), bucket);
    inner.changed.emit();
    put.await
}

async fn write_limits(inner: &Rc<Inner>, detail: AgentUsageLimitsEvent) -> anyhow::Result<()> {
    inner.limits.preload(inner.changed.clone()).await;
    let existing = inner.limits.rows.borrow().values().find(|r| r.harness_id == detail.harness_id).cloned();
    // Reports can arrive out of order across sessions; keep the newest.
    if existing.as_ref().is_some_and(|row| row.at > detail.at) {
        return Ok(());
    }
    let row = match existing {
        Some(row) => HarnessLimits {
            limits: merge_limits(&row.limits, &detail.limits, detail.at),
            at: detail.at,
            ..row
        },
        None => HarnessLimits {
            limits_id: new_limits_id(),
            harness_id: detail.harness_id,
            at: detail.at,
            limits: detail.limits,
        },
    };
    let put = inner.limits.put(row.limits_id.clone(), row);
    inner.changed.emit();
    put.await
}
