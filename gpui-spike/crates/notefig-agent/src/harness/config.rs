//! Harness definitions, per-machine overrides, custom entries and the views
//! over them (port of `shared/src/agent/harness-config.ts` and
//! `desktop/src/modules/agents/harness-settings.ts`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::{AvailableCommand, SessionConfigSelect};

/// Substituted with the workspace path in `args` at spawn.
pub const WORKSPACE_PLACEHOLDER: &str = "${workspace}";
/// `command` scheme naming a bundled sidecar.
pub const SIDECAR_SCHEME: &str = "sidecar:";
pub const SIDECAR_NAMES: &[&str] = &["claude-agent-acp"];

/// How a harness learns about the app's MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum McpRegistration {
    /// ACP `session/new.mcpServers` (claude-agent-acp).
    SessionNew,
    /// `OPENCODE_CONFIG_CONTENT` env.
    OpencodeConfig,
    /// A devin project config under `<ws>/.notefig/` + `additionalDirectories`.
    DevinConfig,
    #[default]
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDefinition {
    pub id: String,
    pub label: String,
    /// Executable (PATH-resolved) or `sidecar:<name>`.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Shell snippet whose stdout proves the install; default `command -v <command>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<String>,
    /// `cd ${workspace} && claude --resume ${sessionId}` — placeholders are
    /// substituted already shell-quoted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
    pub mcp_registration: McpRegistration,
}

fn def(
    id: &str,
    label: &str,
    command: &str,
    args: &[&str],
    probe: Option<&str>,
    auth_hint: &str,
    resume: Option<&str>,
    mcp: McpRegistration,
) -> HarnessDefinition {
    HarnessDefinition {
        id: id.into(),
        label: label.into(),
        command: command.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: BTreeMap::new(),
        probe_command: probe.map(str::to_string),
        auth_hint: Some(auth_hint.into()),
        resume_command: resume.map(str::to_string),
        mcp_registration: mcp,
    }
}

/// `BUILT_IN_HARNESSES`, verbatim.
pub fn built_in_harnesses() -> Vec<HarnessDefinition> {
    vec![
        def(
            "claude-code",
            "Claude Code",
            "sidecar:claude-agent-acp",
            &[],
            Some("command -v claude"),
            "Run `claude /login` in a terminal on this machine.",
            Some("cd ${workspace} && claude --resume ${sessionId}"),
            McpRegistration::SessionNew,
        ),
        def(
            "opencode",
            "OpenCode",
            "opencode",
            &["acp", "--cwd", "${workspace}"],
            None,
            "Run `opencode auth login` in a terminal on this machine.",
            Some("cd ${workspace} && opencode --session ${sessionId}"),
            McpRegistration::OpencodeConfig,
        ),
        def(
            "devin",
            "Devin",
            "devin",
            &["acp"],
            None,
            "Run `devin auth login` in a terminal on this machine.",
            Some("cd ${workspace} && devin --resume ${sessionId}"),
            McpRegistration::DevinConfig,
        ),
        def(
            "gemini-cli",
            "Gemini CLI",
            "gemini",
            &["--experimental-acp"],
            None,
            "Run `gemini` once in a terminal to sign in.",
            None,
            McpRegistration::None,
        ),
    ]
}

pub fn is_built_in(id: &str) -> bool {
    built_in_harnesses().iter().any(|h| h.id == id)
}

/// The sidecar a command names, if any.
pub fn parse_sidecar_command(command: &str) -> Option<&str> {
    let name = command.strip_prefix(SIDECAR_SCHEME)?;
    SIDECAR_NAMES.contains(&name).then_some(name)
}

/// Per-machine override of a built-in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessOverride {
    pub id: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Replaces the built-in's args.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Merged over the built-in's env.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
}

fn yes() -> bool {
    true
}

impl HarnessOverride {
    /// Changes spawn/probe/resume (an enabled-only row is bookkeeping).
    pub fn is_material(&self) -> bool {
        self.command.is_some()
            || self.args.is_some()
            || self.env.is_some()
            || self.probe_command.is_some()
            || self.resume_command.is_some()
    }
}

/// A fully custom harness entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomHarnessEntry {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
    /// Which dialect registers the app's tools; default none.
    #[serde(default)]
    pub mcp_registration_override: McpRegistration,
    #[serde(default = "yes")]
    pub enabled: bool,
}

