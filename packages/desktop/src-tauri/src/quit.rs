//! A quit that waits for the frontend's goodbye: sync deletes this device's
//! presence refs, so the others see it go at once, not minutes later. Held
//! only while the frontend asks (`hold_quit`), and never past `QUIT_GRACE`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent, Runtime};

static HOLD: AtomicBool = AtomicBool::new(false);
/// Past sync's own close deadline (5 s): the quit happens either way.
const QUIT_GRACE: Duration = Duration::from_secs(6);

#[tauri::command]
pub fn hold_quit(hold: bool) {
    HOLD.store(hold, Ordering::SeqCst);
}

/// On `ExitRequested`: hold it once and tell the frontend, which exits when
/// it's done. The next request (that exit, or the grace's) goes through. A
/// restart isn't held, nor a quit with no window left to answer.
pub fn on_run_event<R: Runtime>(app: &tauri::AppHandle<R>, event: &RunEvent) {
    let RunEvent::ExitRequested { code, api, .. } = event else {
        return;
    };
    if *code == Some(tauri::RESTART_EXIT_CODE) || app.webview_windows().is_empty() {
        return;
    }
    if !HOLD.swap(false, Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    let _ = app.emit("quit-requested", ());
    let (app, code) = (app.clone(), code.unwrap_or(0));
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        app.exit(code);
    });
}
