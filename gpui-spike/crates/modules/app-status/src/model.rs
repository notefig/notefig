//! The menu's text and id rules (`app_status.rs`); the status itself is
//! `notefig_platform::AppStatus`.

pub use notefig_platform::{AppStatus, AppStatusAction, AppStatusActivate, AppStatusEntry, AppStatusSection};

/// Keeps the app's ids clear of the menu's own ("quit").
const ITEM_ID_PREFIX: &str = "app-status:";

/// The menu item id for an app id.
pub fn item_id(id: &str) -> String {
    format!("{ITEM_ID_PREFIX}{id}")
}

/// The app id behind a menu item, if the item is one of ours.
pub fn activated_id(menu_item_id: &str) -> Option<&str> {
    menu_item_id.strip_prefix(ITEM_ID_PREFIX)
}

/// A row's text: the label, then its note the way a sidebar row trails it.
pub fn entry_text(entry: &AppStatusEntry) -> String {
    match entry.detail.as_deref().filter(|d| !d.is_empty()) {
        Some(detail) => format!("{}  ·  {detail}", entry.label),
        None => entry.label.clone(),
    }
}

/// The menu glyph an entry's mark draws as (`tray::glyph`): the file stem
/// of its icon, None for an unknown or absent mark (drawn plain).
pub fn glyph(mark: Option<&str>) -> Option<&'static str> {
    Some(match mark? {
        "running" | "starting" => "running",
        "idle" | "done" | "cancelled" => "settled",
        "queued" => "queued",
        "error" | "unavailable" | "auth" | "attention-error" => "error",
        "attention-bau" => "attention",
        "document" => "document",
        _ => return None,
    })
}
