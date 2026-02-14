// File system operations module
// Provides high-performance file system operations with error-as-values pattern

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

// ========== Error Types ==========

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FileSystemErrorType {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    InvalidPath,
    NotEmpty,
    IsDirectory,
    IsFile,
    IoError,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileSystemError {
    pub path: String,
    #[serde(rename = "type")]
    pub error_type: FileSystemErrorType,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum Result<T> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: FileSystemError },
}

impl<T> Result<T> {
    pub fn ok(value: T) -> Self {
        Result::Ok { ok: true, value }
    }

    pub fn err(path: String, error_type: FileSystemErrorType, message: String) -> Self {
        Result::Err {
            ok: false,
            error: FileSystemError {
                path,
                error_type,
                message,
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct BatchResult<T> {
    pub succeeded: Vec<T>,
    pub failed: Vec<FileSystemError>,
}

impl<T> BatchResult<T> {
    pub fn new() -> Self {
        BatchResult {
            succeeded: Vec::new(),
            failed: Vec::new(),
        }
    }
}

// ========== Metadata Types ==========

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileSystemMetadata {
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: u64,
    #[serde(rename = "modifiedAt")]
    pub modified_at: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExistsResult {
    pub path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
}

// ========== Helper Functions ==========

fn map_io_error(path: &str, err: std::io::Error) -> FileSystemError {
    let error_type = match err.kind() {
        std::io::ErrorKind::NotFound => FileSystemErrorType::NotFound,
        std::io::ErrorKind::PermissionDenied => FileSystemErrorType::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => FileSystemErrorType::AlreadyExists,
        _ => FileSystemErrorType::IoError,
    };

    FileSystemError {
        path: path.to_string(),
        error_type,
        message: err.to_string(),
    }
}

async fn ensure_parent_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    Ok(())
}

/// Check if a path contains any component that starts with a dot (hidden file/directory)
/// Examples: .git, .vscode, .DS_Store, etc.
fn is_hidden_path(path: &Path) -> bool {
    path.components().any(|component| {
        if let std::path::Component::Normal(os_str) = component {
            if let Some(name) = os_str.to_str() {
                return name.starts_with('.') && name.len() > 1;
            }
        }
        false
    })
}

// ========== Directory Operations ==========

#[tauri::command]
pub async fn read_directory(
    path: String,
    recursive: bool,
    include_files: bool,
    include_directories: bool,
) -> Result<Vec<String>> {
    let path_buf = PathBuf::from(&path);

    if !path_buf.exists() {
        return Result::err(
            path.clone(),
            FileSystemErrorType::NotFound,
            "Directory not found".to_string(),
        );
    }

    if !path_buf.is_dir() {
        return Result::err(
            path.clone(),
            FileSystemErrorType::IsFile,
            "Path is not a directory".to_string(),
        );
    }

    let mut results = Vec::new();

    if recursive {
        // Use walkdir for recursive traversal
        use walkdir::WalkDir;
        for entry in WalkDir::new(&path_buf).follow_links(true) {
            match entry {
                Ok(entry) => {
                    let entry_path = entry.path();
                    if entry_path == path_buf {
                        continue; // Skip root
                    }

                    // Filter out hidden files/directories (starting with .)
                    if is_hidden_path(entry_path) {
                        continue;
                    }

                    let is_dir = entry_path.is_dir();
                    if (is_dir && include_directories) || (!is_dir && include_files) {
                        results.push(entry_path.to_string_lossy().to_string());
                    }
                }
                Err(_) => continue,
            }
        }
    } else {
        // Non-recursive: read immediate children
        match fs::read_dir(&path_buf).await {
            Ok(mut entries) => {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let entry_path = entry.path();

                    // Filter out hidden files/directories (starting with .)
                    if is_hidden_path(&entry_path) {
                        continue;
                    }

                    let is_dir = entry_path.is_dir();
                    if (is_dir && include_directories) || (!is_dir && include_files) {
                        results.push(entry_path.to_string_lossy().to_string());
                    }
                }
            }
            Err(err) => {
                return Result::err(path, FileSystemErrorType::IoError, err.to_string());
            }
        }
    }

    Result::ok(results)
}

#[tauri::command]
pub async fn create_directories(paths: Vec<String>) -> BatchResult<String> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            match fs::create_dir_all(&path).await {
                Ok(_) => Ok(path),
                Err(err) => Err(map_io_error(&path, err)),
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    for res in results {
        match res {
            Ok(path) => result.succeeded.push(path),
            Err(err) => result.failed.push(err),
        }
    }

    result
}

#[tauri::command]
pub async fn delete_directories(paths: Vec<String>, recursive: bool) -> BatchResult<String> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            let path_buf = PathBuf::from(&path);

            if !path_buf.exists() {
                return Ok(path); // Already deleted
            }

            if !path_buf.is_dir() {
                return Err(FileSystemError {
                    path: path.clone(),
                    error_type: FileSystemErrorType::IsFile,
                    message: "Path is not a directory".to_string(),
                });
            }

            let delete_result = if recursive {
                fs::remove_dir_all(&path_buf).await
            } else {
                fs::remove_dir(&path_buf).await
            };

            match delete_result {
                Ok(_) => Ok(path),
                Err(err) => Err(map_io_error(&path, err)),
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    for res in results {
        match res {
            Ok(path) => result.succeeded.push(path),
            Err(err) => result.failed.push(err),
        }
    }

    result
}

#[tauri::command]
pub async fn move_directory(old_path: String, new_path: String) -> Result<()> {
    let old_path_buf = PathBuf::from(&old_path);
    let new_path_buf = PathBuf::from(&new_path);

    if !old_path_buf.exists() {
        return Result::err(
            old_path,
            FileSystemErrorType::NotFound,
            "Directory not found".to_string(),
        );
    }

    if !old_path_buf.is_dir() {
        return Result::err(
            old_path,
            FileSystemErrorType::IsFile,
            "Path is not a directory".to_string(),
        );
    }

    // Ensure parent of new path exists
    if let Err(err) = ensure_parent_dir(&new_path_buf).await {
        return Result::err(new_path, FileSystemErrorType::IoError, err.to_string());
    }

    match fs::rename(&old_path_buf, &new_path_buf).await {
        Ok(_) => Result::ok(()),
        Err(err) => Result::err(old_path, FileSystemErrorType::IoError, err.to_string()),
    }
}

// ========== File Operations ==========

#[tauri::command]
pub async fn read_files(paths: Vec<String>) -> BatchResult<FileContent> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            match fs::read_to_string(&path).await {
                Ok(content) => Ok(FileContent { path, content }),
                Err(err) => Err(map_io_error(&path, err)),
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    for res in results {
        match res {
            Ok(file_content) => result.succeeded.push(file_content),
            Err(err) => result.failed.push(err),
        }
    }

    result
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileContent {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct FileToWrite {
    pub path: String,
    pub content: String,
}

#[tauri::command]
pub async fn write_files(files: Vec<FileToWrite>) -> BatchResult<String> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = files
        .into_iter()
        .map(|file| async move {
            let path_buf = PathBuf::from(&file.path);

            // Ensure parent directory exists
            if let Err(err) = ensure_parent_dir(&path_buf).await {
                return Err(map_io_error(&file.path, err));
            }

            // Use atomic write for safety
            match atomic_write(&path_buf, &file.content).await {
                Ok(_) => Ok(file.path),
                Err(err) => Err(map_io_error(&file.path, err)),
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    for res in results {
        match res {
            Ok(path) => result.succeeded.push(path),
            Err(err) => result.failed.push(err),
        }
    }

    result
}

// Atomic write helper
async fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let temp_path = path.with_extension("tmp");

    // Write to temp file
    let mut file = fs::File::create(&temp_path).await?;
    file.write_all(content.as_bytes()).await?;
    file.sync_all().await?;
    drop(file);

    // Atomic rename
    fs::rename(&temp_path, path).await?;

    Ok(())
}

#[tauri::command]
pub async fn create_files(paths: Vec<String>) -> BatchResult<String> {
    let files = paths
        .into_iter()
        .map(|path| FileToWrite {
            path,
            content: String::new(),
        })
        .collect();
    write_files(files).await
}

#[tauri::command]
pub async fn delete_files(paths: Vec<String>) -> BatchResult<String> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            match fs::remove_file(&path).await {
                Ok(_) => Ok(path),
                Err(err) => {
                    // Check if already deleted
                    if err.kind() == std::io::ErrorKind::NotFound {
                        Ok(path)
                    } else {
                        Err(map_io_error(&path, err))
                    }
                }
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    for res in results {
        match res {
            Ok(path) => result.succeeded.push(path),
            Err(err) => result.failed.push(err),
        }
    }

    result
}

#[tauri::command]
pub async fn move_file(old_path: String, new_path: String) -> Result<()> {
    let old_path_buf = PathBuf::from(&old_path);
    let new_path_buf = PathBuf::from(&new_path);

    if !old_path_buf.exists() {
        return Result::err(
            old_path,
            FileSystemErrorType::NotFound,
            "File not found".to_string(),
        );
    }

    if old_path_buf.is_dir() {
        return Result::err(
            old_path,
            FileSystemErrorType::IsDirectory,
            "Path is a directory".to_string(),
        );
    }

    // Ensure parent of new path exists
    if let Err(err) = ensure_parent_dir(&new_path_buf).await {
        return Result::err(new_path, FileSystemErrorType::IoError, err.to_string());
    }

    match fs::rename(&old_path_buf, &new_path_buf).await {
        Ok(_) => Result::ok(()),
        Err(err) => Result::err(old_path, FileSystemErrorType::IoError, err.to_string()),
    }
}

#[tauri::command]
pub async fn copy_file(from: String, to: String) -> Result<()> {
    let from_buf = PathBuf::from(&from);
    let to_buf = PathBuf::from(&to);

    if !from_buf.exists() {
        return Result::err(
            from,
            FileSystemErrorType::NotFound,
            "File not found".to_string(),
        );
    }

    if from_buf.is_dir() {
        return Result::err(
            from,
            FileSystemErrorType::IsDirectory,
            "Path is a directory".to_string(),
        );
    }

    // Ensure parent of destination exists
    if let Err(err) = ensure_parent_dir(&to_buf).await {
        return Result::err(to, FileSystemErrorType::IoError, err.to_string());
    }

    match fs::copy(&from_buf, &to_buf).await {
        Ok(_) => Result::ok(()),
        Err(err) => Result::err(from, FileSystemErrorType::IoError, err.to_string()),
    }
}

// ========== Metadata & Existence ==========

#[tauri::command]
pub async fn check_exists(paths: Vec<String>) -> Vec<ExistsResult> {
    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            let path_buf = PathBuf::from(&path);
            let exists = path_buf.exists();

            let entry_type = if exists {
                Some(if path_buf.is_dir() {
                    "directory".to_string()
                } else {
                    "file".to_string()
                })
            } else {
                None
            };

            ExistsResult {
                path,
                exists,
                entry_type,
            }
        })
        .collect();

    futures::future::join_all(tasks).await
}

#[tauri::command]
pub async fn get_metadata(paths: Vec<String>) -> BatchResult<FileSystemMetadata> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            let path_buf = PathBuf::from(&path);

            match fs::metadata(&path_buf).await {
                Ok(metadata) => {
                    let entry_type = if metadata.is_dir() {
                        "directory"
                    } else {
                        "file"
                    }
                    .to_string();

                    let modified_at = metadata
                        .modified()
                        .ok()
                        .and_then(|time| {
                            time.duration_since(std::time::UNIX_EPOCH)
                                .ok()
                                .map(|d| d.as_millis() as i64)
                        })
                        .unwrap_or(0);

                    let created_at = metadata
                        .created()
                        .ok()
                        .and_then(|time| {
                            time.duration_since(std::time::UNIX_EPOCH)
                                .ok()
                                .map(|d| d.as_millis() as i64)
                        })
                        .unwrap_or(0);

                    Ok(FileSystemMetadata {
                        path,
                        entry_type,
                        size: metadata.len(),
                        modified_at,
                        created_at,
                    })
                }
                Err(err) => Err(map_io_error(&path, err)),
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    for res in results {
        match res {
            Ok(metadata) => result.succeeded.push(metadata),
            Err(err) => result.failed.push(err),
        }
    }

    result
}

// ========== File Watching ==========
// Note: File watching implementation would require notify crate
// For now, providing stub commands

#[tauri::command]
pub async fn watch_paths(_paths: Vec<String>, _watch_id: String) -> std::result::Result<(), String> {
    // TODO: Implement file watching with notify crate
    Ok(())
}

#[tauri::command]
pub async fn unwatch_paths(_watch_id: String) -> std::result::Result<(), String> {
    // TODO: Implement unwatching
    Ok(())
}
