// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs_ops;

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, AppHandle};

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

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&theme_submenu)
        .build()?;

    // Build main menu
    let menu = MenuBuilder::new(app)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .build()?;

    Ok(menu)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            let menu = create_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
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
            fs_ops::write_files,
            fs_ops::create_files,
            fs_ops::delete_files,
            fs_ops::move_file,
            fs_ops::copy_file,
            fs_ops::check_exists,
            fs_ops::get_metadata,
            fs_ops::watch_paths,
            fs_ops::unwatch_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
