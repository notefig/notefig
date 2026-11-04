//! `PlatformUiSurface`: dialogs and OS integration a module may ask for.

use futures::future::LocalBoxFuture;
use notefig_core::Subscription;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default)]
pub struct TextPromptOptions {
    pub title: String,
    pub message: Option<String>,
    pub default_value: Option<String>,
    pub placeholder: Option<String>,
    pub confirm_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlatformEvent {
    /// "light" | "dark"
    ThemeChanged(String),
    FolderSelected(String),
    FileDropped(Vec<String>),
    ZoomChanged(f32),
}

/// What picking an entry or action does — the app owns the behaviour, not
/// the platform. Compares equal to any other: a republish whose only
/// change is a callback draws the same.
#[derive(Clone, Default)]
pub struct AppStatusActivate(pub Option<std::rc::Rc<dyn Fn()>>);

impl AppStatusActivate {
    pub fn new(f: impl Fn() + 'static) -> Self {
        Self(Some(std::rc::Rc::new(f)))
    }

    pub fn call(&self) {
        if let Some(f) = &self.0 {
            f();
        }
    }
}

impl std::fmt::Debug for AppStatusActivate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "activate" } else { "none" })
    }
}

impl PartialEq for AppStatusActivate {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

/// One thing the user can jump to from outside the window (`AppStatusEntry`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AppStatusEntry {
    /// Unique across the whole status; the platform hands it back.
    pub id: String,
    pub label: String,
    /// A short trailing note: the turn's state, a project name.
    pub detail: Option<String>,
    /// A `StatusMark` or `"document"`; unknown ones draw plain.
    pub mark: Option<String>,
    #[serde(skip)]
    pub activate: AppStatusActivate,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AppStatusSection {
    pub id: String,
    pub title: String,
    pub entries: Vec<AppStatusEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AppStatusAction {
    pub id: String,
    pub label: String,
    #[serde(skip)]
    pub activate: AppStatusActivate,
}

/// What the app would tell a glance from outside its window
/// (`publishAppStatus`): whether anything needs the user, the few things
/// they were last working with, and the general ways in. A desktop shows
/// it as a menu-bar item; a platform with nowhere to show it ignores it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AppStatus {
    /// The most pressing unseen mark, or nothing to point at.
    pub attention: Option<String>,
    pub sections: Vec<AppStatusSection>,
    pub actions: Vec<AppStatusAction>,
}

impl AppStatus {
    /// Run what `id` means; false for an id this status doesn't have.
    pub fn activate(&self, id: &str) -> bool {
        let entry = self.sections.iter().flat_map(|s| &s.entries).find(|e| e.id == id).map(|e| &e.activate);
        let action = || self.actions.iter().find(|a| a.id == id).map(|a| &a.activate);
        match entry.or_else(action) {
            Some(activate) => {
                activate.call();
                true
            }
            None => false,
        }
    }
}

pub trait PlatformUi {
    fn pick_directory(&self, title: &str) -> LocalBoxFuture<'static, Option<String>>;
    fn prompt_text(&self, options: TextPromptOptions) -> LocalBoxFuture<'static, Option<String>>;
    fn open_external(&self, url: &str);
    fn reveal_in_file_manager(&self, path: &str);
    fn toggle_fullscreen(&self);
    fn publish_app_status(&self, status: AppStatus);
    fn subscribe(&self, listener: Box<dyn Fn(&PlatformEvent)>) -> Subscription;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[test]
    fn app_status_activates_by_id_and_compares_without_callbacks() {
        let hits = Rc::new(Cell::new(0));
        let h = hits.clone();
        let status = AppStatus {
            attention: None,
            sections: vec![AppStatusSection {
                id: "s".into(),
                title: "S".into(),
                entries: vec![AppStatusEntry {
                    id: "s:1".into(),
                    label: "one".into(),
                    activate: AppStatusActivate::new(move || h.set(h.get() + 1)),
                    ..Default::default()
                }],
            }],
            actions: vec![AppStatusAction { id: "settings".into(), label: "Settings".into(), ..Default::default() }],
        };
        assert!(status.activate("s:1"));
        assert!(status.activate("settings"));
        assert!(!status.activate("gone"));
        assert_eq!(hits.get(), 1);
        let mut other = status.clone();
        other.sections[0].entries[0].activate = AppStatusActivate::default();
        assert_eq!(status, other);
        assert!(serde_json::to_string(&status).unwrap().contains("\"s:1\""));
    }
}
