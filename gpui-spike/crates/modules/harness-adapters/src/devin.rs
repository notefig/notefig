//! Devin (`devin acp`), `harness-adapters/devin.ts`. Registration
//! "devin-config": one project config under `<ws>/.notefig/.devin/` whose
//! values are `${env:…}` references expanded from the spawn env, named in
//! the session's `additionalDirectories`.

use serde_json::{Map, Value, json};

use crate::adapter::*;
use notefig_agent::usage::{Cost, CostType, TokenCounts, UsageReader, acp_cost_total, tokens_from};

const ARG_VAR_PREFIX: &str = "NOTEFIG_MCP_ARG_";
const DEVIN_CREDIT: &str = "devin-credit";
const TOOL_NAME_KEYS: &[&str] = &["cognition.ai/toolName", "cognition.ai/inferenceToolName"];

pub struct Devin;

fn meta_number(update: &Value, key: &str) -> Option<f64> {
    update
        .get("_meta")?
        .get(key)?
        .as_f64()
        .filter(|n| n.is_finite())
}

/// `"root"`, a subagent id, or None (Devin's plain copy of a main-agent update).
pub fn devin_agent_of(update: &Value) -> Option<String> {
    update
        .get("_meta")?
        .get("cognition.ai/subagent_context")?
        .get("parentAgentId")?
        .as_str()
        .map(str::to_string)
}

/// The app's tool a Devin call names (its titles are prose).
pub fn devin_tool_name_of(update: &Value) -> Option<String> {
    let meta = update.get("_meta")?;
    TOOL_NAME_KEYS
        .iter()
        .filter_map(|k| meta.get(*k)?.as_str())
        .find(|n| n.starts_with(CLAUDE_TOOL_PREFIX))
        .map(str::to_string)
}

pub fn devin_cost_total(update: &Value) -> Option<Cost> {
    acp_cost_total(update).or_else(|| {
        meta_number(update, "cognition.ai/totalCreditCost").map(|amount| Cost {
            amount,
            currency: DEVIN_CREDIT.into(),
            kind: CostType::Credits,
        })
    })
}

pub fn devin_request_tokens(updates: &[Value]) -> Option<TokenCounts> {
    let mut sum: Option<TokenCounts> = None;
    for update in updates {
        if devin_agent_of(update).is_none() {
            continue;
        }
        let Some(input) = meta_number(update, "cognition.ai/inputTokens") else {
            continue;
        };
        let raw = json!({
            "inputTokens": input,
            "outputTokens": meta_number(update, "cognition.ai/outputTokens").unwrap_or(0.0),
            "cachedReadTokens": meta_number(update, "cognition.ai/cachedReadTokens"),
            "cachedWriteTokens": meta_number(update, "cognition.ai/cachedWriteTokens"),
        });
        let tokens = tokens_from(&raw, true);
        sum = Some(sum.map(|s| s.add(&tokens)).unwrap_or(tokens));
    }
    sum
}

pub fn has_devin_meta(response: &Value) -> bool {
    response
        .get("_meta")
        .and_then(Value::as_object)
        .is_some_and(|m| m.keys().any(|k| k.starts_with("cognition.ai/")))
}

pub fn devin_client_meta() -> Value {
    json!({"cognition.ai/subagentSupport": true})
}

impl UsageReader for Devin {
    fn cache_in_input(&self, _response: &Value) -> bool {
        true
    }
    fn cost_total(&self, update: &Value) -> Option<Cost> {
        devin_cost_total(update)
    }
    fn request_tokens(&self, updates: &[Value]) -> Option<TokenCounts> {
        devin_request_tokens(updates)
    }
}

