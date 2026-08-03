// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Command modules + the shared handler registration live in the library crate
// so the app binary, the mock-app dispatch tests, and the e2e shim all share
// one command list (MET-73).
use metrists::{agent_proc, mcp_bridge, opened_files, register_handlers};

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

fn create_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let open_folder = MenuItem::with_id(app, "open_folder", "Open Folder...", true, Some("cmd+o"))?;
    let open_file = MenuItem::with_id(app, "open_file", "Open File...", true, Some("cmd+shift+o"))?;
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
        .item(&open_file)
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

    let builder = tauri::Builder::default()
        // Single-instance must be the first registered plugin. A second
        // launch (e.g. OS "open with" while running) forwards its argv here
        // and exits; any document paths open in the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            opened_files::handle_opened_paths(app, opened_files::file_paths_from_args(argv));
        }))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            // Windows/Linux file associations deliver the document as an
            // argv entry on first launch. Best-effort emit — see the
            // opened_files module doc for the cold-start caveat.
            opened_files::handle_opened_paths(
                app.handle(),
                opened_files::file_paths_from_args(std::env::args()),
            );

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
                "open_file" => {
                    use tauri_plugin_dialog::DialogExt;

                    let app_handle = app.clone();
                    app.dialog().file().set_title("Open File").pick_file(
                        move |file_path| {
                            if let Some(path) = file_path {
                                let _ = app_handle.emit("file-selected", path.to_string());
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
        .run(|app_handle, event| {
            match event {
                // Kill every spawned agent process when the app exits.
                tauri::RunEvent::Exit => {
                    agent_proc::kill_all_agents();
                }
                // macOS file-association opens (Finder double-click,
                // `open -a`) arrive as file:// URLs, before or after setup.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls
                        .into_iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    opened_files::handle_opened_paths(app_handle, paths);
                }
                _ => {}
            }
        });
}
