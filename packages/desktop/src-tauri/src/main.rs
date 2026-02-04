// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, AppHandle};
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use tokio::io::AsyncWriteExt;

// Structs for TinyBase format
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct FileRowData {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(rename = "contentHash")]
    content_hash: String,
    #[serde(rename = "savedContentHash")]
    saved_content_hash: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct TinyBaseContent {
    files: HashMap<String, FileRowData>,
}

// Save response structure
#[derive(serde::Serialize, Debug)]
struct SaveResponse {
    saved: usize,
    skipped: usize,
    deleted: usize,
    failed: usize,
    errors: Vec<String>,
    saved_paths: Vec<String>, // Paths that were successfully saved
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

// Helper function: Check if path should be skipped during traversal
fn should_skip_path(path: &Path) -> bool {
    // Skip hidden files (starting with .)
    if let Some(file_name) = path.file_name() {
        if let Some(name_str) = file_name.to_str() {
            if name_str.starts_with('.') {
                return true;
            }
        }
    }
    
    // Skip if any parent directory is .git or .metrists
    let path_str = path.to_string_lossy();
    if path_str.contains("/.git/") || path_str.contains("\\.git\\") ||
       path_str.contains("/.metrists/") || path_str.contains("\\.metrists\\") {
        return true;
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

// Helper function: Validate path for security (prevent directory traversal)
fn validate_path(path: &str) -> Result<(), String> {
    if path.contains("..") || path.starts_with("/") || path.starts_with("\\") {
        return Err(format!("Invalid path: directory traversal not allowed: {}", path));
    }
    Ok(())
}

// Helper function: Load current filesystem state (paths + hashes only)
fn load_filesystem_state(base_path: &str) -> Result<HashMap<String, String>, String> {
    let base = PathBuf::from(base_path);
    let mut state = HashMap::new();
    
    for entry_result in WalkDir::new(&base).follow_links(true) {
        match entry_result {
            Ok(entry) => {
                let path = entry.path();
                
                // Skip hidden files, .git, .metrists
                if should_skip_path(path) {
                    continue;
                }
                
                // Skip the base directory itself
                if path == base {
                    continue;
                }
                
                // Get relative path
                let relative_path = match get_relative_path(path, &base) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                
                if relative_path.is_empty() {
                    continue;
                }
                
                // Compute hash based on type
                let hash = if path.is_file() {
                    if is_binary_file(path) {
                        // Binary files: empty hash (we don't track content)
                        String::new()
                    } else {
                        // Text files: compute hash
                        match std::fs::read_to_string(path) {
                            Ok(content) => compute_hash(&content),
                            Err(_) => String::new(),
                        }
                    }
                } else {
                    // Directories: empty hash
                    String::new()
                };
                
                state.insert(relative_path, hash);
            }
            Err(_) => continue,
        }
    }
    
    Ok(state)
}

// Helper function: Atomic write for small files
async fn atomic_write_file(path: &Path, content: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::path::PathBuf;
    
    // Create temp file path
    let mut temp_path = PathBuf::from(path);
    let original_name = temp_path.file_name().unwrap_or(OsStr::new("file")).to_string_lossy();
    let temp_name = format!(".metrists_tmp_{}", original_name);
    temp_path.set_file_name(temp_name);
    
    // Write to temp file
    tokio::fs::write(&temp_path, content)
        .await
        .map_err(|e| format!("Write failed: {}", e))?;
    
    // Sync to disk
    let file = tokio::fs::File::open(&temp_path)
        .await
        .map_err(|e| format!("Open for sync failed: {}", e))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Sync failed: {}", e))?;
    
    // Close file
    drop(file);
    
    // Atomic rename
    tokio::fs::rename(&temp_path, path)
        .await
        .map_err(|e| format!("Rename failed: {}", e))?;
    
    Ok(())
}

// Helper function: Stream write for large files (>2MB)
async fn stream_write_file(path: &Path, content: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::path::PathBuf;
    
    // Create temp file path
    let mut temp_path = PathBuf::from(path);
    let original_name = temp_path.file_name().unwrap_or(OsStr::new("file")).to_string_lossy();
    let temp_name = format!(".metrists_tmp_{}", original_name);
    temp_path.set_file_name(temp_name);
    
    // Open file for writing
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Create failed: {}", e))?;
    
    // Write in chunks (64KB at a time)
    const CHUNK_SIZE: usize = 64 * 1024;
    let bytes = content.as_bytes();
    
    for chunk in bytes.chunks(CHUNK_SIZE) {
        file.write_all(chunk)
            .await
            .map_err(|e| format!("Write chunk failed: {}", e))?;
    }
    
    // Sync to disk
    file.sync_all()
        .await
        .map_err(|e| format!("Sync failed: {}", e))?;
    
    // Close file
    drop(file);
    
    // Atomic rename
    tokio::fs::rename(&temp_path, path)
        .await
        .map_err(|e| format!("Rename failed: {}", e))?;
    
    Ok(())
}

// Helper function: Save a single entry (file or directory)
async fn save_single_entry(
    base_path: String,
    relative_path: String,
    data: FileRowData,
) -> Result<(), String> {
    let absolute_path = PathBuf::from(&base_path).join(&relative_path);
    
    match data.entry_type.as_str() {
        "directory" => {
            // Create directory
            tokio::fs::create_dir_all(&absolute_path)
                .await
                .map_err(|e| format!("{}: {}", relative_path, e))?;
            Ok(())
        }
        "file" => {
            // Skip binary files (don't save binary content)
            if is_binary_file(&absolute_path) {
                return Ok(());
            }
            
            // Ensure parent directory exists
            if let Some(parent) = absolute_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("{}: Failed to create parent dir: {}", relative_path, e))?;
            }
            
            // Check content size
            let content_size = data.content.len();
            
            if content_size > 2 * 1024 * 1024 {
                // Large file (>2MB): Stream write
                stream_write_file(&absolute_path, &data.content).await?;
            } else {
                // Small file: Atomic write
                atomic_write_file(&absolute_path, &data.content).await?;
            }
            
            Ok(())
        }
        _ => Err(format!("Unknown entry type: {}", data.entry_type))
    }
}

// Helper function: Delete an entry (file or directory)
async fn delete_entry(base_path: String, relative_path: String) -> Result<(), String> {
    let absolute_path = PathBuf::from(&base_path).join(&relative_path);
    
    if !absolute_path.exists() {
        return Ok(()); // Already deleted
    }
    
    if absolute_path.is_dir() {
        // Delete directory recursively
        tokio::fs::remove_dir_all(&absolute_path)
            .await
            .map_err(|e| format!("{}: {}", relative_path, e))?;
    } else {
        // Delete file
        tokio::fs::remove_file(&absolute_path)
            .await
            .map_err(|e| format!("{}: {}", relative_path, e))?;
    }
    
    Ok(())
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
                
                // Skip hidden files, .git, .metrists
                if should_skip_path(path) {
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
                    relative_path.clone(),
                    FileRowData {
                        path: relative_path,
                        entry_type: entry_type.to_string(),
                        modified,
                        size,
                        content_hash: content_hash.clone(),
                        saved_content_hash: content_hash, // Initially same as content_hash
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

// Tauri command: Save files to filesystem
#[tauri::command]
async fn save_files(
    base_path: String,
    files: HashMap<String, FileRowData>,
) -> Result<SaveResponse, String> {
    // Validate base path exists
    let base = PathBuf::from(&base_path);
    if !base.exists() {
        return Err(format!("Base path does not exist: {}", base_path));
    }
    if !base.is_dir() {
        return Err(format!("Base path is not a directory: {}", base_path));
    }
    
    // Step 1: Load current filesystem state (paths + hashes only)
    let fs_state = load_filesystem_state(&base_path)?;
    
    // Step 2: Determine operations
    let mut to_save = Vec::new();
    let mut to_delete = Vec::new();
    let mut skipped = 0;
    
    for (path, row_data) in files.iter() {
        // Validate path (security check)
        if let Err(e) = validate_path(path) {
            eprintln!("Invalid path {}: {}", path, e);
            continue;
        }
        
        // Compute hash from current content in TinyBase state
        let current_content_hash = compute_hash(&row_data.content);
        
        // Compare with savedContentHash to detect changes
        // Skip if content hasn't changed since last save
        if current_content_hash == row_data.saved_content_hash {
            skipped += 1;
            continue;
        }
        
        // Content has changed, needs save
        to_save.push((path.clone(), row_data.clone()));
    }
    
    // Step 3: Find deletions (in filesystem but not in store)
    for fs_path in fs_state.keys() {
        if !files.contains_key(fs_path) {
            to_delete.push(fs_path.clone());
        }
    }
    
    // Step 4: Execute saves in parallel
    let base_path_clone = base_path.clone();
    let save_tasks: Vec<_> = to_save
        .into_iter()
        .map(|(path, data)| {
            let base = base_path_clone.clone();
            async move {
                let result = save_single_entry(base, path.clone(), data).await;
                (path, result)
            }
        })
        .collect();
    
    let save_results = futures::future::join_all(save_tasks).await;
    
    // Step 5: Execute deletes in parallel
    let delete_futures: Vec<_> = to_delete
        .into_iter()
        .map(|path| delete_entry(base_path.clone(), path))
        .collect();
    
    let delete_results = futures::future::join_all(delete_futures).await;
    
    // Step 6: Aggregate results
    let mut saved_paths = Vec::new();
    for (path, result) in &save_results {
        if result.is_ok() {
            saved_paths.push(path.clone());
        }
    }
    
    let saved = saved_paths.len();
    let deleted = delete_results.iter().filter(|r| r.is_ok()).count();
    let failed = save_results.iter().filter(|(_, r)| r.is_err()).count()
        + delete_results.iter().filter(|r| r.is_err()).count();
    
    let mut errors = Vec::new();
    for (_, result) in save_results.iter() {
        if let Err(e) = result {
            errors.push(e.to_string());
        }
    }
    for result in delete_results.iter() {
        if let Err(e) = result {
            errors.push(e.to_string());
        }
    }
    
    // Log summary
    eprintln!(
        "[Save] Saved: {}, Skipped: {}, Deleted: {}, Failed: {}",
        saved, skipped, deleted, failed
    );
    
    Ok(SaveResponse {
        saved,
        skipped,
        deleted,
        failed,
        errors,
        saved_paths,
    })
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
        .invoke_handler(tauri::generate_handler![greet, open_folder_dialog, load_directory_files, save_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
