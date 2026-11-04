//! Token usage and cost, normalized across harnesses (port of
//! `shared/src/agent/usage.ts` + `desktop/src/modules/agents/turn-usage.ts`).
//!
//! One shape at every level: a turn's [`TurnUsage`], a session's
//! [`SessionUsage`] and an hourly [`UsageBucket`] are all a [`UsageSummary`]
//! kept by [`add_turn`]. Harness quirks are resolved by the adapter's
//! [`UsageReader`] before anything reaches these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    /// Uncached input only.
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub thought: f64,
}

impl TokenCounts {
    pub fn total(&self) -> f64 {
        self.input + self.cache_read + self.cache_write + self.output + self.thought
    }
    pub fn add(&self, other: &TokenCounts) -> TokenCounts {
        TokenCounts {
            input: self.input + other.input,
            cache_read: self.cache_read + other.cache_read,
            cache_write: self.cache_write + other.cache_write,
            output: self.output + other.output,
            thought: self.thought + other.thought,
        }
    }
    /// Cache reads over all input; None when there was no input.
    pub fn cache_hit_rate(&self) -> Option<f64> {
        let input = self.input + self.cache_read + self.cache_write;
        (input > 0.0).then(|| self.cache_read / input)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostType {
    #[default]
    Currency,
    Credits,
}

/// What a harness charges, in the unit it bills in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cost {
    pub amount: f64,
    pub currency: String,
    /// Costs saved before `type` existed are money.
    #[serde(rename = "type", default)]
    pub kind: CostType,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub tokens: TokenCounts,
    pub cost: Option<Cost>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelUsage {
    pub model: Option<String>,
    pub usage: Usage,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub total: Usage,
    pub by_model: Vec<ModelUsage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total: Usage,
    pub by_model: Vec<ModelUsage>,
    pub turns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextWindow {
    pub used: f64,
    pub size: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub total: Usage,
    pub by_model: Vec<ModelUsage>,
    pub turns: u64,
    pub context: Option<ContextWindow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageLimitStatus {
    Ok,
    Warning,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    pub id: String,
    /// Fraction used, 0–1.
    pub utilization: f64,
    /// Epoch ms.
    pub resets_at: Option<f64>,
    pub duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub status: UsageLimitStatus,
    pub windows: Vec<UsageLimitWindow>,
    pub using_overage: Option<bool>,
}

fn add_cost(a: &Option<Cost>, b: &Option<Cost>) -> Option<Cost> {
    match (a, b) {
        (a, None) => a.clone(),
        (None, Some(b)) => Some(b.clone()),
        (Some(a), Some(b)) => {
            if a.currency != b.currency || a.kind != b.kind {
                // One summary covers one harness, which bills in one unit.
                return Some(a.clone());
            }
            Some(Cost {
                amount: a.amount + b.amount,
                currency: a.currency.clone(),
                kind: a.kind,
            })
        }
    }
}

pub fn add_usage(a: &Usage, b: &Usage) -> Usage {
    Usage {
        tokens: a.tokens.add(&b.tokens),
        cost: add_cost(&a.cost, &b.cost),
    }
}

/// Merge model rows by model.
pub fn add_model_usage(a: &[ModelUsage], b: &[ModelUsage]) -> Vec<ModelUsage> {
    let mut merged: Vec<ModelUsage> = a.to_vec();
    for row in b {
        match merged
            .iter_mut()
            .find(|existing| existing.model == row.model)
        {
            Some(existing) => existing.usage = add_usage(&existing.usage, &row.usage),
            None => merged.push(row.clone()),
        }
    }
    merged
}

impl UsageSummary {
    pub fn add_turn(&self, turn: &TurnUsage) -> UsageSummary {
        UsageSummary {
            total: add_usage(&self.total, &turn.total),
            by_model: add_model_usage(&self.by_model, &turn.by_model),
            turns: self.turns + 1,
        }
    }
    pub fn add_summary(&self, other: &UsageSummary) -> UsageSummary {
        UsageSummary {
            total: add_usage(&self.total, &other.total),
            by_model: add_model_usage(&self.by_model, &other.by_model),
            turns: self.turns + other.turns,
        }
    }
}

impl SessionUsage {
    pub fn add_turn(&self, turn: &TurnUsage) -> SessionUsage {
        SessionUsage {
            total: add_usage(&self.total, &turn.total),
            by_model: add_model_usage(&self.by_model, &turn.by_model),
            turns: self.turns + 1,
            context: self.context,
        }
    }
}

// ─── Readers ────────────────────────────────────────────────────────────────

/// One model's share of a turn, as a harness splits it.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelTokens {
    pub model: String,
    pub tokens: TokenCounts,
}

/// How a harness counts a turn. Every vendor `_meta` field is read here, by
/// the harness that sends it. `response` is the raw `session/prompt`
/// result; `update` a raw `usage_update` session update.
pub trait UsageReader {
    /// Whether `PromptResponse.usage.inputTokens` already includes cache reads.
    fn cache_in_input(&self, _response: &Value) -> bool {
        false
    }
    /// The session-running cost a `usage_update` reports.
    fn cost_total(&self, update: &Value) -> Option<Cost> {
        acp_cost_total(update)
    }
    /// The turn's tokens summed from per-request updates; None = response stands.
    fn request_tokens(&self, _updates: &[Value]) -> Option<TokenCounts> {
        None
    }
    /// The harness's own per-model split of a turn.
    fn model_rows(&self, _response: &Value) -> Option<Vec<ModelTokens>> {
        None
    }
    /// The model a `usage_update` names.
    fn update_model(&self, _update: &Value) -> Option<String> {
        None
    }
}

/// ACP's own `usage_update.cost`, as money.
pub fn acp_cost_total(update: &Value) -> Option<Cost> {
    let cost = update.get("cost")?;
    let amount = cost.get("amount")?.as_f64()?;
    Some(Cost {
        amount,
        currency: cost
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("USD")
            .to_string(),
        kind: CostType::Currency,
    })
}

/// A non-negative finite count, or 0.
pub fn count(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(v) if v.is_finite() && v > 0.0 => v,
        _ => 0.0,
    }
}

/// ACP's raw token counts (`PromptResponse.usage`) as normalized ones.
pub fn tokens_from(raw: &Value, cache_in_input: bool) -> TokenCounts {
    let cache_read = count(raw.get("cachedReadTokens"));
    let input = count(raw.get("inputTokens"));
    TokenCounts {
        input: if cache_in_input {
            (input - cache_read).max(0.0)
        } else {
            input
        },
        cache_read,
        cache_write: count(raw.get("cachedWriteTokens")),
        output: count(raw.get("outputTokens")),
        thought: count(raw.get("thoughtTokens")),
    }
}

/// The context fill a `usage_update` reports.
pub fn context_from(update: &Value) -> ContextWindow {
    ContextWindow {
        used: count(update.get("used")),
        size: count(update.get("size")),
    }
}

pub struct NormalizedTurnUsage {
    pub usage: Option<TurnUsage>,
    /// The running total to use as the next turn's baseline.
    pub cost_total: Option<f64>,
}

fn since_baseline(total: f64, baseline: f64) -> f64 {
    if total >= baseline {
        total - baseline
    } else {
        total
    }
}

/// Fold what a settled turn reported into a [`TurnUsage`].
pub fn normalize_turn_usage(
    reader: &dyn UsageReader,
    response: Option<&Value>,
    last_update: Option<&Value>,
    turn_updates: &[Value],
    model: Option<&str>,
    cost_baseline: f64,
) -> NormalizedTurnUsage {
    let running = last_update.and_then(|u| reader.cost_total(u));
    let cost_total = running.as_ref().map(|c| c.amount);
    let cost = running.map(|c| Cost {
        amount: since_baseline(c.amount, cost_baseline),
        ..c
    });
    let per_request = reader.request_tokens(turn_updates);
    let response_usage = response
        .and_then(|r| r.get("usage"))
        .filter(|u| u.is_object());
    if response_usage.is_none()
        && per_request.is_none()
        && !cost.as_ref().is_some_and(|c| c.amount != 0.0)
    {
        return NormalizedTurnUsage {
            usage: None,
            cost_total,
        };
    }
    let model_rows = response.and_then(|r| reader.model_rows(r));
    let tokens = if let Some(rows) = &model_rows {
        rows.iter()
            .fold(TokenCounts::default(), |sum, row| sum.add(&row.tokens))
    } else if let Some(per_request) = per_request {
        per_request
    } else if let (Some(raw), Some(response)) = (response_usage, response) {
        tokens_from(raw, reader.cache_in_input(response))
    } else {
        TokenCounts::default()
    };
    let total = Usage { tokens, cost };
    let main_model = last_update
        .and_then(|u| reader.update_model(u))
        .or_else(|| model.map(str::to_string));
    let by_model = match model_rows {
        None => vec![ModelUsage {
            model: main_model,
            usage: total.clone(),
        }],
        Some(rows) => {
            let cost_model = if rows.iter().any(|r| Some(&r.model) == main_model.as_ref()) {
                main_model.clone()
            } else {
                Some(rows[0].model.clone())
            };
            rows.into_iter()
                .map(|row| ModelUsage {
                    usage: Usage {
                        tokens: row.tokens,
                        cost: if Some(&row.model) == cost_model.as_ref() {
                            total.cost.clone()
                        } else {
                            None
                        },
                    },
                    model: Some(row.model),
                })
                .collect()
        }
    };
    NormalizedTurnUsage {
        usage: Some(TurnUsage { total, by_model }),
        cost_total,
    }
}

// ─── Buckets (usage-buckets collection) ─────────────────────────────────────

/// One UTC hour × harness × workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub id: String,
    /// Epoch ms of the hour's start (UTC).
    pub hour: i64,
    pub harness_id: String,
    pub workspace_path: String,
    pub summary: UsageSummary,
}

pub const HOUR_MS: i64 = 3_600_000;

pub fn hour_of(at_ms: i64) -> i64 {
    at_ms - at_ms.rem_euclid(HOUR_MS)
}

/// Fold one turn into the buckets.
pub fn record_bucket(
    buckets: &mut Vec<UsageBucket>,
    at_ms: i64,
    harness_id: &str,
    workspace_path: &str,
    turn: &TurnUsage,
) {
    let hour = hour_of(at_ms);
    if let Some(bucket) = buckets.iter_mut().find(|b| {
        b.hour == hour && b.harness_id == harness_id && b.workspace_path == workspace_path
    }) {
        bucket.summary = bucket.summary.add_turn(turn);
        return;
    }
    buckets.push(UsageBucket {
        id: crate::ids::new_usage_bucket_id(),
        hour,
        harness_id: harness_id.to_string(),
        workspace_path: workspace_path.to_string(),
        summary: UsageSummary::default().add_turn(turn),
    });
}

/// Merge a new limits report into the stored one: a report may carry a
/// single window (Claude's event speaks for the window it names).
pub fn merge_limits(previous: Option<&UsageLimits>, next: &UsageLimits) -> UsageLimits {
    let mut windows = previous.map(|p| p.windows.clone()).unwrap_or_default();
    for window in &next.windows {
        match windows.iter_mut().find(|w| w.id == window.id) {
            Some(existing) => *existing = window.clone(),
            None => windows.push(window.clone()),
        }
    }
    UsageLimits {
        status: next.status,
        windows,
        using_overage: next
            .using_overage
            .or(previous.and_then(|p| p.using_overage)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Acp;
    impl UsageReader for Acp {}

    #[test]
    fn cost_is_delta_against_baseline_and_restart_counts_whole() {
        let update = json!({"sessionUpdate":"usage_update","used":10,"size":100,"cost":{"amount":1.5,"currency":"USD"}});
        let response = json!({"stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":5}});
        let n = normalize_turn_usage(&Acp, Some(&response), Some(&update), &[], Some("m"), 1.0);
        let usage = n.usage.unwrap();
        assert_eq!(usage.total.cost.unwrap().amount, 0.5);
        assert_eq!(usage.total.tokens.input, 10.0);
        assert_eq!(usage.by_model[0].model.as_deref(), Some("m"));
        let n = normalize_turn_usage(&Acp, Some(&response), Some(&update), &[], None, 3.0);
        assert_eq!(n.usage.unwrap().total.cost.unwrap().amount, 1.5);
    }

    #[test]
    fn failed_prompt_with_unmoved_cost_is_no_turn() {
        let update = json!({"cost":{"amount":1.0,"currency":"USD"}});
        let n = normalize_turn_usage(&Acp, None, Some(&update), &[], None, 1.0);
        assert!(n.usage.is_none());
        assert_eq!(n.cost_total, Some(1.0));
    }

    #[test]
    fn buckets_fold_by_hour() {
        let mut buckets = vec![];
        let turn = TurnUsage {
            total: Usage {
                tokens: TokenCounts {
                    input: 1.0,
                    ..Default::default()
                },
                cost: None,
            },
            by_model: vec![],
        };
        record_bucket(&mut buckets, 3_600_000 * 5 + 10, "h", "/w", &turn);
        record_bucket(&mut buckets, 3_600_000 * 5 + 99, "h", "/w", &turn);
        record_bucket(&mut buckets, 3_600_000 * 6, "h", "/w", &turn);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].summary.turns, 2);
    }
}
