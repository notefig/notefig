//! The debug report: what the debug panel shows and copies, and what
//! feedback can attach. A port of `hooks/use-debug-snapshot.ts`
//! ([`debug_snapshot`]) and `utils/debug-report.ts` ([`format_debug_report`]).
//!
//! Deviations: the URL is the `url` service's (`pathname` + `search`),
//! not `window.location`; "User Agent" becomes the platform and version;
//! the git status cache is `core.workspace(ws).get::<GitModule>()`'s rows
//! as they stand (read, never subscribed, so the report never starts a
//! fetch, as TS reads the query cache); the report takes no crash error
//! (no error boundary renders the panel here).

use gpui::App;
use notefig_git::{GitModule, GitRow, WorkspaceGit};
use notefig_layout::{LayoutModule, LayoutNode, SearchParams};
use notefig_ui::CoreExt as _;
use serde_json::{Value, json};

/// `DebugSnapshot["git"]`: the focused workspace's git status cache.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitCache {
    /// `GitRow[]` as TS's JSON shows it; `None` before the first fetch.
    pub rows: Option<Value>,
    pub error: Option<String>,
    /// Epoch ms the rows landed.
    pub updated_at: Option<i64>,
}

/// `DebugSnapshot`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DebugSnapshot {
    /// `pathname + search`.
    pub raw_url: String,
    /// The focused workspace (the sidebar's scope).
    pub base_path: Option<String>,
    /// The URL's params.
    pub search_params: SearchParams,
    pub layout: Vec<LayoutNode>,
    pub open_tabs: Vec<String>,
    pub active_tab_id: Option<String>,
    pub git: GitCache,
}

/// One captured console line (`DebugConsoleEntry`).
pub struct ReportConsoleEntry<'a> {
    pub level: &'a str,
    /// Seconds since the Unix epoch.
    pub timestamp: u64,
    pub message: &'a str,
}

/// `useDebugSnapshot`, read now.
pub fn debug_snapshot(cx: &App) -> DebugSnapshot {
    let core = cx.core();
    let layout = core.try_use::<LayoutModule>();
    let url = layout.as_ref().map(|l| l.url().clone());
    let raw_url = url.as_ref().map(|u| format!("{}{}", u.pathname(), u.search())).unwrap_or_default();
    let search_params = url.as_ref().map(|u| SearchParams::parse(&u.search())).unwrap_or_default();
    let base_path = core.try_use::<notefig_workspaces::WorkspacesModule>().and_then(|w| w.focused());
    let (layout, open_tabs, active_tab_id) = match layout {
        Some(layout) => (layout.read().as_ref().clone(), layout.open_tab_ids(), layout.selected_tab_id()),
        None => Default::default(),
    };
    let git = base_path
        .as_deref()
        .filter(|ws| core.workspaces().is_open(ws))
        .and_then(|ws| core.workspace(ws).get::<GitModule>().ok())
        .map(|git| git_cache(&git))
        .unwrap_or_default();
    DebugSnapshot { raw_url, base_path, search_params, layout, open_tabs, active_tab_id, git }
}

/// `gitStatusCache`: the rows, the fetch's error (else the repo row's
/// status error) and when they landed.
fn git_cache(git: &WorkspaceGit) -> GitCache {
    let rows = git.rows();
    let status_error = rows.as_ref().and_then(|rows| {
        rows.iter().find_map(|r| match r {
            GitRow::Repo(repo) => repo.status_error.as_ref().map(|e| e.message.clone()),
            _ => None,
        })
    });
    GitCache {
        rows: rows.map(|rows| git_rows_json(&rows)),
        error: git.access_error().map(|e| e.message).or(status_error),
        updated_at: git.updated_at(),
    }
}

