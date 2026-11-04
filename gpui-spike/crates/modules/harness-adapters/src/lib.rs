//! What each harness does differently: a port of
//! `packages/desktop/src/modules/harness-adapters/`. One file per built-in
//! harness (`claude_code`, `opencode`, `devin`, `gemini_cli`) plus the
//! adapters a custom harness borrows by its MCP registration mode
//! (`custom`). The agent service never names a vendor: it asks
//! `core.use_::<HarnessAdaptersModule>().adapter_for(harness)`.

mod adapter;
mod claude_code;
mod custom;
mod devin;
mod gemini_cli;
mod opencode;
#[cfg(test)]
mod tests;

pub use adapter::{
    APP_DIR_NAME, CLAUDE_TOOL_PREFIX, CatalogDiscovery, HarnessAdapter, HarnessMark,
    InvokeContext, KNOWN_TOOL_PREFIXES, MCP_SERVER_NAME, OPENCODE_TOOL_PREFIX, SpawnPrep,
    StdioMcpServer, UsageReporting, adapter_for, harness_logo, is_main_agent, is_subagent_chunk,
    limits_from, needs_sign_in, no_prep, reporting_for, tool_call_title,
};
pub use opencode::{deep_merge_configs, parse_opencode_models};

use notefig_agent::harness::HarnessDefinition;
use notefig_core::Module;

/// `HarnessAdaptersApi` — `core.harnessAdapters`.
pub struct HarnessAdaptersApi;

/// `createHarnessAdapters()`.
pub fn create_harness_adapters() -> HarnessAdaptersApi {
    HarnessAdaptersApi
}

impl HarnessAdaptersApi {
    /// A built-in's own adapter, else — a custom harness — the one its
    /// registration mode names.
    pub fn adapter_for(&self, harness: &HarnessDefinition) -> &'static dyn HarnessAdapter {
        adapter_for(harness)
    }

    /// What a harness reports about usage; `seen` (what its own data shows)
    /// counts even where its adapter says otherwise.
    pub fn reporting(&self, harness: Option<&HarnessDefinition>, seen: UsageReporting) -> UsageReporting {
        reporting_for(harness, seen)
    }

    pub fn logo(&self, harness_id: &str) -> Option<HarnessMark> {
        harness_logo(harness_id)
    }
}

/// `harnessAdaptersModule`.
pub struct HarnessAdaptersModule;

impl Module for HarnessAdaptersModule {
    const NAME: &'static str = "harnessAdapters";
    type Api = HarnessAdaptersApi;
    type Workspace = ();

    fn register(_: &notefig_core::ModuleContext) -> HarnessAdaptersApi {
        create_harness_adapters()
    }
}
