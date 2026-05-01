use crate::file_watcher::{compute_content_hash, register_app_write};
use crate::walkdir_utils::{is_hidden_relative_to, walk_directory, WalkOptions};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

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

// Note: is_hidden_path and is_hidden_relative_to are now in walkdir_utils module

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
        // Use shared walk_directory utility for consistent traversal
        let options = WalkOptions {
            follow_links: true,
            exclude_hidden: true,
            exclude_patterns: vec![],
            base_path: path_buf.clone(),
        };

        if let Err(e) = walk_directory(&path_buf, &options, |entry| {
            let entry_path = entry.path();
            let is_dir = entry_path.is_dir();

            if (is_dir && include_directories) || (!is_dir && include_files) {
                results.push(entry_path.to_string_lossy().to_string());
            }

            Ok(())
        }) {
            return Result::err(path, FileSystemErrorType::IoError, e);
        }
    } else {
        // Non-recursive: read immediate children
        match fs::read_dir(&path_buf).await {
            Ok(mut entries) => {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let entry_path = entry.path();

                    // Filter out hidden files/directories using shared utility
                    if is_hidden_relative_to(&entry_path, &path_buf) {
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
                return Ok(path);
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

    if let Err(err) = ensure_parent_dir(&new_path_buf).await {
        return Result::err(new_path, FileSystemErrorType::IoError, err.to_string());
    }

    match fs::rename(&old_path_buf, &new_path_buf).await {
        Ok(_) => Result::ok(()),
        Err(err) => Result::err(old_path, FileSystemErrorType::IoError, err.to_string()),
    }
}

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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BinaryFileContent {
    pub path: String,
    pub data: Vec<u8>,
}

#[tauri::command]
pub async fn read_binary_files(paths: Vec<String>) -> BatchResult<BinaryFileContent> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = paths
        .into_iter()
        .map(|path| async move {
            match fs::read(&path).await {
                Ok(data) => Ok(BinaryFileContent { path, data }),
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

            // Register write before writing to prevent race condition with watcher
            let hash = compute_content_hash(&file.content);
            register_app_write(file.path.clone(), hash);

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

async fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let temp_path = path.with_extension("tmp");

    let mut file = fs::File::create(&temp_path).await?;
    file.write_all(content.as_bytes()).await?;
    file.sync_all().await?;
    drop(file);

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

#[derive(Serialize, Deserialize)]
pub struct BinaryFileWriteRequest {
    pub path: String,
    pub data: Vec<u8>,
}

#[tauri::command]
pub async fn write_binary_files(files: Vec<BinaryFileWriteRequest>) -> BatchResult<String> {
    let mut result = BatchResult::new();

    for file in files {
        let path = PathBuf::from(&file.path);

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                if let Err(err) = fs::create_dir_all(parent).await {
                    result.failed.push(map_io_error(&file.path, err));
                    continue;
                }
            }
        }

        // Write binary data
        match fs::write(&path, file.data).await {
            Ok(_) => {
                result.succeeded.push(file.path);
            }
            Err(err) => {
                result.failed.push(map_io_error(&file.path, err));
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        tempfile::tempdir().expect("Failed to create temp directory")
    }

    async fn create_test_file(dir: &TempDir, path: &str, content: &str) -> String {
        let file_path = dir.path().join(path);
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .expect("Failed to create parent directory");
        }
        tokio::fs::write(&file_path, content)
            .await
            .expect("Failed to write file");
        file_path.to_string_lossy().to_string()
    }

    #[tokio::test]
    async fn test_read_directory_lists_files_recursively() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        // Create test structure
        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, "subdir/file2.txt", "content2").await;
        create_test_file(&temp_dir, "subdir/nested/file3.txt", "content3").await;

        let result = read_directory(root_path.clone(), true, true, false).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 3);
            assert!(value.iter().any(|p| p.contains("file1.txt")));
            assert!(value.iter().any(|p| p.contains("file2.txt")));
            assert!(value.iter().any(|p| p.contains("file3.txt")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_lists_files_non_recursively() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, "subdir/file2.txt", "content2").await;

        let result = read_directory(root_path.clone(), false, true, false).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 1);
            assert!(value[0].contains("file1.txt"));
        }
    }

    #[tokio::test]
    async fn test_read_directory_filters_hidden_files() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, ".hidden.txt", "hidden").await;
        create_test_file(&temp_dir, ".git/config", "git config").await;

        let result = read_directory(root_path.clone(), true, true, true).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().any(|p| p.contains("file1.txt")));
            assert!(!value.iter().any(|p| p.contains(".hidden.txt")));
            assert!(!value.iter().any(|p| p.contains(".git")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_handles_paths_with_trailing_slashes() {
        let temp_dir = setup_test_dir();
        let mut root_path = temp_dir.path().to_string_lossy().to_string();
        root_path.push('/');

        create_test_file(&temp_dir, "file1.txt", "content1").await;

        let result = read_directory(root_path, false, true, false).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 1);
        }
    }

    #[tokio::test]
    async fn test_read_directory_returns_error_for_invalid_workspace_path() {
        let result = read_directory("".to_string(), false, true, true).await;

        assert!(matches!(result, Result::Err { .. }));
    }

    #[tokio::test]
    async fn test_read_directory_handles_include_files_option() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        tokio::fs::create_dir(temp_dir.path().join("subdir"))
            .await
            .expect("Failed to create dir");

        let result = read_directory(root_path.clone(), false, true, false).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().all(|p| !p.contains("subdir")));
            assert!(value.iter().any(|p| p.contains("file1.txt")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_handles_include_directories_option() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        tokio::fs::create_dir(temp_dir.path().join("subdir"))
            .await
            .expect("Failed to create dir");

        let result = read_directory(root_path.clone(), false, false, true).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().all(|p| !p.contains("file1.txt")));
            assert!(value.iter().any(|p| p.contains("subdir")));
        }
    }

    // ========== read_files Tests ==========

    #[tokio::test]
    async fn test_read_files_reads_multiple_files_in_batch() {
        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "file1.txt", "content1").await;
        let file2 = create_test_file(&temp_dir, "file2.txt", "content2").await;

        let result = read_files(vec![file1.clone(), file2.clone()]).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(result
            .succeeded
            .iter()
            .any(|f| f.path == file1 && f.content == "content1"));
        assert!(result
            .succeeded
            .iter()
            .any(|f| f.path == file2 && f.content == "content2"));
        assert!(result.failed.is_empty());
    }

    #[tokio::test]
    async fn test_read_files_returns_partial_success() {
        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "file1.txt", "content1").await;
        let missing_file = temp_dir
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .to_string();

        let result = read_files(vec![file1.clone(), missing_file.clone()]).await;

        assert_eq!(result.succeeded.len(), 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, missing_file);
        assert!(matches!(
            result.failed[0].error_type,
            FileSystemErrorType::NotFound
        ));
    }

    #[tokio::test]
    async fn test_read_files_returns_empty_content_for_empty_files() {
        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "empty.txt", "").await;

        let result = read_files(vec![file1.clone()]).await;

        assert_eq!(result.succeeded.len(), 1);
        assert_eq!(result.succeeded[0].content, "");
    }

    #[tokio::test]
    async fn test_read_binary_files_reads_multiple_files_in_batch() {
        let temp_dir = setup_test_dir();
        let file1_path = temp_dir.path().join("file1.bin");
        let file2_path = temp_dir.path().join("file2.bin");
        tokio::fs::write(&file1_path, vec![1u8, 2, 3])
            .await
            .expect("Failed to write binary file1");
        tokio::fs::write(&file2_path, vec![4u8, 5, 6])
            .await
            .expect("Failed to write binary file2");

        let file1 = file1_path.to_string_lossy().to_string();
        let file2 = file2_path.to_string_lossy().to_string();

        let result = read_binary_files(vec![file1.clone(), file2.clone()]).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(result
            .succeeded
            .iter()
            .any(|f| f.path == file1 && f.data == vec![1u8, 2, 3]));
        assert!(result
            .succeeded
            .iter()
            .any(|f| f.path == file2 && f.data == vec![4u8, 5, 6]));
        assert!(result.failed.is_empty());
    }

    #[tokio::test]
    async fn test_read_binary_files_returns_partial_success() {
        let temp_dir = setup_test_dir();
        let file = temp_dir.path().join("file.bin");
        tokio::fs::write(&file, vec![1u8, 2, 3])
            .await
            .expect("Failed to write binary file");
        let existing = file.to_string_lossy().to_string();
        let missing = temp_dir
            .path()
            .join("missing.bin")
            .to_string_lossy()
            .to_string();

        let result = read_binary_files(vec![existing.clone(), missing.clone()]).await;

        assert_eq!(result.succeeded.len(), 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.succeeded[0].path, existing);
        assert_eq!(result.failed[0].path, missing);
    }

    #[tokio::test]
    async fn test_write_files_writes_multiple_files_atomically() {
        let temp_dir = setup_test_dir();
        let file1 = temp_dir
            .path()
            .join("file1.txt")
            .to_string_lossy()
            .to_string();
        let file2 = temp_dir
            .path()
            .join("file2.txt")
            .to_string_lossy()
            .to_string();

        let files = vec![
            FileToWrite {
                path: file1.clone(),
                content: "content1".to_string(),
            },
            FileToWrite {
                path: file2.clone(),
                content: "content2".to_string(),
            },
        ];

        let result = write_files(files).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(result.failed.is_empty());

        let content1 = tokio::fs::read_to_string(&file1)
            .await
            .expect("Failed to read file1");
        let content2 = tokio::fs::read_to_string(&file2)
            .await
            .expect("Failed to read file2");
        assert_eq!(content1, "content1");
        assert_eq!(content2, "content2");
    }

    #[tokio::test]
    async fn test_write_files_handles_special_characters_in_content() {
        let temp_dir = setup_test_dir();
        let file1 = temp_dir
            .path()
            .join("special.txt")
            .to_string_lossy()
            .to_string();

        let files = vec![FileToWrite {
            path: file1.clone(),
            content: "<>&\"'\n\t".to_string(),
        }];

        let result = write_files(files).await;

        assert_eq!(result.succeeded.len(), 1);

        let content = tokio::fs::read_to_string(&file1)
            .await
            .expect("Failed to read file");
        assert_eq!(content, "<>&\"'\n\t");
    }

    #[tokio::test]
    async fn test_write_files_returns_failed_array_for_errors() {
        let invalid_file = "/nonexistent/invalid/path/file.txt".to_string();

        let files = vec![FileToWrite {
            path: invalid_file.clone(),
            content: "content".to_string(),
        }];

        let result = write_files(files).await;

        assert!(result.succeeded.is_empty());
        assert_eq!(result.failed.len(), 1);
    }

    #[tokio::test]
    async fn test_create_directories_creates_directories() {
        let temp_dir = setup_test_dir();
        let dir1 = temp_dir.path().join("newdir").to_string_lossy().to_string();
        let dir2 = temp_dir
            .path()
            .join("nested/dir")
            .to_string_lossy()
            .to_string();

        let result = create_directories(vec![dir1.clone(), dir2.clone()]).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(result.failed.is_empty());

        assert!(tokio::fs::metadata(&dir1).await.unwrap().is_dir());
        assert!(tokio::fs::metadata(&dir2).await.unwrap().is_dir());
    }

    #[tokio::test]
    async fn test_create_directories_handles_failures() {
        let invalid_dir = "/nonexistent/invalid/path".to_string();

        let result = create_directories(vec![invalid_dir.clone()]).await;

        assert!(result.succeeded.is_empty());
        assert_eq!(result.failed.len(), 1);
    }

    #[tokio::test]
    async fn test_delete_directories_deletes_directories_and_all_children_with_recursive_option() {
        let temp_dir = setup_test_dir();
        let dir = temp_dir
            .path()
            .join("testdir")
            .to_string_lossy()
            .to_string();
        tokio::fs::create_dir(&dir)
            .await
            .expect("Failed to create directory");
        create_test_file(&temp_dir, "testdir/file.txt", "content").await;
        tokio::fs::create_dir(temp_dir.path().join("testdir/subdir"))
            .await
            .expect("Failed to create subdirectory");

        let result = delete_directories(vec![dir.clone()], true).await;

        assert_eq!(result.succeeded.len(), 1);
        assert!(result.failed.is_empty());
        assert!(!PathBuf::from(&dir).exists());
    }

    #[tokio::test]
    async fn test_delete_directories_fails_non_recursively_if_directory_not_empty() {
        let temp_dir = setup_test_dir();
        let dir = temp_dir
            .path()
            .join("testdir")
            .to_string_lossy()
            .to_string();
        tokio::fs::create_dir(&dir)
            .await
            .expect("Failed to create directory");
        create_test_file(&temp_dir, "testdir/file.txt", "content").await;

        let result = delete_directories(vec![dir.clone()], false).await;

        assert!(result.succeeded.is_empty());
        assert_eq!(result.failed.len(), 1);
        assert!(PathBuf::from(&dir).exists());
    }

    #[tokio::test]
    async fn test_delete_directories_handles_multiple_directories_in_batch() {
        let temp_dir = setup_test_dir();
        let dir1 = temp_dir.path().join("dir1").to_string_lossy().to_string();
        let dir2 = temp_dir.path().join("dir2").to_string_lossy().to_string();
        tokio::fs::create_dir(&dir1)
            .await
            .expect("Failed to create dir1");
        tokio::fs::create_dir(&dir2)
            .await
            .expect("Failed to create dir2");

        let result = delete_directories(vec![dir1.clone(), dir2.clone()], true).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(!PathBuf::from(&dir1).exists());
        assert!(!PathBuf::from(&dir2).exists());
    }

    #[tokio::test]
    async fn test_move_directory_moves_directory_and_all_children() {
        let temp_dir = setup_test_dir();
        let old_dir = temp_dir.path().join("old").to_string_lossy().to_string();
        let new_dir = temp_dir.path().join("new").to_string_lossy().to_string();

        tokio::fs::create_dir(&old_dir)
            .await
            .expect("Failed to create directory");
        create_test_file(&temp_dir, "old/file.txt", "content").await;

        let result = move_directory(old_dir.clone(), new_dir.clone()).await;

        assert!(matches!(result, Result::Ok { .. }));
        assert!(!PathBuf::from(&old_dir).exists());
        assert!(PathBuf::from(&new_dir).exists());
        assert!(PathBuf::from(&new_dir).join("file.txt").exists());
    }

    #[tokio::test]
    async fn test_move_directory_updates_all_file_paths() {
        let temp_dir = setup_test_dir();
        let old_dir = temp_dir.path().join("old").to_string_lossy().to_string();
        let new_dir = temp_dir.path().join("new").to_string_lossy().to_string();

        tokio::fs::create_dir(&old_dir)
            .await
            .expect("Failed to create directory");
        tokio::fs::create_dir(temp_dir.path().join("old/sub"))
            .await
            .expect("Failed to create subdirectory");
        create_test_file(&temp_dir, "old/a.txt", "a").await;
        create_test_file(&temp_dir, "old/sub/b.txt", "b").await;

        let result = move_directory(old_dir.clone(), new_dir.clone()).await;

        assert!(matches!(result, Result::Ok { .. }));
        assert!(PathBuf::from(&new_dir).join("a.txt").exists());
        assert!(PathBuf::from(&new_dir).join("sub/b.txt").exists());
    }

    #[tokio::test]
    async fn test_move_directory_fails_if_source_does_not_exist() {
        let temp_dir = setup_test_dir();
        let old_dir = temp_dir
            .path()
            .join("nonexistent")
            .to_string_lossy()
            .to_string();
        let new_dir = temp_dir.path().join("new").to_string_lossy().to_string();

        let result = move_directory(old_dir.clone(), new_dir.clone()).await;

        assert!(matches!(result, Result::Err { .. }));
        if let Result::Err { error, .. } = result {
            assert!(matches!(error.error_type, FileSystemErrorType::NotFound));
        }
    }

    #[tokio::test]
    async fn test_move_directory_handles_nested_directory_moves() {
        let temp_dir = setup_test_dir();
        let old_dir = temp_dir.path().join("a").to_string_lossy().to_string();
        let new_dir = temp_dir.path().join("x").to_string_lossy().to_string();

        tokio::fs::create_dir(&old_dir)
            .await
            .expect("Failed to create directory");
        tokio::fs::create_dir_all(temp_dir.path().join("a/b/c"))
            .await
            .expect("Failed to create nested directories");
        create_test_file(&temp_dir, "a/b/c/file.txt", "deep").await;

        let result = move_directory(old_dir.clone(), new_dir.clone()).await;

        assert!(matches!(result, Result::Ok { .. }));
        assert!(PathBuf::from(&new_dir).join("b/c/file.txt").exists());
    }

    #[tokio::test]
    async fn test_delete_files_deletes_multiple_files() {
        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "file1.txt", "content1").await;
        let file2 = create_test_file(&temp_dir, "file2.txt", "content2").await;

        let result = delete_files(vec![file1.clone(), file2.clone()]).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(!PathBuf::from(&file1).exists());
        assert!(!PathBuf::from(&file2).exists());
    }

    #[tokio::test]
    async fn test_delete_files_handles_non_existent_files() {
        let temp_dir = setup_test_dir();
        let missing_file = temp_dir
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .to_string();

        let result = delete_files(vec![missing_file.clone()]).await;

        assert_eq!(result.succeeded.len(), 1);
    }

    #[tokio::test]
    async fn test_move_file_renames_file_in_place() {
        let temp_dir = setup_test_dir();
        let old_file = create_test_file(&temp_dir, "old.txt", "content").await;
        let new_file = temp_dir
            .path()
            .join("new.txt")
            .to_string_lossy()
            .to_string();

        let result = move_file(old_file.clone(), new_file.clone()).await;

        assert!(matches!(result, Result::Ok { .. }));
        assert!(!PathBuf::from(&old_file).exists());
        assert!(PathBuf::from(&new_file).exists());
        assert_eq!(
            tokio::fs::read_to_string(&new_file).await.unwrap(),
            "content"
        );
    }

    #[tokio::test]
    async fn test_move_file_moves_file_between_directories() {
        let temp_dir = setup_test_dir();
        tokio::fs::create_dir(temp_dir.path().join("a"))
            .await
            .expect("Failed to create dir a");
        tokio::fs::create_dir(temp_dir.path().join("b"))
            .await
            .expect("Failed to create dir b");

        let old_file = create_test_file(&temp_dir, "a/file.txt", "data").await;
        let new_file = temp_dir
            .path()
            .join("b/file.txt")
            .to_string_lossy()
            .to_string();

        let result = move_file(old_file.clone(), new_file.clone()).await;

        assert!(matches!(result, Result::Ok { .. }));
        assert!(!PathBuf::from(&old_file).exists());
        assert!(PathBuf::from(&new_file).exists());
    }

    #[tokio::test]
    async fn test_move_file_fails_if_source_does_not_exist() {
        let temp_dir = setup_test_dir();
        let old_file = temp_dir
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .to_string();
        let new_file = temp_dir
            .path()
            .join("new.txt")
            .to_string_lossy()
            .to_string();

        let result = move_file(old_file.clone(), new_file.clone()).await;

        assert!(matches!(result, Result::Err { .. }));
        if let Result::Err { error, .. } = result {
            assert!(matches!(error.error_type, FileSystemErrorType::NotFound));
        }
    }

    #[tokio::test]
    async fn test_check_exists_checks_if_files_exist() {
        let temp_dir = setup_test_dir();
        let file = create_test_file(&temp_dir, "file.txt", "content").await;

        let result = check_exists(vec![file.clone()]).await;

        assert_eq!(result.len(), 1);
        assert!(result[0].exists);
        assert_eq!(result[0].entry_type, Some("file".to_string()));
    }

    #[tokio::test]
    async fn test_check_exists_checks_if_directories_exist() {
        let temp_dir = setup_test_dir();
        let dir = temp_dir
            .path()
            .join("testdir")
            .to_string_lossy()
            .to_string();
        tokio::fs::create_dir(&dir)
            .await
            .expect("Failed to create directory");

        let result = check_exists(vec![dir.clone()]).await;

        assert_eq!(result.len(), 1);
        assert!(result[0].exists);
        assert_eq!(result[0].entry_type, Some("directory".to_string()));
    }

    #[tokio::test]
    async fn test_check_exists_returns_type_for_existing_paths() {
        let temp_dir = setup_test_dir();
        let file = create_test_file(&temp_dir, "file.txt", "content").await;

        let result = check_exists(vec![file.clone()]).await;

        assert!(result[0].entry_type.is_some());
    }

    #[tokio::test]
    async fn test_get_metadata_returns_file_metadata() {
        let temp_dir = setup_test_dir();
        let file = create_test_file(&temp_dir, "file.txt", "content").await;

        let result = get_metadata(vec![file.clone()]).await;

        assert_eq!(result.succeeded.len(), 1);
        let metadata = &result.succeeded[0];
        assert_eq!(metadata.entry_type, "file");
        assert_eq!(metadata.size, 7);
        assert!(metadata.modified_at > 0);
        assert!(metadata.created_at > 0);
    }

    #[tokio::test]
    async fn test_get_metadata_returns_directory_metadata() {
        let temp_dir = setup_test_dir();
        let dir = temp_dir
            .path()
            .join("testdir")
            .to_string_lossy()
            .to_string();
        tokio::fs::create_dir(&dir)
            .await
            .expect("Failed to create directory");

        let result = get_metadata(vec![dir.clone()]).await;

        assert_eq!(result.succeeded.len(), 1);
        let metadata = &result.succeeded[0];
        assert_eq!(metadata.entry_type, "directory");
        // Directory size varies by platform, just verify it's a valid directory
        assert!(metadata.modified_at > 0);
        assert!(metadata.created_at > 0);
    }

    #[tokio::test]
    async fn test_get_metadata_fails_for_non_existent_paths() {
        let temp_dir = setup_test_dir();
        let missing = temp_dir
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .to_string();

        let result = get_metadata(vec![missing.clone()]).await;

        assert!(result.succeeded.is_empty());
        assert_eq!(result.failed.len(), 1);
    }

    #[tokio::test]
    async fn test_get_metadata_handles_batch_requests() {
        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "file1.txt", "a").await;
        let file2 = create_test_file(&temp_dir, "file2.txt", "bb").await;

        let result = get_metadata(vec![file1.clone(), file2.clone()]).await;

        assert_eq!(result.succeeded.len(), 2);
    }

    #[tokio::test]
    async fn test_write_binary_files_writes_binary_data() {
        let temp_dir = setup_test_dir();
        let file = temp_dir
            .path()
            .join("image.png")
            .to_string_lossy()
            .to_string();

        let data = vec![0u8, 1, 2, 3, 255];
        let files = vec![BinaryFileWriteRequest {
            path: file.clone(),
            data: data.clone(),
        }];

        let result = write_binary_files(files).await;

        assert_eq!(result.succeeded.len(), 1);

        let read_data = tokio::fs::read(&file).await.expect("Failed to read file");
        assert_eq!(read_data, data);
    }

    #[tokio::test]
    async fn test_write_binary_files_handles_empty_binary_files() {
        let temp_dir = setup_test_dir();
        let file = temp_dir
            .path()
            .join("empty.bin")
            .to_string_lossy()
            .to_string();

        let files = vec![BinaryFileWriteRequest {
            path: file.clone(),
            data: vec![],
        }];

        let result = write_binary_files(files).await;

        assert_eq!(result.succeeded.len(), 1);

        let read_data = tokio::fs::read(&file).await.expect("Failed to read file");
        assert!(read_data.is_empty());
    }

    #[tokio::test]
    async fn test_write_binary_files_returns_failed_array_for_errors() {
        let invalid_file = "/nonexistent/invalid/file.bin".to_string();

        let files = vec![BinaryFileWriteRequest {
            path: invalid_file.clone(),
            data: vec![1],
        }];

        let result = write_binary_files(files).await;

        assert!(result.succeeded.is_empty());
        assert_eq!(result.failed.len(), 1);
    }
}
