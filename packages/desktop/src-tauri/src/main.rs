// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Command modules + the shared handler registration live in the library crate
// so the app binary, the mock-app dispatch tests, and the e2e shim all share
// one command list (MET-73).
use notefig::{agent_proc, db_ops, mcp_bridge, register_handlers};

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

fn create_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let open_folder = MenuItem::with_id(app, "open_folder", "Open Folder...", true, Some("cmd+o"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("cmd+q"))?;

    // Edit menu items - using predefined items for native OS behavior
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;

    let theme_light = MenuItem::with_id(app, "theme_light", "Light", true, None::<&str>)?;
    let theme_dark = MenuItem::with_id(app, "theme_dark", "Dark", true, None::<&str>)?;
    let theme_system = MenuItem::with_id(app, "theme_system", "System", true, None::<&str>)?;

    let zoom_75 = MenuItem::with_id(app, "zoom_75", "75%", true, None::<&str>)?;
    let zoom_100 = MenuItem::with_id(app, "zoom_100", "100%", true, None::<&str>)?;
    let zoom_125 = MenuItem::with_id(app, "zoom_125", "125%", true, None::<&str>)?;
    let zoom_150 = MenuItem::with_id(app, "zoom_150", "150%", true, None::<&str>)?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&open_folder)
        .separator()
        .item(&quit)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .separator()
        .item(&select_all)
        .build()?;

    let theme_submenu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_light)
        .item(&theme_dark)
        .item(&theme_system)
        .build()?;

    let zoom_submenu = SubmenuBuilder::new(app, "Zoom Level")
        .item(&zoom_75)
        .item(&zoom_100)
        .item(&zoom_125)
        .item(&zoom_150)
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&theme_submenu)
        .item(&zoom_submenu)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .build()?;

    Ok(menu)
}

/// Reads the persisted zoom level and applies native webview zoom.
/// Zoom lives in the frontend's `settings` KV collection (`notefig.db`, key
/// `zoomLevel`); the frontend is the sole writer — Rust only reads it back at
/// startup, so the zoom is right on the first painted frame instead of jumping
/// once the collection hydrates. A missing database or key simply leaves the
/// webview at 1.0.
fn restore_zoom_level(app: &AppHandle) {
    let Some(zoom) = db_ops::read_persisted_number(app, "kv:settings", "zoomLevel") else {
        return;
    };
    if let Some(webview_window) = app.get_webview_window("main") {
        if let Err(e) = webview_window.set_zoom(zoom) {
            eprintln!("Failed to restore native webview zoom: {}", e);
        }
    }
    let _ = app.emit("zoom-changed", zoom);
}

/// Applies native webview zoom; persistence happens on the frontend
/// (the `zoom-changed` handler writes the `settings` collection).
fn set_zoom_level(app: &AppHandle, zoom: f64) {
    if let Some(webview_window) = app.get_webview_window("main") {
        if let Err(e) = webview_window.set_zoom(zoom) {
            eprintln!("Failed to set native webview zoom: {}", e);
        }
    }

    // Emit event so frontend can persist the setting
    let _ = app.emit("zoom-changed", zoom);
}

/// One-time app-data migration for the com.metrists.dev -> com.notefig.app
/// identifier change: Tauri derives the app-data dir from the bundle
/// identifier, so an existing install would otherwise come up with a default
/// window. Copies (never moves — old builds may still run and read their dir)
/// the window-state file into the new dir, and only when the new dir has none,
/// so an already-migrated install is never overwritten.
///
/// Settings are deliberately NOT carried across: MET-124 moved them off the
/// JSON stores onto SQLite as a clean break, so `kv.json` and `settings.json`
/// have no reader left and copying them would only leave dead files behind.
fn migrate_app_data(old_dir: &std::path::Path, new_dir: &std::path::Path) {
    const WINDOW_STATE: &str = ".window-state.json";
    let source = old_dir.join(WINDOW_STATE);
    if new_dir.join(WINDOW_STATE).exists() || !source.is_file() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        eprintln!("app-data migration: cannot create {new_dir:?}: {e}");
        return;
    }
    if let Err(e) = std::fs::copy(&source, new_dir.join(WINDOW_STATE)) {
        eprintln!("app-data migration: copying {WINDOW_STATE} failed: {e}");
        return;
    }
    eprintln!("app-data migration: copied window state from {old_dir:?} to {new_dir:?}");
}

