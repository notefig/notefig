//! The app's status, shown outside its window: on macOS, a menu-bar item.
//!
//! The frontend owns the model — what to list, how each row is marked, what
//! picking a row does — and publishes it through `publish_app_status`
//! whenever it changes (`ui.publishAppStatus` in the platform adapter).
//! This module only draws: a template icon (with a dot beside it when
//! anything needs the user), a native menu of the sections as disabled
//! headers over marked rows, then the actions, then Quit. Rows and actions
//! carry ids, never behaviour; picking one brings the window forward and
//! emits the id back (`app-status-activated`) for the frontend to act on.
//!
//! The app opts in with `register` (main.rs); the command is registered
//! everywhere the handlers are, but draws nothing where nobody did — the
//! e2e shim's mock app has no menu bar to draw in. The item is created on
//! the first publish rather than at setup, so it only ever exists for a
//! frontend that can answer it — never for the MCP relay invocation of this
//! binary, never before the webview is up. Everything AppKit touches runs
//! on the main thread.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

/// Wire shape of `ui.publishAppStatus`, callbacks replaced by ids.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    /// The most pressing unseen mark, or nothing to point at.
    pub attention: Option<String>,
    pub sections: Vec<AppStatusSection>,
    pub actions: Vec<AppStatusAction>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppStatusSection {
    pub id: String,
    pub title: String,
    pub entries: Vec<AppStatusEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppStatusEntry {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    /// A `StatusMark` (platform-adapter.interface.ts); unknown marks draw plain.
    pub mark: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppStatusAction {
    pub id: String,
    pub label: String,
}

/// Emitted with the activated entry's or action's id.
pub const ACTIVATED_EVENT: &str = "app-status-activated";
/// Keeps the frontend's ids clear of the app menu's own ("quit", "zoom_100").
const ITEM_ID_PREFIX: &str = "app-status:";

/// The menu item id for a frontend id.
pub fn item_id(id: &str) -> String {
    format!("{ITEM_ID_PREFIX}{id}")
}

/// The frontend id behind a menu item, if the item is one of ours.
pub fn activated_id(menu_item_id: &str) -> Option<&str> {
    menu_item_id.strip_prefix(ITEM_ID_PREFIX)
}

/// A row's text: the label, then its note the way a sidebar row trails it.
pub fn entry_text(entry: &AppStatusEntry) -> String {
    match entry.detail.as_deref().filter(|detail| !detail.is_empty()) {
        Some(detail) => format!("{}  ·  {detail}", entry.label),
        None => entry.label.clone(),
    }
}

/// Redraws the menu-bar item. Where there is no menu bar, nothing happens.
#[tauri::command]
pub fn publish_app_status<R: Runtime>(app: AppHandle<R>, status: AppStatus) -> Result<(), String> {
    show(app, status).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn show<R: Runtime>(app: AppHandle<R>, status: AppStatus) -> tauri::Result<()> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = tray::present(&handle, &status) {
            eprintln!("app status: {e}");
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn show<R: Runtime>(_app: AppHandle<R>, _status: AppStatus) -> tauri::Result<()> {
    Ok(())
}

/// The app's opt-in: gives the builder the item's state. Without it,
/// `publish_app_status` accepts and ignores. A no-op without a menu bar.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    let builder = builder.manage(tray::AppStatusTray::<R>::default());
    builder
}

#[cfg(target_os = "macos")]
mod tray {
    use super::{activated_id, entry_text, item_id, AppStatus, AppStatusEntry, ACTIVATED_EVENT};
    use std::sync::Mutex;
    use tauri::image::Image;
    use tauri::menu::{IconMenuItem, Menu, MenuEvent, MenuItem, NativeIcon, PredefinedMenuItem};
    use tauri::tray::{TrayIcon, TrayIconBuilder};
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    const LOGO: Image<'static> = tauri::include_image!("icons/tray/logo.png");
    const LOGO_ATTENTION: Image<'static> = tauri::include_image!("icons/tray/logo-attention.png");

    /// The one menu-bar item, once the first publish has created it.
    pub struct AppStatusTray<R: Runtime>(Mutex<Option<TrayIcon<R>>>);

    impl<R: Runtime> Default for AppStatusTray<R> {
        fn default() -> Self {
            Self(Mutex::new(None))
        }
    }

    /// The system's own status dots, so a mark reads as it does everywhere
    /// else on the Mac: green for something new, amber for waiting or
    /// asking, red for failed, grey for settled. Mirrors the sidebar's
    /// glyph table (status-glyph.tsx) in the menu's own idiom.
    pub fn native_icon(mark: Option<&str>) -> Option<NativeIcon> {
        Some(match mark? {
            "attention-bau" => NativeIcon::StatusAvailable,
            "attention-error" | "queued" => NativeIcon::StatusPartiallyAvailable,
            "error" | "unavailable" | "auth" => NativeIcon::StatusUnavailable,
            "running" | "starting" => NativeIcon::Refresh,
            "idle" | "done" | "cancelled" => NativeIcon::StatusNone,
            _ => return None,
        })
    }

    fn entry_item<R: Runtime>(app: &AppHandle<R>, entry: &AppStatusEntry) -> tauri::Result<IconMenuItem<R>> {
        IconMenuItem::with_id_and_native_icon(
            app,
            item_id(&entry.id),
            entry_text(entry),
            true,
            native_icon(entry.mark.as_deref()),
            None::<&str>,
        )
    }

    fn build_menu<R: Runtime>(app: &AppHandle<R>, status: &AppStatus) -> tauri::Result<Menu<R>> {
        let menu = Menu::new(app)?;
        for section in &status.sections {
            menu.append(&MenuItem::new(app, &section.title, false, None::<&str>)?)?;
            for entry in &section.entries {
                menu.append(&entry_item(app, entry)?)?;
            }
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        for action in &status.actions {
            menu.append(&MenuItem::with_id(app, item_id(&action.id), &action.label, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&PredefinedMenuItem::quit(app, None)?)?;
        Ok(menu)
    }

    /// Picking anything brings the app forward — the user is coming back to
    /// it — then the frontend does what the id means.
    fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
        let Some(id) = activated_id(event.id().as_ref()) else {
            return;
        };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app.emit(ACTIVATED_EVENT, id);
    }

    pub fn present<R: Runtime>(app: &AppHandle<R>, status: &AppStatus) -> tauri::Result<()> {
        let Some(state) = app.try_state::<AppStatusTray<R>>() else {
            return Ok(());
        };
        let menu = build_menu(app, status)?;
        let icon = if status.attention.is_some() { LOGO_ATTENTION } else { LOGO };
        let mut slot = state.0.lock().unwrap();
        match slot.as_ref() {
            Some(tray) => {
                tray.set_menu(Some(menu))?;
                tray.set_icon(Some(icon))?;
            }
            None => {
                let tray = TrayIconBuilder::with_id("app-status")
                    .icon(icon)
                    .icon_as_template(true)
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(on_menu_event)
                    .build(app)?;
                *slot = Some(tray);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, detail: Option<&str>) -> AppStatusEntry {
        AppStatusEntry {
            id: "prompts:t1".into(),
            label: label.into(),
            detail: detail.map(String::from),
            mark: None,
        }
    }

    #[test]
    fn a_row_trails_its_note_like_the_sidebar() {
        assert_eq!(entry_text(&entry("Fix the tests", Some("queued"))), "Fix the tests  ·  queued");
        assert_eq!(entry_text(&entry("Fix the tests", Some(""))), "Fix the tests");
        assert_eq!(entry_text(&entry("Fix the tests", None)), "Fix the tests");
    }

    #[test]
    fn only_our_items_map_back_to_a_frontend_id() {
        assert_eq!(activated_id(&item_id("sessions:task_a")), Some("sessions:task_a"));
        assert_eq!(activated_id("quit"), None);
    }

    #[test]
    fn deserializes_the_adapter_wire_shape() {
        let status: AppStatus = serde_json::from_str(
            r#"{"attention":"attention-bau","sections":[{"id":"prompts","title":"Prompts",
                "entries":[{"id":"prompts:t1","label":"Fix","detail":null,"mark":"done"}]}],
                "actions":[{"id":"settings","label":"Settings"}]}"#,
        )
        .unwrap();
        assert_eq!(status.attention.as_deref(), Some("attention-bau"));
        assert_eq!(status.sections[0].entries[0].mark.as_deref(), Some("done"));
        assert_eq!(status.actions[0].id, "settings");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn marks_draw_as_the_systems_status_dots() {
        use tauri::menu::NativeIcon;
        assert!(matches!(tray::native_icon(Some("attention-bau")), Some(NativeIcon::StatusAvailable)));
        assert!(matches!(tray::native_icon(Some("error")), Some(NativeIcon::StatusUnavailable)));
        assert!(matches!(tray::native_icon(Some("done")), Some(NativeIcon::StatusNone)));
        assert!(tray::native_icon(Some("not-a-mark")).is_none());
        assert!(tray::native_icon(None).is_none());
    }
}
