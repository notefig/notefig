//! The code half of a harness (port of `harness-adapters/adapter.ts`):
//! what it does before spawning (register the app's MCP server its way),
//! how it counts usage, how it names tools, how it says "sign in". One
//! module per built-in; a custom harness borrows the registration of the
//! mode it names and reads every known vendor's `_meta`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use notefig_agent::harness::{HarnessCatalog, HarnessDefinition, McpRegistration};
use notefig_agent::usage::{UsageLimits, UsageReader};

pub use notefig_agent::mcp::{MCP_SERVER_NAME, StdioMcpServer};
/// claude-agent-acp's `mcp__<server>__<tool>`.
pub const CLAUDE_TOOL_PREFIX: &str = "mcp__notefig__";
/// OpenCode's `<server>_<tool>`.
pub const OPENCODE_TOOL_PREFIX: &str = "notefig_";
pub const KNOWN_TOOL_PREFIXES: &[&str] = &[CLAUDE_TOOL_PREFIX, OPENCODE_TOOL_PREFIX];
/// The app-owned directory inside a workspace (`APP_DIR_NAME`).
pub const APP_DIR_NAME: &str = ".notefig";


/// What the invoke hook settles for the spawn.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpawnPrep {
    /// Merged over the harness's own env.
    pub env: BTreeMap<String, String>,
    /// Whether the MCP server rides ACP `session/new.mcpServers`.
    pub pass_through_session_new: bool,
    /// Extension fields spread into `session/new` and `session/load`.
    pub session_params: Map<String, Value>,
}

/// What an invoke hook may know and do.
pub struct InvokeContext<'a> {
    pub workspace_path: &'a Path,
    pub harness_env: &'a BTreeMap<String, String>,
    pub mcp_server: Option<&'a StdioMcpServer>,
    /// Write files (creating parents); an error string on failure.
    pub write_file: &'a dyn Fn(&Path, &str) -> Result<(), String>,
    pub warn: &'a dyn Fn(&str, &str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UsageReporting {
    pub cost: bool,
    pub limits: bool,
}

/// How a harness's catalog (models, settings, commands) is found before any
/// user session.
pub enum CatalogDiscovery {
    /// Only its sessions tell (custom harnesses).
    None,
    /// A throwaway session in a non-workspace dir, then delete/close it.
    BySession,
    /// Run the harness's command with these args in the login shell and
    /// parse stdout.
    ByCommand {
        args: Vec<String>,
        parse: fn(&str) -> Option<HarnessCatalog>,
    },
}

/// A brand mark as SVG path data (`currentColor`).
#[derive(Debug, Clone, Copy)]
pub struct HarnessMark {
    pub view_box: &'static str,
    pub fill_rule_evenodd: bool,
    /// `(d, opacity)`.
    pub paths: &'static [(&'static str, Option<f32>)],
}

pub trait HarnessAdapter: UsageReader + Send + Sync {
    /// Runs once per task, after the MCP endpoint is live and before spawn.
    fn on_invoke(&self, ctx: &InvokeContext) -> SpawnPrep;
    fn reporting(&self) -> UsageReporting {
        UsageReporting::default()
    }
    /// Vendor capabilities for `initialize.clientCapabilities._meta`.
    fn client_meta(&self) -> Option<Value> {
        None
    }
    /// `"root"`, a subagent id, or None when untagged.
    fn agent_of(&self, _update: &Value) -> Option<String> {
        None
    }
    fn tool_name_prefixes(&self) -> &'static [&'static str];
    /// The tool a call names, for harnesses whose title is prose.
    fn tool_name_of(&self, _update: &Value) -> Option<String> {
        None
    }
    /// Own auth-error test; None = default ("Authentication required").
    fn is_auth_error(&self, _message: &str) -> Option<bool> {
        None
    }
    /// Account limits from a `usage_update`'s `_meta`.
    fn limits(&self, _meta: &Map<String, Value>) -> Option<UsageLimits> {
        None
    }
    fn catalog_discovery(&self) -> CatalogDiscovery {
        CatalogDiscovery::None
    }
    /// Put a command's `/name` where this harness runs it from; None =
    /// default placement (start of the first text block).
    fn place_command(&self, _blocks: Vec<Value>, _name: &str) -> Option<Vec<Value>> {
        None
    }
    fn logo(&self) -> Option<HarnessMark> {
        None
    }
}

