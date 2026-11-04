//! Port of `harness-adapters/harness-adapters.test.ts`, one test per TS
//! `it(...)` (the `it.each` runs as a loop in one test).
//!
//! Divergences forced by the Rust shape:
//! - `onInvoke(ctx)` is sync and takes one `write_file` per file; the
//!   recording fake below stands in for the TS `writeFiles`.
//! - `reporting(harnessId, seen)` takes the resolved definition here (the
//!   agents host resolves the id), so `reporting` below resolves it the way
//!   TS `createHarnessAdapters` does: configured first, then the built-ins.
//! - `discoverCatalog(io)` is a `CatalogDiscovery` value that the agents
//!   host runs; the tests assert the value and the OpenCode parser.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::{Value, json};

use notefig_agent::harness::{
    HarnessCatalog, HarnessDefinition, McpRegistration, built_in_harnesses,
};
use notefig_agent::model::{ConfigChoice, ConfigOptions, SessionConfigSelect};
use notefig_agent::prompt::{PromptCommand, place_commands as place, with_first_text};
use notefig_agent::usage::UsageReader;

use crate::*;

/// The host supplies the app dir; the adapters thread it through.
const APP_DIR: &str = APP_DIR_NAME;

fn harness(id: &str) -> HarnessDefinition {
    built_in_harnesses()
        .into_iter()
        .find(|entry| entry.id == id)
        .unwrap()
}

fn custom_from(id: &str) -> HarnessDefinition {
    HarnessDefinition {
        id: "custom:lab".into(),
        ..harness(id)
    }
}

/// The relay as mcp_bridge mints it: a constant command, a per-task port in
/// the args and a per-task token in the env.
fn relay(port: &str, token: &str) -> StdioMcpServer {
    StdioMcpServer {
        name: "notefig".into(),
        command: "/Applications/Notefig.app/notefig".into(),
        args: vec!["--mcp-stdio-relay".into(), port.into()],
        env: vec![("NOTEFIG_MCP_TOKEN".into(), token.into())],
    }
}

fn default_relay() -> StdioMcpServer {
    relay("61234", "tok-1")
}

/// A context whose filesystem records instead of writing.
struct Context {
    harness_env: BTreeMap<String, String>,
    mcp_server: Option<StdioMcpServer>,
    /// Some = every write fails with this message.
    write_error: Option<String>,
}

impl Default for Context {
    fn default() -> Self {
        Self {
            harness_env: BTreeMap::new(),
            mcp_server: Some(default_relay()),
            write_error: None,
        }
    }
}

struct Invoked {
    prep: SpawnPrep,
    written: Vec<(String, String)>,
    warnings: Vec<String>,
}

fn run(adapter: &dyn HarnessAdapter, context: Context) -> Invoked {
    let written = RefCell::new(Vec::new());
    let warnings = RefCell::new(Vec::new());
    let write = |path: &Path, content: &str| match &context.write_error {
        Some(message) => Err(message.clone()),
        None => {
            written
                .borrow_mut()
                .push((path.to_string_lossy().into_owned(), content.to_string()));
            Ok(())
        }
    };
    let warn = |label: &str, _detail: &str| warnings.borrow_mut().push(label.to_string());
    let prep = adapter.on_invoke(&InvokeContext {
        workspace_path: Path::new("/ws"),
        harness_env: &context.harness_env,
        mcp_server: context.mcp_server.as_ref(),
        write_file: &write,
        warn: &warn,
    });
    Invoked {
        prep,
        written: written.into_inner(),
        warnings: warnings.into_inner(),
    }
}

fn invoke(id: &str, context: Context) -> Invoked {
    run(adapter_for(&harness(id)), context)
}

fn env_config(prep: &SpawnPrep) -> Value {
    serde_json::from_str(&prep.env["OPENCODE_CONFIG_CONTENT"]).unwrap()
}

/// `createHarnessAdapters({ harnesses }).reporting(id, seen)`.
fn reporting(configured: &[HarnessDefinition], id: &str, seen: UsageReporting) -> UsageReporting {
    let definition = configured
        .iter()
        .find(|h| h.id == id)
        .cloned()
        .or_else(|| built_in_harnesses().into_iter().find(|h| h.id == id));
    create_harness_adapters().reporting(definition.as_ref(), seen)
}

const NONE_SEEN: UsageReporting = UsageReporting {
    cost: false,
    limits: false,
};