impl CustomHarnessEntry {
    pub fn definition(&self) -> HarnessDefinition {
        HarnessDefinition {
            id: self.id.clone(),
            label: self.label.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            probe_command: self.probe_command.clone(),
            auth_hint: self.auth_hint.clone(),
            resume_command: self.resume_command.clone(),
            mcp_registration: self.mcp_registration_override,
        }
    }
    pub fn is_valid(&self) -> bool {
        !self.id.is_empty() && !self.label.is_empty() && !self.command.is_empty()
    }
}

/// One probe verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDiscoveryResult {
    pub harness_id: String,
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    pub probed_at: i64,
}

/// What a harness offers (settings + commands), as last reported.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCatalog {
    pub config_options: Option<Vec<SessionConfigSelect>>,
    pub commands: Option<Vec<AvailableCommand>>,
}

/// What this machine records about one harness (the `harnesses` collection).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#override: Option<HarnessOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<CustomHarnessEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<HarnessDiscoveryResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<HarnessCatalog>,
    pub created_at: i64,
}

pub struct Settings {
    pub overrides: BTreeMap<String, HarnessOverride>,
    pub custom: Vec<CustomHarnessEntry>,
    pub discovery: BTreeMap<String, HarnessDiscoveryResult>,
}

pub fn settings_of<'a>(rows: impl IntoIterator<Item = &'a HarnessRow>) -> Settings {
    let mut sorted: Vec<&HarnessRow> = rows.into_iter().collect();
    sorted.sort_by_key(|r| r.created_at);
    let mut s = Settings {
        overrides: BTreeMap::new(),
        custom: vec![],
        discovery: BTreeMap::new(),
    };
    for row in sorted {
        if let Some(o) = &row.r#override {
            s.overrides.insert(row.id.clone(), o.clone());
        }
        if let Some(c) = &row.custom {
            s.custom.push(c.clone());
        }
        if let Some(i) = &row.install {
            s.discovery.insert(row.id.clone(), i.clone());
        }
    }
    s
}

/// Built-ins with overrides applied (disabled dropped) + enabled custom entries.
pub fn resolve_effective_harnesses(
    overrides: &BTreeMap<String, HarnessOverride>,
    custom: &[CustomHarnessEntry],
) -> Vec<HarnessDefinition> {
    let mut effective = vec![];
    for builtin in built_in_harnesses() {
        let Some(o) = overrides.get(&builtin.id) else {
            effective.push(builtin);
            continue;
        };
        if !o.enabled {
            continue;
        }
        let mut env = builtin.env.clone();
        if let Some(extra) = &o.env {
            env.extend(extra.clone());
        }
        effective.push(HarnessDefinition {
            command: o.command.clone().unwrap_or(builtin.command.clone()),
            args: o.args.clone().unwrap_or(builtin.args.clone()),
            env,
            probe_command: o.probe_command.clone().or(builtin.probe_command.clone()),
            resume_command: o.resume_command.clone().or(builtin.resume_command.clone()),
            ..builtin
        });
    }
    for entry in custom.iter().filter(|e| e.enabled) {
        effective.push(entry.definition());
    }
    effective
}

/// Every enabled harness (found or not).
pub fn configured_harnesses<'a>(
    rows: impl IntoIterator<Item = &'a HarnessRow>,
) -> Vec<HarnessDefinition> {
    let s = settings_of(rows);
    resolve_effective_harnesses(&s.overrides, &s.custom)
}

