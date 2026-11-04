//! App settings: a port of `hooks/use-app-settings.ts`. The settings live
//! in the kv module's `settings` namespace under the TS keys, merged over
//! [`AppSettings::default`] (`DEFAULT_APP_SETTINGS`). No GPUI here: any
//! crate can read them through [`AppSettingsStore`].

use std::rc::Rc;

use notefig_core::{Core, Subscription};
use notefig_kv::{KvCollection, KvModule};
use notefig_telemetry::SETTINGS_NAMESPACE;
use serde_json::Value;

/// `Theme`: `"dark" | "light" | "system"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    Dark,
    Light,
    System,
}

impl ThemeChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            ThemeChoice::Dark => "dark",
            ThemeChoice::Light => "light",
            ThemeChoice::System => "system",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "dark" => ThemeChoice::Dark,
            "light" => ThemeChoice::Light,
            "system" => ThemeChoice::System,
            _ => return None,
        })
    }
}

/// `AppSettings`.
#[derive(Debug, Clone, PartialEq)]
pub struct AppSettings {
    pub theme: ThemeChoice,
    pub zoom_level: f64,
    pub crash_reporting_enabled: bool,
    pub analytics_enabled: bool,
    pub auto_update_enabled: bool,
    /// Entering a project with nothing open lands in a scratchpad.
    pub scratchpad_on_startup: bool,
    /// Push-to-talk dictation.
    pub dictation_enabled: bool,
    pub telemetry_consent_version: u32,
    pub telemetry_install_id: Option<String>,
    /// The version the user last ran (release notes once after an update).
    pub last_seen_version: Option<String>,
}

impl Default for AppSettings {
    /// `DEFAULT_APP_SETTINGS`.
    fn default() -> Self {
        Self {
            theme: ThemeChoice::Dark,
            zoom_level: 1.,
            crash_reporting_enabled: true,
            analytics_enabled: true,
            auto_update_enabled: true,
            scratchpad_on_startup: true,
            dictation_enabled: true,
            telemetry_consent_version: 0,
            telemetry_install_id: None,
            last_seen_version: None,
        }
    }
}

/// The kv keys, as in TS.
pub mod keys {
    pub const THEME: &str = "theme";
    pub const ZOOM_LEVEL: &str = "zoomLevel";
    pub const CRASH_REPORTING_ENABLED: &str = "crashReportingEnabled";
    pub const ANALYTICS_ENABLED: &str = "analyticsEnabled";
    pub const AUTO_UPDATE_ENABLED: &str = "autoUpdateEnabled";
    pub const SCRATCHPAD_ON_STARTUP: &str = "scratchpadOnStartup";
    pub const DICTATION_ENABLED: &str = "dictationEnabled";
    pub const TELEMETRY_CONSENT_VERSION: &str = "telemetryConsentVersion";
    pub const TELEMETRY_INSTALL_ID: &str = "telemetryInstallId";
    pub const LAST_SEEN_VERSION: &str = "lastSeenVersion";
}

impl AppSettings {
    /// `mergeWithDefaults`: a stored value wins unless null.
    pub fn merge(get: impl Fn(&str) -> Option<Value>) -> Self {
        let mut s = Self::default();
        let b = |k: &str, d: bool| get(k).and_then(|v| v.as_bool()).unwrap_or(d);
        if let Some(theme) = get(keys::THEME).and_then(|v| v.as_str().and_then(ThemeChoice::parse)) {
            s.theme = theme;
        }
        s.zoom_level = get(keys::ZOOM_LEVEL).and_then(|v| v.as_f64()).unwrap_or(s.zoom_level);
        s.crash_reporting_enabled = b(keys::CRASH_REPORTING_ENABLED, s.crash_reporting_enabled);
        s.analytics_enabled = b(keys::ANALYTICS_ENABLED, s.analytics_enabled);
        s.auto_update_enabled = b(keys::AUTO_UPDATE_ENABLED, s.auto_update_enabled);
        s.scratchpad_on_startup = b(keys::SCRATCHPAD_ON_STARTUP, s.scratchpad_on_startup);
        s.dictation_enabled = b(keys::DICTATION_ENABLED, s.dictation_enabled);
        s.telemetry_consent_version =
            get(keys::TELEMETRY_CONSENT_VERSION).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        s.telemetry_install_id = get(keys::TELEMETRY_INSTALL_ID).and_then(|v| v.as_str().map(String::from));
        s.last_seen_version = get(keys::LAST_SEEN_VERSION).and_then(|v| v.as_str().map(String::from));
        s
    }
}

/// `useAppSettings()` without React: the settings now, a subscription, and
/// `set_setting`. Built over the kv module.
#[derive(Clone)]
pub struct AppSettingsStore {
    kv: Rc<notefig_kv::KvApi>,
    rows: KvCollection,
}

impl AppSettingsStore {
    /// `None` when the root did not register the kv module.
    pub fn from_core(core: &Core) -> Option<Self> {
        let kv = core.try_use::<KvModule>()?;
        let rows = kv.collection(SETTINGS_NAMESPACE);
        let preload = rows.preload();
        core.executor().spawn(preload);
        Some(Self { kv, rows })
    }

    pub fn is_ready(&self) -> bool {
        self.rows.is_hydrated()
    }

    pub fn settings(&self) -> AppSettings {
        AppSettings::merge(|k| self.rows.get(k).filter(|v| !v.is_null()))
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.rows.subscribe(listener)
    }

    /// `setSetting(key, value)`: written through; logs a failure.
    pub fn set(&self, executor: &Rc<dyn notefig_core::Executor>, key: &str, value: Value) {
        let write = self.kv.write(SETTINGS_NAMESPACE, key, &value);
        let key = key.to_string();
        executor.spawn(Box::pin(async move {
            if let Err(err) = write.await {
                log::error!("settings: writing {key} failed: {err:#}");
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_stored_values_over_the_defaults() {
        let s = AppSettings::merge(|k| match k {
            "theme" => Some(json!("light")),
            "dictationEnabled" => Some(json!(false)),
            "telemetryInstallId" => Some(json!("abc")),
            _ => None,
        });
        assert_eq!(s.theme, ThemeChoice::Light);
        assert!(!s.dictation_enabled);
        assert!(s.scratchpad_on_startup);
        assert_eq!(s.telemetry_install_id.as_deref(), Some("abc"));
        assert_eq!(AppSettings::merge(|_| None), AppSettings::default());
    }
}