#[cfg(target_os = "macos")]
fn migrate_app_data_from_old_identifier() {
    // Paths match Tauri v2's app_data_dir resolution on macOS
    // ($HOME/Library/Application Support/<identifier>). Other platforms have
    // no shipped installs under the old identifier, so nothing to migrate.
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let support = std::path::Path::new(&home).join("Library/Application Support");
    migrate_app_data(
        &support.join("com.metrists.dev"),
        &support.join("com.notefig.app"),
    );
}

#[cfg(not(target_os = "macos"))]
fn migrate_app_data_from_old_identifier() {}

fn main() {
    // MCP stdio relay mode (Stage 3.5, mcp_bridge.rs): a harness process
    // spawns this same binary with this flag to bridge its stdio to the
    // loopback listener the running app opened for its task. Handled before
    // any Tauri bootstrap — this invocation never shows a window.
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--mcp-stdio-relay") {
        let port: u16 = args
            .get(pos + 1)
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| {
                eprintln!("--mcp-stdio-relay requires a port argument");
                std::process::exit(1);
            });
        mcp_bridge::run_mcp_stdio_relay(port);
        return;
    }

    // Must run before the builder chain: tauri_plugin_window_state reads its
    // file at plugin init.
    migrate_app_data_from_old_identifier();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            let menu = create_menu(app.handle())?;
            app.set_menu(menu)?;

            restore_zoom_level(app.handle());

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_folder" => {
                use tauri_plugin_dialog::DialogExt;

                let app_handle = app.clone();
                app.dialog()
                    .file()
                    .set_title("Select Folder")
                    .pick_folder(move |folder_path| {
                        if let Some(path) = folder_path {
                            let _ = app_handle.emit("folder-selected", path.to_string());
                        }
                    });
            }
            "quit" => {
                app.exit(0);
            }
            "theme_light" => {
                let _ = app.emit("theme-changed", "light");
            }
            "theme_dark" => {
                let _ = app.emit("theme-changed", "dark");
            }
            "theme_system" => {
                let _ = app.emit("theme-changed", "system");
            }
            "zoom_75" => {
                set_zoom_level(app, 0.75);
            }
            "zoom_100" => {
                set_zoom_level(app, 1.0);
            }
            "zoom_125" => {
                set_zoom_level(app, 1.25);
            }
            "zoom_150" => {
                set_zoom_level(app, 1.5);
            }
            _ => {}
        });

    register_handlers(builder)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Kill every spawned agent process when the app exits.
            if let tauri::RunEvent::Exit = event {
                agent_proc::kill_all_agents();
            }
        });
}

#[cfg(test)]
mod app_data_migration_tests {
    use super::migrate_app_data;
    use std::fs;

    fn dirs() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("com.metrists.dev");
        let new = tmp.path().join("com.notefig.app");
        (tmp, old, new)
    }

    #[test]
    fn copies_window_state_when_new_dir_is_empty() {
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(".window-state.json"), "{\"w\":1}").unwrap();

        migrate_app_data(&old, &new);

        assert_eq!(
            fs::read_to_string(new.join(".window-state.json")).unwrap(),
            "{\"w\":1}"
        );
        // Copy, not move: old files must survive for older builds.
        assert!(old.join(".window-state.json").exists());
    }

    #[test]
    fn leaves_the_retired_json_stores_behind() {
        // MET-124 made settings a clean break, so carrying these across would
        // only plant dead files in the new app-data dir.
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("kv.json"), "{}").unwrap();
        fs::write(old.join("settings.json"), "{}").unwrap();
        fs::write(old.join(".window-state.json"), "{}").unwrap();

        migrate_app_data(&old, &new);

        assert!(!new.join("kv.json").exists());
        assert!(!new.join("settings.json").exists());
    }

    #[test]
    fn never_overwrites_an_already_migrated_dir() {
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(".window-state.json"), "old").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join(".window-state.json"), "new").unwrap();

        migrate_app_data(&old, &new);

        assert_eq!(
            fs::read_to_string(new.join(".window-state.json")).unwrap(),
            "new"
        );
    }

    #[test]
    fn no_op_on_fresh_install_without_old_dir() {
        let (_tmp, old, new) = dirs();

        migrate_app_data(&old, &new);

        assert!(!new.exists());
    }

    #[test]
    fn no_op_when_the_old_dir_has_no_window_state() {
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("kv.json"), "{}").unwrap();

        migrate_app_data(&old, &new);

        assert!(!new.exists());
    }
}