/// What pickers offer: configured, minus built-ins discovery affirmatively
/// didn't find (material overrides and custom entries always show).
pub fn pickable_harnesses<'a>(
    rows: impl IntoIterator<Item = &'a HarnessRow>,
) -> Vec<HarnessDefinition> {
    let s = settings_of(rows);
    let custom_ids: Vec<&str> = s.custom.iter().map(|c| c.id.as_str()).collect();
    resolve_effective_harnesses(&s.overrides, &s.custom)
        .into_iter()
        .filter(|h| {
            s.overrides.get(&h.id).is_some_and(|o| o.is_material())
                || custom_ids.contains(&h.id.as_str())
                || s.discovery.get(&h.id).is_none_or(|d| d.found)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Availability {
    Found,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessOrigin {
    Builtin,
    Overridden,
    Custom,
}

/// One harness as the settings list shows it (incl. disabled/missing).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSettingsRow {
    pub definition: HarnessDefinition,
    pub origin: HarnessOrigin,
    pub enabled: bool,
    pub availability: Availability,
    pub discovery: Option<HarnessDiscoveryResult>,
    pub catalog: Option<HarnessCatalog>,
}

pub fn harness_settings_rows(rows: &BTreeMap<String, HarnessRow>) -> Vec<HarnessSettingsRow> {
    let s = settings_of(rows.values());
    let forced_overrides: BTreeMap<String, HarnessOverride> = s
        .overrides
        .iter()
        .map(|(id, o)| {
            (
                id.clone(),
                HarnessOverride {
                    enabled: true,
                    ..o.clone()
                },
            )
        })
        .collect();
    let forced_custom: Vec<CustomHarnessEntry> = s
        .custom
        .iter()
        .map(|c| CustomHarnessEntry {
            enabled: true,
            ..c.clone()
        })
        .collect();
    resolve_effective_harnesses(&forced_overrides, &forced_custom)
        .into_iter()
        .map(|definition| {
            let id = definition.id.clone();
            let custom = s.custom.iter().find(|c| c.id == id);
            let explicit = match custom {
                Some(c) => Some(c.enabled),
                None => s.overrides.get(&id).map(|o| o.enabled),
            };
            let discovery = s.discovery.get(&id).cloned();
            let enabled = explicit.unwrap_or_else(|| discovery.as_ref().is_none_or(|d| d.found));
            HarnessSettingsRow {
                origin: if custom.is_some() {
                    HarnessOrigin::Custom
                } else if s.overrides.get(&id).is_some_and(|o| o.is_material()) {
                    HarnessOrigin::Overridden
                } else {
                    HarnessOrigin::Builtin
                },
                enabled,
                availability: match &discovery {
                    None => Availability::Unknown,
                    Some(d) if d.found => Availability::Found,
                    Some(_) => Availability::Missing,
                },
                discovery,
                catalog: rows.get(&id).and_then(|r| r.catalog.clone()),
                definition,
            }
        })
        .collect()
}

/// A harness's definition as configured, on or off; None for an unknown id.
pub fn harness_definition(
    rows: &BTreeMap<String, HarnessRow>,
    id: &str,
) -> Option<HarnessDefinition> {
    harness_settings_rows(rows)
        .into_iter()
        .find(|r| r.definition.id == id)
        .map(|r| r.definition)
}

pub fn harness_label(rows: &BTreeMap<String, HarnessRow>, id: &str) -> String {
    harness_definition(rows, id)
        .map(|d| d.label)
        .or_else(|| {
            built_in_harnesses()
                .into_iter()
                .find(|h| h.id == id)
                .map(|h| h.label)
        })
        .unwrap_or_else(|| id.to_string())
}

/// Flip a built-in's enabled flag; returns the override to store (None = no row).
pub fn toggle_override_enabled(
    existing: Option<&HarnessOverride>,
    id: &str,
    enabled: bool,
    natural_enabled: bool,
) -> Option<HarnessOverride> {
    if enabled == natural_enabled && existing.is_none_or(|o| !o.is_material()) {
        return None;
    }
    let mut next = existing.cloned().unwrap_or(HarnessOverride {
        id: id.into(),
        enabled,
        command: None,
        args: None,
        env: None,
        probe_command: None,
        resume_command: None,
    });
    next.enabled = enabled;
    Some(next)
}

// ─── Spawn shape + resume command ───────────────────────────────────────────

/// argv (with `${workspace}` substituted) and cwd (always the workspace).
pub fn resolve_harness_spawn(
    harness: &HarnessDefinition,
    workspace_path: &str,
) -> (Vec<String>, String) {
    (
        harness
            .args
            .iter()
            .map(|a| a.replace(WORKSPACE_PLACEHOLDER, workspace_path))
            .collect(),
        workspace_path.to_string(),
    )
}

fn shell_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.,:/@%^+=-".contains(c))
}

/// One literal POSIX shell argument (bare when plainly safe).
pub fn shell_quote_arg(value: &str) -> String {
    if shell_safe(value) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// Always-quoted shell word (discovery probes).
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_quote_arg(value: &str) -> String {
    if shell_safe(value) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeShellDialect {
    Posix,
    Powershell,
}

/// Fill a harness's resume template for one session; None when it has none.
pub fn build_harness_resume_command(
    harness: &HarnessDefinition,
    session_id: &str,
    workspace_path: &str,
    dialect: ResumeShellDialect,
) -> Option<String> {
    let mut template = harness.resume_command.clone()?;
    // Strip author-supplied quotes around the placeholders.
    for placeholder in ["${sessionId}", "${workspace}"] {
        for q in ['"', '\''] {
            template = template.replace(&format!("{q}{placeholder}{q}"), placeholder);
        }
    }
    let quote: fn(&str) -> String = match dialect {
        ResumeShellDialect::Posix => shell_quote_arg,
        ResumeShellDialect::Powershell => {
            template = template.replace(" && ", "; ");
            powershell_quote_arg
        }
    };
    Some(
        template
            .replace("${sessionId}", &quote(session_id))
            .replace("${workspace}", &quote(workspace_path)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_command_quotes_values() {
        let claude = &built_in_harnesses()[0];
        assert_eq!(
            build_harness_resume_command(claude, "abc", "/my ws/$(x)", ResumeShellDialect::Posix)
                .unwrap(),
            "cd '/my ws/$(x)' && claude --resume abc"
        );
        assert_eq!(
            build_harness_resume_command(claude, "abc", "C:\\it's", ResumeShellDialect::Powershell)
                .unwrap(),
            "cd 'C:\\it''s'; claude --resume abc"
        );
        assert!(
            build_harness_resume_command(
                &built_in_harnesses()[3],
                "a",
                "/w",
                ResumeShellDialect::Posix
            )
            .is_none()
        );
    }

    #[test]
    fn overrides_and_custom_resolve() {
        let mut rows = BTreeMap::new();
        rows.insert(
            "opencode".to_string(),
            HarnessRow {
                id: "opencode".into(),
                r#override: Some(HarnessOverride {
                    id: "opencode".into(),
                    enabled: true,
                    command: Some("/x/opencode".into()),
                    args: None,
                    env: Some([("A".to_string(), "1".to_string())].into()),
                    probe_command: None,
                    resume_command: None,
                }),
                custom: None,
                install: None,
                catalog: None,
                created_at: 1,
            },
        );
        rows.insert(
            "gemini-cli".to_string(),
            HarnessRow {
                id: "gemini-cli".into(),
                r#override: None,
                custom: None,
                catalog: None,
                created_at: 2,
                install: Some(HarnessDiscoveryResult {
                    harness_id: "gemini-cli".into(),
                    found: false,
                    resolved_path: None,
                    probed_at: 0,
                }),
            },
        );
        rows.insert(
            "custom:1".to_string(),
            HarnessRow {
                id: "custom:1".into(),
                r#override: None,
                install: None,
                catalog: None,
                created_at: 3,
                custom: Some(CustomHarnessEntry {
                    id: "custom:1".into(),
                    label: "Mine".into(),
                    command: "mine".into(),
                    args: vec![],
                    env: BTreeMap::new(),
                    probe_command: None,
                    auth_hint: None,
                    resume_command: None,
                    mcp_registration_override: McpRegistration::SessionNew,
                    enabled: true,
                }),
            },
        );
        let configured = configured_harnesses(rows.values());
        assert_eq!(configured.len(), 5);
        let oc = configured.iter().find(|h| h.id == "opencode").unwrap();
        assert_eq!(oc.command, "/x/opencode");
        assert_eq!(oc.args, vec!["acp", "--cwd", "${workspace}"]);
        let pickable = pickable_harnesses(rows.values());
        assert!(pickable.iter().all(|h| h.id != "gemini-cli"));
        let settings = harness_settings_rows(&rows);
        let gemini = settings
            .iter()
            .find(|r| r.definition.id == "gemini-cli")
            .unwrap();
        assert!(!gemini.enabled);
        assert_eq!(gemini.availability, Availability::Missing);
        assert_eq!(
            settings
                .iter()
                .find(|r| r.definition.id == "opencode")
                .unwrap()
                .origin,
            HarnessOrigin::Overridden
        );
    }

    #[test]
    fn spawn_substitutes_workspace() {
        let (args, cwd) = resolve_harness_spawn(&built_in_harnesses()[1], "/w");
        assert_eq!(args, vec!["acp", "--cwd", "/w"]);
        assert_eq!(cwd, "/w");
    }
}
