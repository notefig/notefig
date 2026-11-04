//! Pure state/validation helpers for the harness settings section — a port
//! of `components/agent/harness-settings-form.ts` (no views).
//!
//! The form shows the EFFECTIVE definition's real values (built-in defaults
//! merged with any override); inherit-vs-override is a diff on save
//! ([`form_to_override`]), so untouched fields keep inheriting and future
//! built-in default changes flow through.

use std::collections::BTreeMap;

use notefig_agent::harness::{
    CustomHarnessEntry, HarnessDefinition, HarnessOverride, McpRegistration, built_in_harnesses,
};

/// `HarnessFormState`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HarnessFormState {
    /// Custom entries only; ignored for built-in overrides.
    pub label: String,
    pub command: String,
    /// Textarea raw text, one argument per line.
    pub args_text: String,
    /// Textarea raw text, KEY=VALUE per line.
    pub env_text: String,
    pub probe_command: String,
    /// Terminal resume template (`${sessionId}`/`${workspace}`); empty =
    /// none (or inherit, for built-in overrides).
    pub resume_command: String,
    /// Custom entries only: the warned MCP opt-in (`none` | `session-new`).
    pub mcp_opt_in: McpOptIn,
}

/// `HarnessFormState["mcpOptIn"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum McpOptIn {
    #[default]
    None,
    SessionNew,
}

impl McpOptIn {
    fn registration(self) -> McpRegistration {
        match self {
            McpOptIn::None => McpRegistration::None,
            McpOptIn::SessionNew => McpRegistration::SessionNew,
        }
    }
}

/// `EnvLineError["kind"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvErrorKind {
    NoEquals,
    BadKey,
    Duplicate,
}

impl EnvErrorKind {
    /// `ENV_ERROR_MESSAGE_KEY`.
    pub fn message_key(self) -> &'static str {
        match self {
            EnvErrorKind::NoEquals => "harnessEnvErrorNoEquals",
            EnvErrorKind::BadKey => "harnessEnvErrorBadKey",
            EnvErrorKind::Duplicate => "harnessEnvErrorDuplicate",
        }
    }
}

/// `EnvLineError`: 1-based line numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvLineError {
    pub line: usize,
    pub kind: EnvErrorKind,
}

/// `HarnessFormErrors`. `label`/`command` are the TS `"required"`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HarnessFormErrors {
    pub label: bool,
    pub command: bool,
    pub env: Vec<EnvLineError>,
}

impl HarnessFormErrors {
    /// `Object.keys(errors).length === 0`.
    pub fn is_empty(&self) -> bool {
        !self.label && !self.command && self.env.is_empty()
    }
}

/// `ParsedHarnessForm`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHarnessForm {
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub probe_command: String,
    pub resume_command: String,
}

