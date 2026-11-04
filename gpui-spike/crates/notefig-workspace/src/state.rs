//! App-state persistence: one JSON file under the platform data dir
//! (`~/Library/Application Support/com.notefig.gpui/state.json` on macOS).
//! `NOTEFIG_STATE_DIR` overrides the folder (tests, e2e).
//!
//! Loaded synchronously at startup, before the first window, so nothing can
//! write before it is hydrated. Writes are atomic (temp file + rename).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

pub const MAX_RECENT: usize = 20;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentWorkspace {
    pub path: PathBuf,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub last_opened_at: u64,
}

/// What a workspace remembers between runs. `layout` is opaque here: the app
/// crate owns the layout type and stores it as JSON.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSession {
    pub layout: Option<serde_json::Value>,
    /// Expanded folders in the file tree (relative paths).
    pub expanded: Vec<String>,
    pub sidebar_view: Option<String>,
    pub sidebar_width: Option<f32>,
    pub sidebar_collapsed: bool,
}

/// The main window's last bounds (logical pixels).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowBoundsState {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppStateData {
    pub version: u32,
    pub theme: ThemePreference,
    pub recent: Vec<RecentWorkspace>,
    pub last_workspace: Option<PathBuf>,
    /// Keyed by the workspace's canonical absolute path.
    pub workspaces: BTreeMap<String, WorkspaceSession>,
    pub window: Option<WindowBoundsState>,
}

impl AppStateData {
    pub fn record_open(&mut self, path: &Path) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        self.recent.retain(|r| r.path != path);
        self.recent.insert(
            0,
            RecentWorkspace {
                path: path.to_path_buf(),
                name,
                last_opened_at: now_ms(),
            },
        );
        self.recent.truncate(MAX_RECENT);
        self.last_workspace = Some(path.to_path_buf());
    }

    pub fn forget_recent(&mut self, path: &Path) {
        self.recent.retain(|r| r.path != path);
        if self.last_workspace.as_deref() == Some(path) {
            self.last_workspace = None;
        }
    }

    pub fn session(&self, root: &Path) -> WorkspaceSession {
        self.workspaces
            .get(&key(root))
            .cloned()
            .unwrap_or_default()
    }

    pub fn session_mut(&mut self, root: &Path) -> &mut WorkspaceSession {
        self.workspaces.entry(key(root)).or_default()
    }
}

fn key(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The JSON file and its in-memory copy.
pub struct StateStore {
    path: PathBuf,
    pub data: AppStateData,
}

impl StateStore {
    /// The default location (platform data dir, or `NOTEFIG_STATE_DIR`).
    pub fn default_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("NOTEFIG_STATE_DIR") {
            return Some(PathBuf::from(dir));
        }
        directories::ProjectDirs::from("com", "notefig", "gpui").map(|d| d.data_dir().to_path_buf())
    }

    pub fn load_default() -> Self {
        match Self::default_dir() {
            Some(dir) => Self::load(dir.join("state.json")),
            None => Self::in_memory(),
        }
    }

    /// Load from `path`; a missing or unreadable file gives defaults (a
    /// corrupt file is kept aside as `state.json.corrupt`).
    pub fn load(path: PathBuf) -> Self {
        let data = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(data) => data,
                Err(err) => {
                    log::warn!("state file is corrupt ({err}); starting fresh");
                    let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
                    AppStateData::default()
                }
            },
            Err(_) => AppStateData::default(),
        };
        Self { path, data }
    }

    /// A store that never touches disk.
    pub fn in_memory() -> Self {
        Self {
            path: PathBuf::new(),
            data: AppStateData::default(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&self) -> Result<()> {
        save_to(&self.path, &self.data)
    }
}

/// Write `data` to `path` atomically. Usable from a background thread with a
/// cloned snapshot.
pub fn save_to(path: &Path, data: &AppStateData) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(data)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_recent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = StateStore::load(path.clone());
        assert_eq!(store.data, AppStateData::default());
        store.data.theme = ThemePreference::Dark;
        for i in 0..25 {
            store.data.record_open(Path::new(&format!("/ws/{i}")));
        }
        store.data.record_open(Path::new("/ws/3"));
        assert_eq!(store.data.recent.len(), MAX_RECENT);
        assert_eq!(store.data.recent[0].path, Path::new("/ws/3"));
        assert_eq!(store.data.recent[0].name, "3");
        store.data.session_mut(Path::new("/ws/3")).expanded = vec!["a".into()];
        store.data.session_mut(Path::new("/ws/3")).layout = Some(serde_json::json!({"x": 1}));
        store.save().unwrap();
        let again = StateStore::load(path);
        assert_eq!(again.data, store.data);
        assert_eq!(again.data.last_workspace.as_deref(), Some(Path::new("/ws/3")));
    }

    #[test]
    fn corrupt_file_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "{not json").unwrap();
        let store = StateStore::load(path.clone());
        assert_eq!(store.data, AppStateData::default());
        assert!(dir.path().join("state.json.corrupt").exists());
    }
}
