//! The webview's zoom: one of the View menu's levels, applied natively.
//!
//! The level lives in the frontend's `settings` KV collection (`notefig.db`,
//! key `zoomLevel`); the frontend is the sole writer. Each change here emits
//! `zoom-changed` for it to persist, and the level is read back at startup so
//! the first painted frame is already at it. A pinch steps between the menu's
//! levels (`step_zoom`), so it lands where the menu would.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::db_ops;

/// The View menu's zoom levels, smallest first.
pub const ZOOM_LEVELS: [f64; 4] = [0.75, 1.0, 1.25, 1.5];

/// The level applied now, for a step to start from.
pub struct Zoom(Mutex<f64>);

impl Default for Zoom {
    fn default() -> Self {
        Self(Mutex::new(1.0))
    }
}

/// The menu level one step from `current` (up when `direction` is positive),
/// or `None` at the end of the range. A level persisted between two menu
/// levels steps to the neighbour in that direction.
pub fn next_level(current: f64, direction: i32) -> Option<f64> {
    const EPSILON: f64 = 1e-6;
    if direction > 0 {
        ZOOM_LEVELS.into_iter().find(|level| *level > current + EPSILON)
    } else {
        ZOOM_LEVELS.into_iter().rev().find(|level| *level < current - EPSILON)
    }
}

/// Apply `level` to the main webview and remember it; `zoom-changed` tells
/// the frontend to persist it.
pub fn apply<R: Runtime>(app: &AppHandle<R>, level: f64) {
    if let Some(webview_window) = app.get_webview_window("main") {
        if let Err(e) = webview_window.set_zoom(level) {
            eprintln!("Failed to set native webview zoom: {e}");
        }
    }
    if let Some(zoom) = app.try_state::<Zoom>() {
        *zoom.0.lock().unwrap() = level;
    }
    let _ = app.emit("zoom-changed", level);
}

/// Apply the persisted level at startup. A missing database or key leaves
/// the webview at 1.0.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    if let Some(level) = db_ops::read_persisted_number(app, "kv:settings", "zoomLevel") {
        apply(app, level);
    }
}

/// One step to the next menu level up (`direction` > 0) or down: a pinch.
/// Nothing past either end.
#[tauri::command]
pub fn step_zoom<R: Runtime>(app: AppHandle<R>, direction: i32) {
    let current = app.try_state::<Zoom>().map_or(1.0, |zoom| *zoom.0.lock().unwrap());
    if let Some(level) = next_level(current, direction) {
        apply(&app, level);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_to_the_neighbouring_menu_level() {
        assert_eq!(next_level(1.0, 1), Some(1.25));
        assert_eq!(next_level(1.0, -1), Some(0.75));
    }

    #[test]
    fn stops_at_either_end() {
        assert_eq!(next_level(1.5, 1), None);
        assert_eq!(next_level(0.75, -1), None);
    }

    #[test]
    fn steps_from_a_level_between_two_to_the_neighbour_that_way() {
        assert_eq!(next_level(1.1, 1), Some(1.25));
        assert_eq!(next_level(1.1, -1), Some(1.0));
    }
}
