//! OpenCode (`opencode acp`), `harness-adapters/opencode.ts`.
//! Registration "opencode-config": the MCP server is injected as inline
//! `OPENCODE_CONFIG_CONTENT` JSON, deep-merged over any the user set.

use serde_json::{Map, Value, json};

use crate::adapter::*;
use notefig_agent::harness::HarnessCatalog;
use notefig_agent::model::{ConfigChoice, ConfigOptions, SessionConfigSelect};
use notefig_agent::usage::UsageReader;

pub struct OpenCode;

impl UsageReader for OpenCode {}

/// OpenCode's config-merge semantics: objects merge, arrays concatenate,
/// overlay scalars win.
pub fn deep_merge_configs(
    base: Map<String, Value>,
    overlay: Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = base;
    for (key, value) in overlay {
        let next = match (merged.remove(&key), value) {
            (Some(Value::Object(a)), Value::Object(b)) => Value::Object(deep_merge_configs(a, b)),
            (Some(Value::Array(mut a)), Value::Array(b)) => {
                a.extend(b);
                Value::Array(a)
            }
            (_, v) => v,
        };
        merged.insert(key, next);
    }
    merged
}

fn parse_config_object(raw: Option<&String>) -> Map<String, Value> {
    raw.and_then(|r| serde_json::from_str::<Value>(r).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// `opencode models`: one `provider/model` per line → a model option.
pub fn parse_opencode_models(stdout: &str) -> Option<HarnessCatalog> {
    let models: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| {
            let Some((provider, model)) = line.split_once('/') else {
                return false;
            };
            !provider.is_empty()
                && provider
                    .chars()
                    // TS `/^[\w.-]+\/\S+$/`: `\w` is ASCII.
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
                && !model.is_empty()
                && !model.chars().any(char::is_whitespace)
        })
        .collect();
    let first = *models.first()?;
    Some(HarnessCatalog {
        config_options: Some(vec![SessionConfigSelect {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some("model".into()),
            kind: "select".into(),
            current_value: Value::String(first.into()),
            options: ConfigOptions::Flat(
                models
                    .iter()
                    .map(|m| ConfigChoice {
                        value: m.to_string(),
                        name: m.to_string(),
                        description: None,
                    })
                    .collect(),
            ),
        }]),
        commands: None,
    })
}

impl HarnessAdapter for OpenCode {
    fn on_invoke(&self, ctx: &InvokeContext) -> SpawnPrep {
        let Some(server) = ctx.mcp_server else {
            return no_prep();
        };
        let environment: Map<String, Value> = server
            .env
            .iter()
            .map(|(n, v)| (n.clone(), Value::String(v.clone())))
            .collect();
        let mut command = vec![server.command.clone()];
        command.extend(server.args.iter().cloned());
        let overlay = json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": { server.name.clone(): {
                "type": "local",
                "command": command,
                "enabled": true,
                "environment": environment,
            }},
        });
        let Value::Object(overlay) = overlay else {
            unreachable!()
        };
        let config = deep_merge_configs(
            parse_config_object(ctx.harness_env.get("OPENCODE_CONFIG_CONTENT")),
            overlay,
        );
        let mut prep = no_prep();
        prep.env.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            Value::Object(config).to_string(),
        );
        prep
    }
    fn reporting(&self) -> UsageReporting {
        UsageReporting {
            cost: true,
            limits: false,
        }
    }
    fn tool_name_prefixes(&self) -> &'static [&'static str] {
        &[OPENCODE_TOOL_PREFIX]
    }
    /// Not by session: OpenCode can't delete one.
    fn catalog_discovery(&self) -> CatalogDiscovery {
        CatalogDiscovery::ByCommand {
            args: vec!["models".into()],
            parse: parse_opencode_models,
        }
    }
    fn logo(&self) -> Option<HarnessMark> {
        Some(HarnessMark {
            view_box: "0 0 240 300",
            fill_rule_evenodd: false,
            paths: &[
                ("M180 240H60V120H180V240Z", Some(0.45)),
                ("M180 60H60V240H180V60ZM240 300H0V0H240V300Z", None),
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn injects_config_content_over_users() {
        let server = StdioMcpServer {
            name: "notefig".into(),
            command: "/relay".into(),
            args: vec!["1234".into()],
            env: vec![("NOTEFIG_MCP_TOKEN".into(), "t".into())],
        };
        let env: BTreeMap<String, String> = [(
            "OPENCODE_CONFIG_CONTENT".to_string(),
            r#"{"mcp":{"mine":{"type":"local"}},"x":[1]}"#.to_string(),
        )]
        .into();
        let ctx = InvokeContext {
            workspace_path: std::path::Path::new("/w"),
            harness_env: &env,
            mcp_server: Some(&server),
            write_file: &|_, _| Ok(()),
            warn: &|_, _| {},
        };
        let prep = OpenCode.on_invoke(&ctx);
        let config: Value = serde_json::from_str(&prep.env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(
            config["mcp"]["notefig"]["command"],
            json!(["/relay", "1234"])
        );
        assert_eq!(
            config["mcp"]["notefig"]["environment"]["NOTEFIG_MCP_TOKEN"],
            "t"
        );
        assert!(config["mcp"]["mine"].is_object());
        assert!(!prep.pass_through_session_new);
    }

    #[test]
    fn parses_models() {
        let catalog =
            parse_opencode_models("banner text\nanthropic/claude-x\nopenai/gpt-5\n").unwrap();
        let option = &catalog.config_options.unwrap()[0];
        assert_eq!(option.current(), Some("anthropic/claude-x"));
        assert_eq!(option.choices().len(), 2);
        assert!(parse_opencode_models("nothing here").is_none());
    }
}