/// `GitRow[]` in TS's JSON shape.
pub fn git_rows_json(rows: &[GitRow]) -> Value {
    let error = |e: Option<(String, String)>| e.map(|(code, message)| json!({ "code": code, "message": message }));
    Value::Array(
        rows.iter()
            .map(|row| {
                let mut v = match row {
                    GitRow::Repo(r) => json!({
                        "id": "repo", "kind": "repo", "branch": r.branch, "ahead": r.ahead, "behind": r.behind,
                        "initialized": r.initialized, "statusError": error(r.status_error.as_ref().map(|e| (format!("{:?}", e.code), e.message.clone()))),
                        "logError": error(r.log_error.as_ref().map(|e| (format!("{:?}", e.code), e.message.clone()))),
                    }),
                    GitRow::File(f) => json!({
                        "id": f.id, "kind": "file", "path": f.path, "staged": f.staged, "unstaged": f.unstaged,
                        "untracked": f.untracked, "conflicted": f.conflicted,
                    }),
                    GitRow::Checkpoint(c) => json!({
                        "id": c.id, "kind": "checkpoint", "oid": c.oid, "hash": c.hash, "message": c.message,
                        "timestamp": c.timestamp,
                    }),
                };
                // Optional fields are absent in TS, not null.
                if let Value::Object(map) = &mut v {
                    map.retain(|_, v| !v.is_null());
                }
                v
            })
            .collect(),
    )
}

/// The params as the panel shows them: `debug` left out, no `?`.
pub fn display_params(params: &SearchParams) -> String {
    let mut params = params.clone();
    params.delete("debug");
    params.to_query()
}

/// `decodeURIComponent`, falling back to the input on a malformed escape.
pub fn decode_uri_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok());
            match hex {
                Some(b) => {
                    out.push(b);
                    i += 3;
                    continue;
                }
                None => return s.to_string(),
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// `new Date(ms).toISOString()`.
pub fn iso_time(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60,
        ms.rem_euclid(1000)
    )
}

