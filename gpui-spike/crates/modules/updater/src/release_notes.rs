//! `utils/release-notes.ts` and `hooks/use-release-notes-on-update.ts`.
//!
//! Diverges where Vite did the work: the TS bundle got only the current
//! version's file as `__LATEST_RELEASE_NOTES__`; here `build.rs` embeds
//! `release-notes/v<CARGO_PKG_VERSION>.md` from this crate if there is one,
//! else nothing.

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_kv::KvApi;

/// `__APP_VERSION__`.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `RELEASE_NOTES_TAB_ID` (`modules/tabs/tab-id.ts`).
pub const RELEASE_NOTES_TAB_ID: &str = "release:";

const BUNDLED: &str = include_str!(concat!(env!("OUT_DIR"), "/latest_release_notes.md"));

/// The current version's notes, split the ways surfaces show them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseNotes {
    /// `latestReleaseTitle`: the document's own `# ` title, or
    /// "Release Notes v<version>"; `None` with no notes.
    pub title: Option<String>,
    /// `latestReleaseMarkdown`: "" with no notes.
    pub markdown: String,
    /// `latestReleaseBody`: the notes without their title line.
    pub body: String,
}

fn heading(raw: &str) -> Option<&str> {
    raw.lines().find_map(|line| {
        let rest = line.strip_prefix('#')?;
        let rest = rest.strip_prefix([' ', '\t'])?;
        let rest = rest.trim_start_matches([' ', '\t']);
        (!rest.is_empty()).then_some(rest)
    })
}

/// The notes in `raw` for `version`.
pub fn release_notes(raw: &str, version: &str) -> ReleaseNotes {
    let raw = raw.trim();
    if raw.is_empty() {
        return ReleaseNotes { title: None, markdown: String::new(), body: String::new() };
    }
    let (title, markdown) = match heading(raw) {
        Some(h) => (h.trim().to_string(), raw.to_string()),
        None => (format!("Release Notes v{version}"), format!("# Release Notes v{version}\n\n{raw}")),
    };
    // `.replace(/^#\s+.+$/m, "")`: the first heading line goes.
    let mut removed = false;
    let body: Vec<&str> = markdown
        .lines()
        .filter(|line| {
            if !removed && heading(line).is_some() {
                removed = true;
                return false;
            }
            true
        })
        .collect();
    let body = body.join("\n").trim().to_string();
    ReleaseNotes { title: Some(title), markdown, body }
}

/// The notes bundled with this build.
pub fn latest_release_notes() -> ReleaseNotes {
    release_notes(BUNDLED, APP_VERSION)
}

/// `SETTINGS_NAMESPACE` (`hooks/use-app-settings.ts`).
pub const SETTINGS_NAMESPACE: &str = "settings";
pub const LAST_SEEN_VERSION_KEY: &str = "lastSeenVersion";

/// `useReleaseNotesOnUpdate`: resolves true when the release-notes tab
/// should open — the stored `lastSeenVersion` is another version. A fresh
/// install (none stored) only records the version. Records it either way,
/// so the tab is offered once per version.
pub fn release_notes_due(kv: &KvApi, version: &str) -> LocalBoxFuture<'static, bool> {
    let last = kv.read::<Option<String>>(SETTINGS_NAMESPACE, LAST_SEEN_VERSION_KEY);
    // Lazy: it runs only once the read below has finished.
    let record = kv.write(SETTINGS_NAMESPACE, LAST_SEEN_VERSION_KEY, &version);
    let version = version.to_string();
    async move {
        let last = last.await.flatten();
        if last.as_deref() == Some(version.as_str()) {
            return false;
        }
        if let Err(err) = record.await {
            log::error!("updater: recording lastSeenVersion failed: {err:#}");
        }
        last.is_some()
    }
    .boxed_local()
}
