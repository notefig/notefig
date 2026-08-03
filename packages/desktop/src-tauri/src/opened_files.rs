//! OS "open with" integration: files handed to the app by the operating
//! system (file associations, `open -a`, double-click) flow through here as
//! `file-selected` events.
//!
//! Delivery is emit-only. While the app is running (single-instance argv
//! forward, macOS RunEvent::Opened) the frontend listener is up and this is
//! verified to work. On a true cold start (app launched BY opening a file)
//! the emit may fire before the webview runs JS; whether it still arrives
//! is unverified, and no buffering exists for it by design — the
//! `external_file_opened` telemetry event is the canary for whether that
//! path matters in practice.

use std::path::Path;

use tauri::{Emitter, Manager};

/// Emit OS-opened paths to the frontend and surface the window.
pub fn handle_opened_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>, paths: Vec<String>) {
    let files: Vec<String> = paths
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect();
    if files.is_empty() {
        return;
    }

    for path in &files {
        let _ = app.emit("file-selected", path.clone());
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

/// The file paths among a launch's arguments (flags and non-files skipped).
/// Windows/Linux file associations deliver the document as a plain argv
/// entry; macOS uses `RunEvent::Opened` instead.
pub fn file_paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && Path::new(a).is_file())
        .collect()
}