/// `HH:MM:SS` (UTC: no tz database here).
pub fn hh_mm_ss(secs: u64) -> String {
    let s = secs % 86_400;
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

/// `formatDebugReport`.
pub fn format_debug_report(snapshot: &DebugSnapshot, now_ms: i64, console: &[ReportConsoleEntry]) -> String {
    let raw = &snapshot.raw_url;
    let decoded = decode_uri_component(raw);
    let mut lines = vec![
        "=== Notefig Debug Report ===".to_string(),
        format!("Timestamp: {}", iso_time(now_ms)),
        format!("Platform: {} {} (notefig {})", std::env::consts::OS, std::env::consts::ARCH, env!("CARGO_PKG_VERSION")),
        String::new(),
        "── Route State ──".into(),
        format!("URL (raw): {raw}"),
    ];
    if decoded != *raw {
        lines.push(format!("URL (decoded): {decoded}"));
    }
    lines.push(format!("basePath: {}", snapshot.base_path.as_deref().unwrap_or("undefined")));
    let params = display_params(&snapshot.search_params);
    lines.push(format!("searchParams: {}", if params.is_empty() { "(none)" } else { &params }));
    lines.push(String::new());

    lines.push("── Open Tabs ──".into());
    lines.push(format!("Count: {}", snapshot.open_tabs.len()));
    lines.push(format!("Active: {}", snapshot.active_tab_id.as_deref().unwrap_or("null")));
    for tab in &snapshot.open_tabs {
        let marker = if Some(tab) == snapshot.active_tab_id.as_ref() { " (active)" } else { "" };
        lines.push(format!("  - {tab}{marker}"));
    }
    lines.push(String::new());

    if !snapshot.layout.is_empty() {
        lines.push("── Dockable Layout ──".into());
        lines.push(serde_json::to_string_pretty(&snapshot.layout).unwrap_or_default());
        lines.push(String::new());
    }

    lines.push("── Git Status Cache ──".into());
    lines.push(format!("updatedAt: {}", snapshot.git.updated_at.map(iso_time).unwrap_or_else(|| "(none)".into())));
    if let Some(error) = &snapshot.git.error {
        lines.push(format!("error: {error}"));
    }
    lines.push(git_rows_text(&snapshot.git));
    lines.push(String::new());

    if !console.is_empty() {
        lines.push(format!("── Console Output ({} entries) ──", console.len()));
        for e in console {
            lines.push(format!("[{}] [{}] {}", hh_mm_ss(e.timestamp), e.level.to_uppercase(), e.message));
        }
        lines.push(String::new());
    }
    lines.push("=== End Debug Report ===".into());
    lines.join("\n")
}

/// `JSON.stringify(git.rows, null, 2)`.
pub fn git_rows_text(git: &GitCache) -> String {
    git.rows.as_ref().map(|r| serde_json::to_string_pretty(r).unwrap_or_default()).unwrap_or_else(|| "null".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_decode_uri_component() {
        assert_eq!(decode_uri_component("/?layout=%5B%7B%22a%22%7D%5D"), "/?layout=[{\"a\"}]");
        assert_eq!(decode_uri_component("/caf%C3%A9"), "/café");
        // Malformed: the raw string, as TS's try/catch.
        assert_eq!(decode_uri_component("/%E0%A4%A"), "/%E0%A4%A");
        assert_eq!(decode_uri_component("/%FF"), "/%FF");
    }

    #[test]
    fn formats_iso_times() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_report_names_the_route_tabs_and_git_cache() {
        let snapshot = DebugSnapshot {
            raw_url: "/?layout=%5B%5D&debug=true&q=a".into(),
            base_path: Some("/ws".into()),
            search_params: SearchParams::parse("?layout=%5B%5D&debug=true&q=a"),
            layout: vec![LayoutNode::window("w1", &["/ws/a.md", "/ws/b.md"], "/ws/b.md")],
            open_tabs: vec!["/ws/a.md".into(), "/ws/b.md".into()],
            active_tab_id: Some("/ws/b.md".into()),
            git: GitCache { rows: Some(json!([{ "id": "repo", "kind": "repo" }])), error: Some("boom".into()), updated_at: Some(0) },
        };
        let report = format_debug_report(&snapshot, 0, &[ReportConsoleEntry { level: "warn", timestamp: 61, message: "careful" }]);
        for line in [
            "URL (raw): /?layout=%5B%5D&debug=true&q=a",
            "URL (decoded): /?layout=[]&debug=true&q=a",
            "basePath: /ws",
            "searchParams: layout=%5B%5D&q=a",
            "Count: 2",
            "Active: /ws/b.md",
            "  - /ws/a.md",
            "  - /ws/b.md (active)",
            "── Dockable Layout ──",
            "updatedAt: 1970-01-01T00:00:00.000Z",
            "error: boom",
            "── Console Output (1 entries) ──",
            "[00:01:01] [WARN] careful",
        ] {
            assert!(report.lines().any(|l| l == line), "missing {line:?} in\n{report}");
        }
        assert!(report.contains("\"kind\": \"repo\""));
    }

    #[test]
    fn an_empty_snapshot_reports_nothing_open() {
        let report = format_debug_report(&DebugSnapshot { raw_url: "/".into(), ..Default::default() }, 0, &[]);
        for line in ["basePath: undefined", "searchParams: (none)", "Active: null", "updatedAt: (none)", "null"] {
            assert!(report.lines().any(|l| l == line), "missing {line:?} in\n{report}");
        }
        assert!(!report.contains("Dockable Layout") && !report.contains("URL (decoded)"));
    }

    #[test]
    fn git_rows_keep_ts_field_names_and_drop_absent_options() {
        let rows = vec![
            GitRow::Repo(notefig_git::GitRepoRow {
                branch: "main".into(),
                ahead: None,
                behind: Some(1),
                initialized: true,
                status_error: None,
                log_error: None,
            }),
            GitRow::File(notefig_git::GitFileRow {
                id: "file:/ws/a.md".into(),
                path: "/ws/a.md".into(),
                staged: false,
                unstaged: true,
                untracked: false,
                conflicted: false,
            }),
        ];
        assert_eq!(
            git_rows_json(&rows),
            json!([
                { "id": "repo", "kind": "repo", "branch": "main", "behind": 1, "initialized": true },
                { "id": "file:/ws/a.md", "kind": "file", "path": "/ws/a.md", "staged": false, "unstaged": true, "untracked": false, "conflicted": false },
            ])
        );
    }
}
