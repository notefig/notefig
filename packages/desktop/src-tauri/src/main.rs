// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod file_watcher;
mod fs_ops;
mod search;
mod walkdir_utils;

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command

fn create_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    // File menu items
    let open_folder = MenuItem::with_id(app, "open_folder", "Open Folder...", true, Some("cmd+o"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("cmd+q"))?;

    // Edit menu items - using predefined items for native OS behavior
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;

    // Theme menu items
    let theme_light = MenuItem::with_id(app, "theme_light", "Light", true, None::<&str>)?;
    let theme_dark = MenuItem::with_id(app, "theme_dark", "Dark", true, None::<&str>)?;
    let theme_system = MenuItem::with_id(app, "theme_system", "System", true, None::<&str>)?;

    // Zoom level menu items
    let zoom_75 = MenuItem::with_id(app, "zoom_75", "75%", true, None::<&str>)?;
    let zoom_100 = MenuItem::with_id(app, "zoom_100", "100%", true, None::<&str>)?;
    let zoom_125 = MenuItem::with_id(app, "zoom_125", "125%", true, None::<&str>)?;
    let zoom_150 = MenuItem::with_id(app, "zoom_150", "150%", true, None::<&str>)?;

    // Build submenus
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

    // Build main menu
    let menu = MenuBuilder::new(app)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .build()?;

    Ok(menu)
}

/// Reads the persisted zoom level from the settings store and applies native webview zoom.
fn restore_zoom_level(app: &AppHandle) {
    match app.store("settings.json") {
        Ok(store) => {
            if let Some(zoom_value) = store.get("zoomLevel") {
                if let Some(zoom) = zoom_value.as_f64() {
                    // Apply native webview zoom
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
            eprintln!("Failed to open settings store for zoom restore: {}", e);
        }
    }
}

/// Persists the zoom level to the settings store and applies native webview zoom.
fn set_zoom_level(app: &AppHandle, zoom: f64) {
    // Apply native webview zoom
    if let Some(webview_window) = app.get_webview_window("main") {
        if let Err(e) = webview_window.set_zoom(zoom) {
            eprintln!("Failed to set native webview zoom: {}", e);
        }
    }

    // Emit event so frontend can persist the setting
    let _ = app.emit("zoom-changed", zoom);

    match app.store("settings.json") {
        Ok(store) => {
            store.set("zoomLevel", serde_json::json!(zoom));
            if let Err(e) = store.save() {
                eprintln!("Failed to save settings store: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to persist zoom level: {}", e);
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            let menu = create_menu(app.handle())?;
            app.set_menu(menu)?;

            // Restore persisted zoom level
            restore_zoom_level(app.handle());

            // Register updater and process plugins (desktop only)
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
                // Theme menu items
                "theme_light" => {
                    let _ = app.emit("theme-changed", "light");
                }
                "theme_dark" => {
                    let _ = app.emit("theme-changed", "dark");
                }
                "theme_system" => {
                    let _ = app.emit("theme-changed", "system");
                }
                // Zoom level menu items
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
        })
        .invoke_handler(tauri::generate_handler![
            // File system commands (errors-as-values pattern)
            fs_ops::read_directory,
            fs_ops::create_directories,
            fs_ops::delete_directories,
            fs_ops::move_directory,
            fs_ops::read_files,
            fs_ops::read_binary_files,
            fs_ops::write_files,
            fs_ops::create_files,
            fs_ops::delete_files,
            fs_ops::move_file,
            fs_ops::copy_file,
            fs_ops::check_exists,
            fs_ops::get_metadata,
            fs_ops::write_binary_files,
            // File watcher commands
            file_watcher::start_watching_metadata,
            file_watcher::start_watching_content,
            file_watcher::stop_watching,
            // Search commands
            search::search_content,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
