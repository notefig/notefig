//! Install discovery (`harness-discovery.ts`): every probe batched into ONE
//! login-shell script between sentinels. "Couldn't check" (no shell, a
//! timeout) is `None` and must never be recorded as "not installed".

use super::config::{HarnessDiscoveryResult, shell_quote};

const SENTINEL_PREFIX: &str = "__MHD";
const SENTINEL_SUFFIX: &str = "__END__";

/// An entry to probe: its own `probe_command` wins, else `command -v <command>`.
#[derive(Debug, Clone)]
pub struct ProbeEntry {
    pub id: String,
    pub command: String,
    pub probe_command: Option<String>,
}

pub fn build_probe_script(entries: &[ProbeEntry]) -> String {
    entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let probe = e
                .probe_command
                .clone()
                .unwrap_or_else(|| format!("command -v {}", shell_quote(&e.command)));
            format!("printf '{SENTINEL_PREFIX}{i}__%s{SENTINEL_SUFFIX}' \"$({probe} 2>/dev/null)\"")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn parse_probe_output(count: usize, stdout: &str) -> Vec<(bool, Option<String>)> {
    (0..count)
        .map(|i| {
            let marker = format!("{SENTINEL_PREFIX}{i}__");
            let Some(start) = stdout.find(&marker) else {
                return (false, None);
            };
            let rest = &stdout[start + marker.len()..];
            let Some(end) = rest.find(SENTINEL_SUFFIX) else {
                return (false, None);
            };
            let path = &rest[..end];
            if path.is_empty() {
                (false, None)
            } else {
                (true, Some(path.to_string()))
            }
        })
        .collect()
}

/// Run the batch in the login shell. None = couldn't check.
pub async fn discover_harnesses(entries: &[ProbeEntry]) -> Option<Vec<HarnessDiscoveryResult>> {
    let probed_at = crate::ids::now_ms();
    if entries.is_empty() {
        return Some(vec![]);
    }
    let output = crate::process::run_shell_command(&build_probe_script(entries))
        .await
        .ok()?;
    let verdicts = parse_probe_output(entries.len(), &output.stdout);
    Some(
        entries
            .iter()
            .zip(verdicts)
            .map(|(e, (found, resolved_path))| HarnessDiscoveryResult {
                harness_id: e.id.clone(),
                found,
                resolved_path,
                probed_at,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_and_parse() {
        let entries = vec![
            ProbeEntry {
                id: "a".into(),
                command: "sh".into(),
                probe_command: None,
            },
            ProbeEntry {
                id: "b".into(),
                command: "nope".into(),
                probe_command: Some("command -v definitely-missing-xyz".into()),
            },
        ];
        let script = build_probe_script(&entries);
        assert!(script.contains("command -v 'sh'"));
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .output()
            .unwrap();
        let parsed = parse_probe_output(2, &String::from_utf8_lossy(&out.stdout));
        assert!(parsed[0].0);
        assert!(!parsed[1].0);
    }
}