// ---- harness adapters ----

#[test]
fn puts_a_session_new_harnesss_server_on_the_wire_and_nowhere_else() {
    let Invoked { prep, written, .. } = invoke("claude-code", Context::default());

    assert!(prep.pass_through_session_new);
    assert!(prep.env.is_empty());
    assert!(written.is_empty());
}

#[test]
fn gives_a_none_harness_nothing_at_all() {
    let Invoked { prep, written, .. } = invoke("gemini-cli", Context::default());

    assert_eq!(prep, no_prep());
    assert!(written.is_empty());
}

#[test]
fn gives_a_custom_harness_the_generic_adapter_its_registration_mode_names() {
    let prep_for = |mode: McpRegistration| {
        let custom = HarnessDefinition {
            id: "custom:lab".into(),
            command: "lab-acp".into(),
            mcp_registration: mode,
            ..harness("gemini-cli")
        };
        run(adapter_for(&custom), Context::default()).prep
    };

    assert!(prep_for(McpRegistration::SessionNew).pass_through_session_new);
    assert!(
        prep_for(McpRegistration::OpencodeConfig)
            .env
            .contains_key("OPENCODE_CONFIG_CONTENT")
    );
    assert!(
        prep_for(McpRegistration::DevinConfig)
            .session_params
            .contains_key("additionalDirectories")
    );
    assert_eq!(prep_for(McpRegistration::None), no_prep());
}

#[test]
fn hands_opencode_inline_config_in_the_env_touching_no_disk() {
    let Invoked { prep, written, .. } = invoke("opencode", Context::default());

    let config = env_config(&prep);
    assert_eq!(
        config["mcp"]["notefig"],
        json!({
            "type": "local",
            "command": ["/Applications/Notefig.app/notefig", "--mcp-stdio-relay", "61234"],
            "enabled": true,
            "environment": {"NOTEFIG_MCP_TOKEN": "tok-1"},
        })
    );
    assert!(written.is_empty());
    assert!(!prep.pass_through_session_new);
}

#[test]
fn deep_merges_a_harness_env_opencode_config_content_under_our_entry() {
    let user = json!({
        "theme": "user-theme",
        "mcp": {
            "userServer": {"type": "remote", "url": "https://x.example"},
            // Collides with the entry we inject: nested keys merge, our
            // scalars win, foreign keys survive.
            "notefig": {"enabled": false, "timeout": 99},
        },
    });
    let Invoked { prep, .. } = invoke(
        "opencode",
        Context {
            harness_env: [("OPENCODE_CONFIG_CONTENT".to_string(), user.to_string())].into(),
            ..Context::default()
        },
    );

    let config = env_config(&prep);
    assert_eq!(config["theme"], "user-theme");
    assert_eq!(config["mcp"]["userServer"]["url"], "https://x.example");
    assert_eq!(config["mcp"]["notefig"]["enabled"], true); // ours wins the collision
    assert_eq!(config["mcp"]["notefig"]["timeout"], 99); // theirs survives the merge
}

#[test]
fn degrades_unparseable_harness_config_to_an_empty_base() {
    let Invoked { prep, .. } = invoke(
        "opencode",
        Context {
            harness_env: [("OPENCODE_CONFIG_CONTENT".to_string(), "{not json".to_string())].into(),
            ..Context::default()
        },
    );

    assert!(!env_config(&prep)["mcp"]["notefig"].is_null());
}

