//! A custom harness: settings data, no code of its own. It registers the
//! app's tools the way its mode names and reads every known vendor's
//! shapes (Devin's subagent tags/credits, Claude's per-model rows/limits).

use serde_json::{Map, Value};

use crate::adapter::*;
use crate::claude_code::{claude_limits, claude_model_rows, claude_update_model};
use crate::devin::*;
use notefig_agent::usage::{Cost, ModelTokens, TokenCounts, UsageLimits, UsageReader};

pub struct Custom {
    mode: notefig_agent::harness::McpRegistration,
}

pub static CUSTOM_SESSION_NEW: Custom = Custom {
    mode: notefig_agent::harness::McpRegistration::SessionNew,
};
pub static CUSTOM_OPENCODE: Custom = Custom {
    mode: notefig_agent::harness::McpRegistration::OpencodeConfig,
};
pub static CUSTOM_DEVIN: Custom = Custom {
    mode: notefig_agent::harness::McpRegistration::DevinConfig,
};
pub static CUSTOM_NONE: Custom = Custom {
    mode: notefig_agent::harness::McpRegistration::None,
};

impl UsageReader for Custom {
    fn cache_in_input(&self, response: &Value) -> bool {
        has_devin_meta(response)
    }
    fn cost_total(&self, update: &Value) -> Option<Cost> {
        devin_cost_total(update)
    }
    fn request_tokens(&self, updates: &[Value]) -> Option<TokenCounts> {
        devin_request_tokens(updates)
    }
    fn model_rows(&self, response: &Value) -> Option<Vec<ModelTokens>> {
        claude_model_rows(response)
    }
    fn update_model(&self, update: &Value) -> Option<String> {
        claude_update_model(update)
    }
}

impl HarnessAdapter for Custom {
    fn on_invoke(&self, ctx: &InvokeContext) -> SpawnPrep {
        use notefig_agent::harness::McpRegistration::*;
        match self.mode {
            SessionNew => crate::claude_code::ClaudeCode.on_invoke(ctx),
            OpencodeConfig => crate::opencode::OpenCode.on_invoke(ctx),
            DevinConfig => devin_on_invoke(ctx),
            None => no_prep(),
        }
    }
    fn client_meta(&self) -> Option<Value> {
        Some(devin_client_meta())
    }
    fn agent_of(&self, update: &Value) -> Option<String> {
        devin_agent_of(update)
    }
    fn tool_name_prefixes(&self) -> &'static [&'static str] {
        KNOWN_TOOL_PREFIXES
    }
    fn tool_name_of(&self, update: &Value) -> Option<String> {
        devin_tool_name_of(update)
    }
    fn limits(&self, meta: &Map<String, Value>) -> Option<UsageLimits> {
        claude_limits(meta)
    }
}