/// Nothing to prepare.
pub fn no_prep() -> SpawnPrep {
    SpawnPrep::default()
}

/// The plain tool name for the transcript: the tool its harness names,
/// else its title, MCP prefix stripped. None when it has neither.
pub fn tool_call_title(adapter: &dyn HarnessAdapter, update: &Value) -> Option<String> {
    let name = adapter
        .tool_name_of(update)
        .filter(|n| !n.is_empty())
        .or_else(|| {
            update
                .get("title")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
        })?;
    for prefix in adapter.tool_name_prefixes() {
        if let Some(stripped) = name.strip_prefix(prefix) {
            return Some(stripped.to_string());
        }
    }
    Some(name)
}

/// Whether a failed prompt's error means the harness needs a sign-in.
pub fn needs_sign_in(adapter: &dyn HarnessAdapter, message: &str) -> bool {
    adapter
        .is_auth_error(message)
        .unwrap_or_else(|| message.to_lowercase().contains("authentication required"))
}

/// Whether an update/chunk is the session's own agent's.
pub fn is_main_agent(adapter: &dyn HarnessAdapter, update: &Value) -> bool {
    match adapter.agent_of(update) {
        None => true,
        Some(agent) => agent == "root",
    }
}

/// A subagent's reasoning/reply chunk streamed into its parent's session.
pub fn is_subagent_chunk(adapter: &dyn HarnessAdapter, update: &Value) -> bool {
    matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("agent_message_chunk" | "agent_thought_chunk")
    ) && !is_main_agent(adapter, update)
}

/// The account limits a `usage_update` carries, if its harness reports any.
pub fn limits_from(adapter: &dyn HarnessAdapter, update: &Value) -> Option<UsageLimits> {
    adapter.limits(update.get("_meta")?.as_object()?)
}

/// Pick the adapter for a definition: a built-in's own, else the custom
/// adapter for its registration mode.
pub fn adapter_for(harness: &HarnessDefinition) -> &'static dyn HarnessAdapter {
    match harness.id.as_str() {
        "claude-code" => &crate::claude_code::ClaudeCode,
        "opencode" => &crate::opencode::OpenCode,
        "devin" => &crate::devin::Devin,
        "gemini-cli" => &crate::gemini_cli::GeminiCli,
        _ => match harness.mcp_registration {
            McpRegistration::SessionNew => &crate::custom::CUSTOM_SESSION_NEW,
            McpRegistration::OpencodeConfig => &crate::custom::CUSTOM_OPENCODE,
            McpRegistration::DevinConfig => &crate::custom::CUSTOM_DEVIN,
            McpRegistration::None => &crate::custom::CUSTOM_NONE,
        },
    }
}

/// What a harness id reports, given what its data has shown (`seen`).
pub fn reporting_for(harness: Option<&HarnessDefinition>, seen: UsageReporting) -> UsageReporting {
    let known = harness
        .map(|h| adapter_for(h).reporting())
        .unwrap_or_default();
    UsageReporting {
        cost: known.cost || seen.cost,
        limits: known.limits || seen.limits,
    }
}

/// A built-in's brand mark.
pub fn harness_logo(harness_id: &str) -> Option<HarnessMark> {
    match harness_id {
        "claude-code" => crate::claude_code::ClaudeCode.logo(),
        "opencode" => crate::opencode::OpenCode.logo(),
        "devin" => crate::devin::Devin.logo(),
        "gemini-cli" => crate::gemini_cli::GeminiCli.logo(),
        _ => None,
    }
}

/// Path join helper for adapters.
pub fn join(base: &Path, parts: &[&str]) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in parts {
        p.push(part);
    }
    p
}