/// The devin registration, shared with custom entries in that mode.
pub fn devin_on_invoke(ctx: &InvokeContext) -> SpawnPrep {
    let Some(server) = ctx.mcp_server else {
        return no_prep();
    };
    let args: Vec<String> = (0..server.args.len())
        .map(|i| format!("${{env:{ARG_VAR_PREFIX}{i}}}"))
        .collect();
    let env: Map<String, Value> = server
        .env
        .iter()
        .map(|(n, _)| (n.clone(), Value::String(format!("${{env:{n}}}"))))
        .collect();
    let document = json!({"mcpServers": {server.name.clone(): {"command": server.command, "args": args, "env": env}}});
    let app_dir = join(ctx.workspace_path, &[APP_DIR_NAME]);
    let path = join(&app_dir, &[".devin", "mcp_config.local.json"]);
    let content = serde_json::to_string_pretty(&document).unwrap_or_default();
    if let Err(message) = (ctx.write_file)(&path, &content) {
        (ctx.warn)(
            "harness MCP config write failed; spawning without app tools",
            &message,
        );
        return no_prep();
    }
    let mut prep = no_prep();
    for (i, value) in server.args.iter().enumerate() {
        prep.env
            .insert(format!("{ARG_VAR_PREFIX}{i}"), value.clone());
    }
    for (name, value) in &server.env {
        prep.env.insert(name.clone(), value.clone());
    }
    prep.session_params.insert(
        "additionalDirectories".into(),
        json!([app_dir.to_string_lossy()]),
    );
    prep
}

impl HarnessAdapter for Devin {
    fn on_invoke(&self, ctx: &InvokeContext) -> SpawnPrep {
        devin_on_invoke(ctx)
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
    fn catalog_discovery(&self) -> CatalogDiscovery {
        CatalogDiscovery::BySession
    }
    fn logo(&self) -> Option<HarnessMark> {
        Some(HarnessMark {
            view_box: "60 39 306 348",
            fill_rule_evenodd: true,
            paths: &[(DEVIN_PATH, None)],
        })
    }
}

const DEVIN_PATH: &str = "M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z";

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[test]
    fn writes_config_with_env_refs() {
        let server = StdioMcpServer {
            name: "notefig".into(),
            command: "/relay".into(),
            args: vec!["99".into()],
            env: vec![("NOTEFIG_MCP_TOKEN".into(), "tok".into())],
        };
        let written = RefCell::new(None);
        let env = BTreeMap::new();
        let ctx = InvokeContext {
            workspace_path: std::path::Path::new("/w"),
            harness_env: &env,
            mcp_server: Some(&server),
            write_file: &|p, c| {
                *written.borrow_mut() = Some((p.to_path_buf(), c.to_string()));
                Ok(())
            },
            warn: &|_, _| {},
        };
        let prep = Devin.on_invoke(&ctx);
        let (path, content) = written.into_inner().unwrap();
        assert_eq!(
            path,
            std::path::PathBuf::from("/w/.notefig/.devin/mcp_config.local.json")
        );
        assert!(content.contains("${env:NOTEFIG_MCP_ARG_0}"));
        assert_eq!(prep.env["NOTEFIG_MCP_ARG_0"], "99");
        assert_eq!(prep.env["NOTEFIG_MCP_TOKEN"], "tok");
        assert_eq!(
            prep.session_params["additionalDirectories"],
            json!(["/w/.notefig"])
        );
    }

    #[test]
    fn sums_tagged_request_tokens() {
        let updates = vec![
            json!({"_meta": {"cognition.ai/inputTokens": 10, "cognition.ai/outputTokens": 2}}),
            json!({"_meta": {"cognition.ai/subagent_context": {"parentAgentId": "root"}, "cognition.ai/inputTokens": 10, "cognition.ai/cachedReadTokens": 4, "cognition.ai/outputTokens": 2}}),
            json!({"_meta": {"cognition.ai/subagent_context": {"parentAgentId": "sub1"}, "cognition.ai/inputTokens": 5, "cognition.ai/outputTokens": 1}}),
        ];
        let t = devin_request_tokens(&updates).unwrap();
        assert_eq!(t.input, 6.0 + 5.0);
        assert_eq!(t.output, 3.0);
    }
}