#[test]
fn writes_devin_a_config_in_the_app_dir_that_names_no_task_specific_value() {
    let Invoked { prep, written, .. } = invoke("devin", Context::default());

    assert_eq!(written.len(), 1);
    assert_eq!(written[0].0, format!("/ws/{APP_DIR}/.devin/mcp_config.local.json"));
    // Every per-task value is a reference devin expands from the spawn env.
    let content: Value = serde_json::from_str(&written[0].1).unwrap();
    assert_eq!(
        content["mcpServers"]["notefig"],
        json!({
            "command": "/Applications/Notefig.app/notefig",
            "args": ["${env:NOTEFIG_MCP_ARG_0}", "${env:NOTEFIG_MCP_ARG_1}"],
            "env": {"NOTEFIG_MCP_TOKEN": "${env:NOTEFIG_MCP_TOKEN}"},
        })
    );
    let expected: BTreeMap<String, String> = [
        ("NOTEFIG_MCP_ARG_0", "--mcp-stdio-relay"),
        ("NOTEFIG_MCP_ARG_1", "61234"),
        ("NOTEFIG_MCP_TOKEN", "tok-1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    assert_eq!(prep.env, expected);
    assert!(!prep.pass_through_session_new);
}

#[test]
fn writes_the_same_devin_file_for_every_task_whatever_its_relay() {
    let first = invoke("devin", Context::default());
    let second = invoke(
        "devin",
        Context {
            mcp_server: Some(relay("62000", "tok-2")),
            ..Context::default()
        },
    );

    assert_eq!(second.written[0].1, first.written[0].1);
    assert_ne!(second.prep.env, first.prep.env);
}

#[test]
fn degrades_a_failed_devin_write_to_a_spawn_without_app_tools() {
    let Invoked { prep, warnings, .. } = invoke(
        "devin",
        Context {
            write_error: Some("disk full".into()),
            ..Context::default()
        },
    );

    assert_eq!(prep, no_prep());
    assert_eq!(warnings.len(), 1);
}

#[test]
fn names_the_app_dir_in_devins_session_so_the_toolbox_sees_that_file() {
    let Invoked { prep, .. } = invoke("devin", Context::default());

    let mut expected = serde_json::Map::new();
    expected.insert("additionalDirectories".into(), json!([format!("/ws/{APP_DIR}")]));
    assert_eq!(prep.session_params, expected);
}

#[test]
fn preps_nothing_when_there_is_no_endpoint() {
    for id in ["claude-code", "opencode", "devin", "gemini-cli"] {
        let Invoked { prep, written, .. } = invoke(
            id,
            Context {
                mcp_server: None,
                ..Context::default()
            },
        );
        assert_eq!(prep, no_prep(), "{id}");
        assert!(written.is_empty(), "{id}");
    }
}

// "only puts a non-stdio server on the wire — no dialect can write one":
// not ported. `InvokeContext.mcp_server` is `StdioMcpServer` only;
// notefig-agent has no HTTP/SSE `McpServer` variant to hand an adapter.

// ---- usage reporting ----

#[test]
fn knows_what_the_built_ins_report_and_believes_the_data_over_the_table() {
    let r = |cost, limits| UsageReporting { cost, limits };
    assert_eq!(reporting(&[], "claude-code", NONE_SEEN), r(true, true));
    assert_eq!(reporting(&[], "opencode", NONE_SEEN), r(true, false));
    assert_eq!(reporting(&[], "devin", NONE_SEEN), r(false, false));
    assert_eq!(reporting(&[], "gemini-cli", NONE_SEEN), r(false, false));
    assert_eq!(reporting(&[], "custom:1", r(true, false)), r(true, false));
    assert_eq!(reporting(&[], "devin", r(false, true)), r(false, true));
}

#[test]
fn declares_nothing_for_a_custom_harness_whichever_built_ins_tools_it_borrows() {
    let mut configured = built_in_harnesses();
    configured.push(custom_from("claude-code"));
    assert_eq!(reporting(&configured, "custom:lab", NONE_SEEN), NONE_SEEN);
    assert_eq!(
        reporting(
            &configured,
            "custom:lab",
            UsageReporting {
                cost: true,
                limits: false
            }
        ),
        UsageReporting {
            cost: true,
            limits: false
        }
    );
}

// ---- logos ----

#[test]
fn gives_each_built_in_its_own_mark_and_a_custom_harness_none() {
    let marks: Vec<Option<HarnessMark>> = built_in_harnesses()
        .iter()
        .map(|built| harness_logo(&built.id))
        .collect();
    assert!(marks.iter().all(|m| m.is_some_and(|m| !m.paths.is_empty())));
    let firsts: HashSet<&str> = marks.iter().map(|m| m.unwrap().paths[0].0).collect();
    assert_eq!(firsts.len(), marks.len());
    assert!(harness_logo("custom:lab").is_none());
}

// ---- initialize ----

#[test]
fn advertises_subagent_support_to_devin_and_to_custom_harnesses_that_may_be_devin() {
    let subagents = json!({"cognition.ai/subagentSupport": true});
    assert_eq!(adapter_for(&harness("devin")).client_meta(), Some(subagents.clone()));
    assert_eq!(
        adapter_for(&custom_from("gemini-cli")).client_meta(),
        Some(subagents)
    );
    for id in ["claude-code", "opencode", "gemini-cli"] {
        assert_eq!(adapter_for(&harness(id)).client_meta(), None, "{id}");
    }
}

// ---- tool names ----

#[test]
fn strips_the_prefix_each_harness_mints_and_either_where_its_unrecorded() {
    assert_eq!(
        adapter_for(&harness("claude-code")).tool_name_prefixes(),
        ["mcp__notefig__"]
    );
    assert_eq!(adapter_for(&harness("opencode")).tool_name_prefixes(), ["notefig_"]);
    for id in ["devin", "gemini-cli"] {
        assert_eq!(
            adapter_for(&harness(id)).tool_name_prefixes(),
            ["mcp__notefig__", "notefig_"],
            "{id}"
        );
    }
    assert_eq!(
        adapter_for(&custom_from("claude-code")).tool_name_prefixes(),
        ["mcp__notefig__", "notefig_"]
    );
}

#[test]
fn reads_devins_tool_from_its_meta_its_own_and_a_custom_harnesss_alike() {
    let call = json!({
        "title": "Calling widget_respond from notefig",
        "_meta": {"cognition.ai/toolName": "mcp__notefig__widget_respond"},
    });
    for definition in [harness("devin"), custom_from("claude-code")] {
        assert_eq!(
            tool_call_title(adapter_for(&definition), &call).as_deref(),
            Some("widget_respond")
        );
    }
    // Untagged, the title stands, its prefix stripped.
    assert_eq!(
        tool_call_title(
            adapter_for(&harness("devin")),
            &json!({"title": "mcp__notefig__author_blob"})
        )
        .as_deref(),
        Some("author_blob")
    );
    assert_eq!(
        tool_call_title(adapter_for(&harness("claude-code")), &call).as_deref(),
        Some("Calling widget_respond from notefig")
    );
    assert_eq!(tool_call_title(adapter_for(&harness("devin")), &json!({})), None);
}

#[test]
fn keeps_devins_name_for_the_apps_tool_through_its_past_tense_retitle() {
    let devin = adapter_for(&harness("devin"));
    // Once the call has run, the tool is named only as the one the model asked for.
    let retitle = json!({
        "title": "Called widget_respond from notefig",
        "_meta": {"cognition.ai/inferenceToolName": "mcp__notefig__widget_respond"},
    });
    assert_eq!(tool_call_title(devin, &retitle).as_deref(), Some("widget_respond"));
    // A generic inference name or another server's tool leaves the title as
    // Devin wrote it.
    assert_eq!(
        tool_call_title(
            devin,
            &json!({
                "title": "Calling notefig_marker from notefig",
                "_meta": {"cognition.ai/inferenceToolName": "mcp_call_tool"},
            })
        )
        .as_deref(),
        Some("Calling notefig_marker from notefig")
    );
    assert_eq!(
        tool_call_title(
            devin,
            &json!({
                "title": "Calling create_issue from github",
                "_meta": {"cognition.ai/toolName": "mcp__github__create_issue"},
            })
        )
        .as_deref(),
        Some("Calling create_issue from github")
    );
}

// ---- sign-in errors ----

#[test]
fn reads_claude_agent_acps_error_as_a_sign_in_for_every_harness_nothing_else() {
    for built in built_in_harnesses() {
        let adapter = adapter_for(&built);
        assert!(needs_sign_in(adapter, "Authentication required"), "{}", built.id);
        assert!(!needs_sign_in(adapter, "Internal error"), "{}", built.id);
    }
}

/// An adapter whose harness words its sign-in error differently.
struct LogsIn;
impl UsageReader for LogsIn {}
impl HarnessAdapter for LogsIn {
    fn on_invoke(&self, _: &InvokeContext) -> SpawnPrep {
        no_prep()
    }
    fn tool_name_prefixes(&self) -> &'static [&'static str] {
        KNOWN_TOOL_PREFIXES
    }
    fn is_auth_error(&self, message: &str) -> Option<bool> {
        Some(message == "please log in")
    }
}

#[test]
fn asks_a_harness_that_words_it_differently() {
    assert!(needs_sign_in(&LogsIn, "please log in"));
    assert!(!needs_sign_in(&LogsIn, "Authentication required"));
}

// ---- catalog discovery ----

#[test]
fn opens_a_throwaway_session() {
    // it.each(["claude-code", "devin", "gemini-cli"])
    for id in ["claude-code", "devin", "gemini-cli"] {
        assert!(
            matches!(
                adapter_for(&harness(id)).catalog_discovery(),
                CatalogDiscovery::BySession
            ),
            "{id}"
        );
    }
}

fn opencode_discovery() -> (Vec<String>, fn(&str) -> Option<HarnessCatalog>) {
    match adapter_for(&harness("opencode")).catalog_discovery() {
        CatalogDiscovery::ByCommand { args, parse } => (args, parse),
        _ => panic!("OpenCode should list its models by command"),
    }
}

#[test]
fn opencode_lists_its_models_and_opens_no_session_it_cant_delete_one() {
    let (args, parse) = opencode_discovery();
    assert_eq!(args, ["models"]);
    let catalog = parse("Some banner\nanthropic/claude-sonnet-4-5\nopenai/gpt-5.1-codex\n\n");

    let choice = |m: &str| ConfigChoice {
        value: m.into(),
        name: m.into(),
        description: None,
    };
    assert_eq!(
        catalog,
        Some(HarnessCatalog {
            config_options: Some(vec![SessionConfigSelect {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                kind: "select".into(),
                current_value: json!("anthropic/claude-sonnet-4-5"),
                options: ConfigOptions::Flat(vec![
                    choice("anthropic/claude-sonnet-4-5"),
                    choice("openai/gpt-5.1-codex"),
                ]),
            }]),
            commands: None,
        })
    );
}

#[test]
fn opencode_finds_nothing_when_the_listing_fails_or_lists_no_model() {
    // A listing that fails to run or exits non-zero is turned into "nothing"
    // by the agents host before the parser (`probe_catalog`); only the
    // parse half lives here.
    let (_, parse) = opencode_discovery();
    assert_eq!(parse("no models\n"), None);
    assert_eq!(parse("error"), None);
}

#[test]
fn a_custom_harness_has_no_probe_only_its_sessions_tell() {
    let custom = HarnessDefinition {
        mcp_registration: McpRegistration::SessionNew,
        ..custom_from("claude-code")
    };
    assert!(matches!(
        adapter_for(&custom).catalog_discovery(),
        CatalogDiscovery::None
    ));
}

// ---- placeCommands ----

fn blocks() -> Vec<Value> {
    vec![
        json!({"type": "text", "text": "> quote\n\nfix it"}),
        json!({"type": "resource_link", "uri": "file:///ws/notes.md", "name": "notes.md"}),
    ]
}

fn commands(names: &[&str]) -> Vec<PromptCommand> {
    names
        .iter()
        .map(|name| PromptCommand { name: name.to_string() })
        .collect()
}

/// TS `placeCommands(adapter, blocks, commands)`: the adapter's own
/// placement, else the start of the first text block.
fn place_commands(adapter: &dyn HarnessAdapter, blocks: Vec<Value>, commands: &[PromptCommand]) -> Vec<Value> {
    let placer = |blocks: Vec<Value>, name: &str| {
        adapter
            .place_command(blocks.clone(), name)
            .unwrap_or_else(|| with_first_text(blocks, |t| format!("/{name} {t}")))
    };
    place(blocks, commands, Some(&placer))
}

#[test]
fn leaves_a_prompt_with_no_command_as_it_was() {
    assert_eq!(
        place_commands(adapter_for(&harness("claude-code")), blocks(), &[]),
        blocks()
    );
}

#[test]
fn puts_claudes_command_in_a_block_of_its_own_last() {
    let mut expected = blocks();
    expected.push(json!({"type": "text", "text": "/review"}));
    assert_eq!(
        place_commands(adapter_for(&harness("claude-code")), blocks(), &commands(&["review"])),
        expected
    );
}

#[test]
fn starts_the_first_text_block_with_it_elsewhere() {
    assert_eq!(
        place_commands(adapter_for(&harness("opencode")), blocks(), &commands(&["review"]))[0],
        json!({"type": "text", "text": "/review > quote\n\nfix it"})
    );
}

#[test]
fn asks_for_any_further_command_in_words() {
    let placed = place_commands(
        adapter_for(&harness("claude-code")),
        blocks(),
        &commands(&["review", "deploy"]),
    );
    assert_eq!(
        placed[0],
        json!({"type": "text", "text": "> quote\n\nfix it\n\nAlso use the `deploy` skill."})
    );
    assert_eq!(
        placed.last().unwrap(),
        &json!({"type": "text", "text": "/review"})
    );
}