fn strip_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// One argv entry per non-blank line, verbatim (spaces stay in the arg).
pub fn parse_arg_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| strip_cr(line).trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`.
fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// KEY=VALUE per line, split on the FIRST `=` (values may contain `=`);
/// `KEY=` (empty value) is legal. Errors carry 1-based line numbers.
pub fn parse_env_lines(text: &str) -> (BTreeMap<String, String>, Vec<EnvLineError>) {
    let mut env = BTreeMap::new();
    let mut errors = Vec::new();
    for (index, raw) in text.split('\n').enumerate() {
        let line = strip_cr(raw).trim();
        if line.is_empty() {
            continue;
        }
        let line_no = index + 1;
        let Some(eq) = line.find('=') else {
            errors.push(EnvLineError { line: line_no, kind: EnvErrorKind::NoEquals });
            continue;
        };
        let key = line[..eq].trim();
        if !is_env_key(key) {
            errors.push(EnvLineError { line: line_no, kind: EnvErrorKind::BadKey });
            continue;
        }
        if env.contains_key(key) {
            errors.push(EnvLineError { line: line_no, kind: EnvErrorKind::Duplicate });
            continue;
        }
        env.insert(key.to_string(), line[eq + 1..].to_string());
    }
    (env, errors)
}

/// Seed the form from the effective definition — real values, not
/// placeholders (the user sees exactly what would spawn today).
pub fn definition_to_form(definition: &HarnessDefinition) -> HarnessFormState {
    HarnessFormState {
        label: definition.label.clone(),
        command: definition.command.clone(),
        args_text: definition.args.join("\n"),
        env_text: definition
            .env
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n"),
        probe_command: definition.probe_command.clone().unwrap_or_default(),
        resume_command: definition.resume_command.clone().unwrap_or_default(),
        mcp_opt_in: McpOptIn::None,
    }
}

/// `validateHarnessForm`: the errors, and the parsed values when there are none.
pub fn validate_harness_form(
    form: &HarnessFormState,
    require_label: bool,
) -> (HarnessFormErrors, Option<ParsedHarnessForm>) {
    let mut errors = HarnessFormErrors::default();
    if require_label && form.label.trim().is_empty() {
        errors.label = true;
    }
    if form.command.trim().is_empty() {
        errors.command = true;
    }
    let (env, env_errors) = parse_env_lines(&form.env_text);
    errors.env = env_errors;
    if !errors.is_empty() {
        return (errors, None);
    }
    let parsed = ParsedHarnessForm {
        label: form.label.trim().to_string(),
        command: form.command.trim().to_string(),
        args: parse_arg_lines(&form.args_text),
        env,
        probe_command: form.probe_command.trim().to_string(),
        resume_command: form.resume_command.trim().to_string(),
    };
    (errors, Some(parsed))
}

/// Diff-on-save: fields still equal to the built-in default are omitted from
/// the override, so they keep inheriting. Returns `None` — the caller
/// deletes the override row entirely — when nothing differs AND the enabled
/// state matches its natural default (found harnesses default on, not-found
/// ones off), so a fully-stock harness never keeps a lingering row that
/// would read as "customized".
pub fn form_to_override(
    parsed: &ParsedHarnessForm,
    builtin: &HarnessDefinition,
    enabled: bool,
    natural_enabled: bool,
) -> Option<HarnessOverride> {
    let mut o = HarnessOverride {
        id: builtin.id.clone(),
        enabled,
        command: None,
        args: None,
        env: None,
        probe_command: None,
        resume_command: None,
    };
    if parsed.command != builtin.command {
        o.command = Some(parsed.command.clone());
    }
    if parsed.args != builtin.args {
        o.args = Some(parsed.args.clone());
    }
    if parsed.env != builtin.env {
        o.env = Some(parsed.env.clone());
    }
    let builtin_probe = builtin.probe_command.clone().unwrap_or_default();
    if parsed.probe_command != builtin_probe && !parsed.probe_command.is_empty() {
        o.probe_command = Some(parsed.probe_command.clone());
    }
    let builtin_resume = builtin.resume_command.clone().unwrap_or_default();
    if parsed.resume_command != builtin_resume && !parsed.resume_command.is_empty() {
        o.resume_command = Some(parsed.resume_command.clone());
    }
    if !o.is_material() && enabled == natural_enabled {
        return None;
    }
    Some(o)
}

/// `formToCustomEntry`.
pub fn form_to_custom_entry(
    parsed: &ParsedHarnessForm,
    form: &HarnessFormState,
    id: &str,
    enabled: bool,
) -> CustomHarnessEntry {
    CustomHarnessEntry {
        id: id.to_string(),
        label: parsed.label.clone(),
        command: parsed.command.clone(),
        args: parsed.args.clone(),
        env: parsed.env.clone(),
        probe_command: (!parsed.probe_command.is_empty()).then(|| parsed.probe_command.clone()),
        auth_hint: None,
        resume_command: (!parsed.resume_command.is_empty()).then(|| parsed.resume_command.clone()),
        mcp_registration_override: form.mcp_opt_in.registration(),
        enabled,
    }
}

/// `custom:<uuid v4>`. Deviation: no `uuid` dependency (disk is tight); the
/// v4 layout is filled from the std hasher's per-process random keys.
pub fn new_custom_harness_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let word = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        h.finish()
    };
    let (a, b) = (word(), word());
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_le_bytes());
    bytes[8..].copy_from_slice(&b.to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "custom:{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub fn is_built_in_harness(id: &str) -> bool {
    built_in_harnesses().iter().any(|h| h.id == id)
}

pub fn built_in_harness(id: &str) -> Option<HarnessDefinition> {
    built_in_harnesses().into_iter().find(|h| h.id == id)
}

#[cfg(test)]
mod tests {
    //! `__tests__/harness-settings-form.test.ts`.
    use super::*;

    fn opencode() -> HarnessDefinition {
        built_in_harness("opencode").unwrap()
    }
    fn claude() -> HarnessDefinition {
        built_in_harness("claude-code").unwrap()
    }

    fn form() -> HarnessFormState {
        HarnessFormState::default()
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn parse_arg_lines_one_per_line_trims_cr_drops_blanks_keeps_inner_spaces() {
        assert_eq!(
            parse_arg_lines("acp\r\n\n  --cwd ${workspace}  \n"),
            vec!["acp".to_string(), "--cwd ${workspace}".to_string()]
        );
    }

    #[test]
    fn parse_env_splits_on_first_equals_and_allows_empty_values() {
        let (e, errors) = parse_env_lines("A=x=y\nB=\nC=plain");
        assert!(errors.is_empty());
        assert_eq!(e, env(&[("A", "x=y"), ("B", ""), ("C", "plain")]));
    }

    #[test]
    fn parse_env_reports_line_errors() {
        let (_, errors) = parse_env_lines("GOOD=1\nnoequals\n2BAD=x\nBAD KEY=x\nGOOD=again");
        assert_eq!(
            errors,
            vec![
                EnvLineError { line: 2, kind: EnvErrorKind::NoEquals },
                EnvLineError { line: 3, kind: EnvErrorKind::BadKey },
                EnvLineError { line: 4, kind: EnvErrorKind::BadKey },
                EnvLineError { line: 5, kind: EnvErrorKind::Duplicate },
            ]
        );
    }

    #[test]
    fn parse_env_ignores_blank_lines() {
        assert!(parse_env_lines("\n\nA=1\n\n").1.is_empty());
    }

    #[test]
    fn validate_requires_command_always_label_only_when_asked() {
        let empty = form();
        assert!(validate_harness_form(&empty, false).0.command);
        assert!(validate_harness_form(&empty, true).0.label);
        assert!(!validate_harness_form(&empty, false).0.label);
    }

    #[test]
    fn valid_form_yields_parsed_values() {
        let f = HarnessFormState {
            command: " ocv ".into(),
            args_text: "acp".into(),
            env_text: "K=v".into(),
            ..form()
        };
        let (errors, parsed) = validate_harness_form(&f, false);
        assert!(errors.is_empty());
        assert_eq!(
            parsed,
            Some(ParsedHarnessForm {
                label: String::new(),
                command: "ocv".into(),
                args: vec!["acp".into()],
                env: env(&[("K", "v")]),
                probe_command: String::new(),
                resume_command: String::new(),
            })
        );
    }

    #[test]
    fn env_errors_block_parsing() {
        let f = HarnessFormState { command: "x".into(), env_text: "bad line".into(), ..form() };
        let (errors, parsed) = validate_harness_form(&f, false);
        assert!(parsed.is_none());
        assert_eq!(errors.env.len(), 1);
    }

    fn save_untouched(def: &HarnessDefinition) -> Option<HarnessOverride> {
        let seeded = definition_to_form(def);
        let (_, parsed) = validate_harness_form(&seeded, false);
        form_to_override(&parsed.unwrap(), def, true, true)
    }

    fn parsed_with(def: &HarnessDefinition, edit: impl FnOnce(&mut HarnessFormState)) -> ParsedHarnessForm {
        let mut seeded = definition_to_form(def);
        edit(&mut seeded);
        validate_harness_form(&seeded, false).1.unwrap()
    }

    fn bare(id: &str, enabled: bool) -> HarnessOverride {
        HarnessOverride {
            id: id.into(),
            enabled,
            command: None,
            args: None,
            env: None,
            probe_command: None,
            resume_command: None,
        }
    }

    #[test]
    fn seeding_from_a_builtin_and_saving_untouched_produces_no_override() {
        assert_eq!(save_untouched(&opencode()), None);
        assert_eq!(save_untouched(&claude()), None);
    }

    #[test]
    fn editing_only_the_command_overrides_only_command() {
        let p = parsed_with(&opencode(), |f| f.command = "ocv".into());
        assert_eq!(
            form_to_override(&p, &opencode(), true, true),
            Some(HarnessOverride { command: Some("ocv".into()), ..bare("opencode", true) })
        );
    }

    #[test]
    fn editing_a_field_back_to_default_drops_it() {
        let p = parsed_with(&opencode(), |f| f.command = opencode().command);
        assert_eq!(form_to_override(&p, &opencode(), true, true), None);
    }

    #[test]
    fn a_disable_departing_from_natural_state_keeps_a_row() {
        let p = parsed_with(&opencode(), |_| {});
        assert_eq!(form_to_override(&p, &opencode(), false, true), Some(bare("opencode", false)));
    }

    #[test]
    fn enabled_matching_natural_default_leaves_no_row() {
        let p = parsed_with(&opencode(), |_| {});
        assert_eq!(form_to_override(&p, &opencode(), false, false), None);
        assert_eq!(form_to_override(&p, &opencode(), true, false), Some(bare("opencode", true)));
    }

    #[test]
    fn emptied_probe_means_inherit() {
        let p = parsed_with(&claude(), |f| f.probe_command.clear());
        assert_eq!(form_to_override(&p, &claude(), true, true), None);
    }

    #[test]
    fn editing_only_resume_is_material() {
        let seeded = definition_to_form(&claude());
        assert_eq!(Some(seeded.resume_command.clone()), claude().resume_command);
        let p = parsed_with(&claude(), |f| f.resume_command = "claude -r ${sessionId}".into());
        assert_eq!(
            form_to_override(&p, &claude(), true, true),
            Some(HarnessOverride {
                resume_command: Some("claude -r ${sessionId}".into()),
                ..bare("claude-code", true)
            })
        );
    }

    #[test]
    fn emptied_resume_means_inherit() {
        let p = parsed_with(&claude(), |f| f.resume_command.clear());
        assert_eq!(form_to_override(&p, &claude(), true, true), None);
    }

    #[test]
    fn custom_entry_with_mcp_opt_in_and_generated_id() {
        let f = HarnessFormState {
            label: "Mine".into(),
            command: "my-bin".into(),
            args_text: "serve".into(),
            mcp_opt_in: McpOptIn::SessionNew,
            ..form()
        };
        let parsed = validate_harness_form(&f, true).1.unwrap();
        let id = new_custom_harness_id();
        let uuid = id.strip_prefix("custom:").unwrap();
        assert_eq!(uuid.len(), 36);
        assert!(uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert_eq!(
            form_to_custom_entry(&parsed, &f, &id, true),
            CustomHarnessEntry {
                id: id.clone(),
                label: "Mine".into(),
                command: "my-bin".into(),
                args: vec!["serve".into()],
                env: BTreeMap::new(),
                probe_command: None,
                auth_hint: None,
                resume_command: None,
                mcp_registration_override: McpRegistration::SessionNew,
                enabled: true,
            }
        );
        assert_ne!(new_custom_harness_id(), id);
    }

    #[test]
    fn custom_entry_carries_resume_when_set_omits_when_blank() {
        let f = HarnessFormState {
            label: "Mine".into(),
            command: "my-bin".into(),
            resume_command: "my-bin --resume ${sessionId}".into(),
            ..form()
        };
        let parsed = validate_harness_form(&f, true).1.unwrap();
        assert_eq!(
            form_to_custom_entry(&parsed, &f, "custom:x", true).resume_command.as_deref(),
            Some("my-bin --resume ${sessionId}")
        );
        let blank = HarnessFormState { label: "Mine".into(), command: "my-bin".into(), ..form() };
        let parsed = validate_harness_form(&blank, true).1.unwrap();
        assert_eq!(form_to_custom_entry(&parsed, &blank, "custom:x", true).resume_command, None);
    }
}
