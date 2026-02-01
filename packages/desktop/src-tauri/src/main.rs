// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{Emitter, AppHandle};
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// Structs for TinyBase format
#[derive(serde::Serialize, Debug)]
struct FileRowData {
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(rename = "contentHash")]
    content_hash: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct TinyBaseContent {
    files: HashMap<String, FileRowData>,
}

// Helper function: Check if file is binary based on extension blacklist
fn is_binary_file(path: &Path) -> bool {
    const BINARY_EXTENSIONS: &[&str] = &[
        // Images
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp", "tiff", "tif",
        // Videos
        "mp4", "avi", "mov", "wmv", "flv", "webm", "mkv",
        // Audio
        "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
        // Archives
        "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
        // Executables
        "exe", "dll", "so", "dylib", "bin", "app",
        // Documents (binary formats)
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        // Fonts
        "ttf", "otf", "woff", "woff2", "eot",
        // Databases
        "db", "sqlite", "sqlite3",
        // Other
        "pyc", "pyo", "class", "o", "a", "obj",
    ];
    
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            return BINARY_EXTENSIONS.contains(&ext_str.to_lowercase().as_str());
        }
    }
    false
}

// Helper function: Compute hash of content using DefaultHasher
fn compute_hash(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

// Helper function: Convert path to forward slashes (for Windows compatibility)
fn path_to_forward_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

// Helper function: Get relative path without leading slash
fn get_relative_path(absolute_path: &Path, base_path: &Path) -> Result<String, String> {
    match absolute_path.strip_prefix(base_path) {
        Ok(relative) => Ok(path_to_forward_slash(relative)),
        Err(e) => Err(format!("Failed to get relative path: {}", e)),
    }
}

// Tauri command: Load all files from directory
#[tauri::command]
async fn load_directory_files(base_path: String) -> Result<TinyBaseContent, String> {
    let base = PathBuf::from(&base_path);
    
    // Validate base path exists
    if !base.exists() {
        return Err(format!("Base path does not exist: {}", base_path));
    }
    
    if !base.is_dir() {
        return Err(format!("Base path is not a directory: {}", base_path));
    }
    
    let mut files_map: HashMap<String, FileRowData> = HashMap::new();
    
    // Walk directory tree
    for entry_result in WalkDir::new(&base).follow_links(true) {
        match entry_result {
            Ok(entry) => {
                let path = entry.path();
                
                // Skip hidden files (starting with .)
                // Also skip .git and .metrists directories
                if let Some(file_name) = path.file_name() {
                    if let Some(name_str) = file_name.to_str() {
                        if name_str.starts_with('.') {
                            continue;
                        }
                    }
                }
                
                // Skip if any parent directory is .git or .metrists
                let path_str = path.to_string_lossy();
                if path_str.contains("/.git/") || path_str.contains("\\.git\\") ||
                   path_str.contains("/.metrists/") || path_str.contains("\\.metrists\\") {
                    continue;
                }
                
                // Skip the base directory itself
                if path == base {
                    continue;
                }
                
                // Get relative path
                let relative_path = match get_relative_path(path, &base) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("Error getting relative path for {:?}: {}", path, e);
                        continue;
                    }
                };
                
                // Skip if empty path
                if relative_path.is_empty() {
                    continue;
                }
                
                let is_directory = path.is_dir();
                let entry_type = if is_directory { "directory" } else { "file" };
                
                let mut modified: Option<i64> = None;
                let mut size: Option<u64> = None;
                let mut content = String::new();
                let mut error: Option<String> = None;
                
                // Get metadata
                match std::fs::metadata(path) {
                    Ok(metadata) => {
                        // Get modified time
                        if let Ok(modified_time) = metadata.modified() {
                            if let Ok(duration) = modified_time.duration_since(std::time::UNIX_EPOCH) {
                                modified = Some(duration.as_millis() as i64);
                            }
                        }
                        
                        // Get size (only for files)
                        if !is_directory {
                            size = Some(metadata.len());
                        }
                    }
                    Err(e) => {
                        error = Some(format!("Failed to read metadata: {}", e));
                    }
                }
                
                // Read content (only for text files)
                if !is_directory && error.is_none() {
                    if is_binary_file(path) {
                        // Binary file: leave content empty
                        content = String::new();
                    } else {
                        // Try to read as text file
                        match std::fs::read_to_string(path) {
                            Ok(file_content) => {
                                content = file_content;
                            }
                            Err(e) => {
                                // If read fails, mark as error but include in results
                                error = Some(format!("Failed to read file: {}", e));
                                content = String::new();
                            }
                        }
                    }
                }
                
                // Compute hash
                let content_hash = compute_hash(&content);
                
                // Add to map
                files_map.insert(
                    relative_path,
                    FileRowData {
                        entry_type: entry_type.to_string(),
                        modified,
                        size,
                        content_hash,
                        content,
                        error,
                    },
                );
            }
            Err(e) => {
                eprintln!("Error reading directory entry: {}", e);
                // Continue walking despite errors
                continue;
            }
        }
    }
    
    Ok(TinyBaseContent { files: files_map })
}

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Metrists", name)
}

// This function will be called from the frontend when needed
#[tauri::command]
async fn open_folder_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let folder_path = app.dialog()
        .file()
        .set_title("Select Folder")
        .blocking_pick_folder();

    match folder_path {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

fn create_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    // File menu items
    let open_folder = MenuItem::with_id(app, "open_folder", "Open Folder...", true, Some("cmd+o"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("cmd+q"))?;

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
        .invoke_handler(tauri::generate_handler![greet, open_folder_dialog, load_directory_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
