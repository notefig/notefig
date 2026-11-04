//! Gemini CLI (`gemini --experimental-acp`): no app tools ("none").

use crate::adapter::*;
use notefig_agent::usage::UsageReader;

pub struct GeminiCli;

impl UsageReader for GeminiCli {}

impl HarnessAdapter for GeminiCli {
    fn on_invoke(&self, _ctx: &InvokeContext) -> SpawnPrep {
        no_prep()
    }
    fn tool_name_prefixes(&self) -> &'static [&'static str] {
        KNOWN_TOOL_PREFIXES
    }
    fn catalog_discovery(&self) -> CatalogDiscovery {
        CatalogDiscovery::BySession
    }
    fn logo(&self) -> Option<HarnessMark> {
        Some(HarnessMark {
            view_box: "0 0 24 24",
            fill_rule_evenodd: false,
            paths: &[(
                "M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12Z",
                None,
            )],
        })
    }
}
