// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Command modules + the shared handler registration live in the library crate
// so the app binary, the mock-app dispatch tests, and the e2e shim all share
// one command list (MET-73).
use notefig::{agent_proc, mcp_bridge, register_handlers};

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

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
/// Zoom lives in the frontend's KV store (kv.json, key `settings:zoomLevel`);
/// the frontend is the sole writer — Rust only reads it back at startup.
/// Falls back to the legacy settings.json store for values persisted before
/// the stores were unified.
fn restore_zoom_level(app: &AppHandle) {
    match app.store("kv.json") {
        Ok(store) => {
            let zoom_value = store.get("settings:zoomLevel").or_else(|| {
                app.store("settings.json")
                    .ok()
                    .and_then(|legacy| legacy.get("zoomLevel"))
            });
            if let Some(zoom_value) = zoom_value {
                if let Some(zoom) = zoom_value.as_f64() {
                    if let Some(webview_window) = app.get_webview_window("main") {
                        if let Err(e) = webview_window.set_zoom(zoom) {
                            eprintln!("Failed to restore native webview zoom: {}", e);
                        }
                    }
                    let _ = app.emit("zoom-changed", zoom);
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to open kv store for zoom restore: {}", e);
        }
    }
}

/// Applies native webview zoom; persistence happens on the frontend
/// (the `zoom-changed` handler writes kv.json).
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
/// identifier, so without this every existing install would come up with
/// empty settings. Copies (never moves — old builds may still run and read
/// their dir) the store and window-state files into the new dir, and only
/// when the new dir has no kv.json yet so an already-migrated install is
/// never overwritten.
fn migrate_app_data(old_dir: &std::path::Path, new_dir: &std::path::Path) {
    if new_dir.join("kv.json").exists() || !old_dir.is_dir() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        eprintln!("app-data migration: cannot create {new_dir:?}: {e}");
        return;
    }
    for name in ["kv.json", "settings.json", ".window-state.json"] {
        let src = old_dir.join(name);
        if src.is_file() {
            if let Err(e) = std::fs::copy(&src, new_dir.join(name)) {
                eprintln!("app-data migration: copying {name} failed: {e}");
            }
        }
    }
    eprintln!("app-data migration: copied store files from {old_dir:?} to {new_dir:?}");
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
    migrate_app_data(&support.join("com.metrists.dev"), &support.join("com.notefig.app"));
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
    // file at plugin init and restore_zoom_level opens kv.json in setup.
    migrate_app_data_from_old_identifier();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
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
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open_folder" => {
                    use tauri_plugin_dialog::DialogExt;

                    let app_handle = app.clone();
                    app.dialog().file().set_title("Select Folder").pick_folder(
                        move |folder_path| {
                            if let Some(path) = folder_path {
                                let _ = app_handle.emit("folder-selected", path.to_string());
                            }
                        },
                    );
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
            }
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
    fn copies_store_files_when_new_dir_is_empty() {
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("kv.json"), "{\"k\":1}").unwrap();
        fs::write(old.join("settings.json"), "{}").unwrap();
        fs::write(old.join(".window-state.json"), "{}").unwrap();

        migrate_app_data(&old, &new);

        assert_eq!(fs::read_to_string(new.join("kv.json")).unwrap(), "{\"k\":1}");
        assert!(new.join("settings.json").exists());
        assert!(new.join(".window-state.json").exists());
        // Copy, not move: old files must survive for older builds.
        assert!(old.join("kv.json").exists());
    }

    #[test]
    fn never_overwrites_an_already_migrated_dir() {
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("kv.json"), "old").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("kv.json"), "new").unwrap();

        migrate_app_data(&old, &new);

        assert_eq!(fs::read_to_string(new.join("kv.json")).unwrap(), "new");
    }

    #[test]
    fn no_op_on_fresh_install_without_old_dir() {
        let (_tmp, old, new) = dirs();

        migrate_app_data(&old, &new);

        assert!(!new.exists());
    }

    #[test]
    fn skips_missing_files_without_failing() {
        let (_tmp, old, new) = dirs();
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("kv.json"), "{}").unwrap(); // no settings.json / window state

        migrate_app_data(&old, &new);

        assert!(new.join("kv.json").exists());
        assert!(!new.join("settings.json").exists());
    }
}
