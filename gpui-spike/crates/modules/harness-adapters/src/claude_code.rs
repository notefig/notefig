//! Claude Code, through the bundled `claude-agent-acp` sidecar
//! (`harness-adapters/claude-code.ts`). Registration "session-new": the MCP
//! server rides `session/new.mcpServers`.

use serde_json::{Map, Value, json};

use crate::adapter::*;
use notefig_agent::usage::{
    ModelTokens, TokenCounts, UsageLimitStatus, UsageLimitWindow, UsageLimits, UsageReader, count,
};

const HOUR_MS: f64 = 3_600_000.0;

pub struct ClaudeCode;

fn window_duration(id: &str) -> Option<f64> {
    match id {
        "five_hour" => Some(5.0 * HOUR_MS),
        "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" => {
            Some(7.0 * 24.0 * HOUR_MS)
        }
        _ => None,
    }
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn claude_window(id: &str, fields: &Map<String, Value>) -> Option<UsageLimitWindow> {
    let utilization = finite(fields.get("utilization"))?;
    Some(UsageLimitWindow {
        id: id.to_string(),
        utilization,
        resets_at: finite(fields.get("resetsAt")).map(|s| s * 1000.0),
        duration_ms: window_duration(id),
    })
}

/// Claude's account limits from `_meta["_claude/rateLimit"]`.
pub fn claude_limits(meta: &Map<String, Value>) -> Option<UsageLimits> {
    let rate = meta.get("_claude/rateLimit")?.as_object()?;
    let status = match rate.get("status").and_then(Value::as_str) {
        Some("allowed") => UsageLimitStatus::Ok,
        Some("allowed_warning") => UsageLimitStatus::Warning,
        Some("rejected") => UsageLimitStatus::Blocked,
        _ => UsageLimitStatus::Unknown,
    };
    let mut windows: Vec<UsageLimitWindow> = rate
        .get("unifiedWindows")
        .and_then(Value::as_object)
        .map(|unified| {
            unified
                .iter()
                .filter_map(|(id, fields)| claude_window(id, fields.as_object()?))
                .collect()
        })
        .unwrap_or_default();
    if let Some(kind) = rate.get("rateLimitType").and_then(Value::as_str)
        && !windows.iter().any(|w| w.id == kind)
        && let Some(w) = claude_window(kind, rate)
    {
        windows.push(w);
    }
    Some(UsageLimits {
        status,
        windows,
        using_overage: rate.get("isUsingOverage").and_then(Value::as_bool),
    })
}

/// Per-model rows from `_meta.quota.model_usage`.
pub fn claude_model_rows(response: &Value) -> Option<Vec<ModelTokens>> {
    let rows = response
        .get("_meta")?
        .get("quota")?
        .get("model_usage")?
        .as_array()?;
    let rows: Vec<ModelTokens> = rows
        .iter()
        .filter_map(|row| {
            let model = row.get("model")?.as_str()?;
            let tc = row.get("token_count")?;
            Some(ModelTokens {
                model: model.to_string(),
                tokens: TokenCounts {
                    input: count(tc.get("inputTokens")),
                    cache_read: count(tc.get("cachedInputTokens")),
                    cache_write: count(tc.get("cachedWriteTokens")),
                    output: count(tc.get("outputTokens")),
                    thought: count(tc.get("reasoningOutputTokens")),
                },
            })
        })
        .collect();
    (!rows.is_empty()).then_some(rows)
}

/// The model a `usage_update` names (`_claude/model`).
pub fn claude_update_model(update: &Value) -> Option<String> {
    update
        .get("_meta")?
        .get("_claude/model")?
        .as_str()
        .map(str::to_string)
}

impl UsageReader for ClaudeCode {
    fn model_rows(&self, response: &Value) -> Option<Vec<ModelTokens>> {
        claude_model_rows(response)
    }
    fn update_model(&self, update: &Value) -> Option<String> {
        claude_update_model(update)
    }
}

impl HarnessAdapter for ClaudeCode {
    fn on_invoke(&self, ctx: &InvokeContext) -> SpawnPrep {
        SpawnPrep {
            pass_through_session_new: ctx.mcp_server.is_some(),
            ..no_prep()
        }
    }
    fn reporting(&self) -> UsageReporting {
        UsageReporting {
            cost: true,
            limits: true,
        }
    }
    fn tool_name_prefixes(&self) -> &'static [&'static str] {
        &[CLAUDE_TOOL_PREFIX]
    }
    fn limits(&self, meta: &Map<String, Value>) -> Option<UsageLimits> {
        claude_limits(meta)
    }
    fn catalog_discovery(&self) -> CatalogDiscovery {
        CatalogDiscovery::BySession
    }
    /// claude-agent-acp runs a command only from the prompt's LAST block.
    fn place_command(&self, mut blocks: Vec<Value>, name: &str) -> Option<Vec<Value>> {
        blocks.push(json!({"type": "text", "text": format!("/{name}")}));
        Some(blocks)
    }
    fn logo(&self) -> Option<HarnessMark> {
        Some(HarnessMark {
            view_box: "0 0 24 24",
            fill_rule_evenodd: true,
            paths: &[(CLAUDE_PATH, None)],
        })
    }
}

const CLAUDE_PATH: &str = "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rate_limit_windows() {
        let meta = json!({"_claude/rateLimit": {"status": "allowed_warning", "rateLimitType": "five_hour", "utilization": 0.8, "resetsAt": 100, "isUsingOverage": false}});
        let limits = claude_limits(meta.as_object().unwrap()).unwrap();
        assert_eq!(limits.status, UsageLimitStatus::Warning);
        assert_eq!(limits.windows[0].resets_at, Some(100_000.0));
        assert_eq!(limits.windows[0].duration_ms, Some(5.0 * HOUR_MS));
    }
}
