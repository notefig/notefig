use crate::file_watcher::{compute_content_hash, register_app_write};
use crate::walkdir_utils::{
    has_ignored_extension, is_hidden_relative_to, matches_exclude_pattern, walk_directory,
    WalkOptions,
};
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

/// A listing entry with the type the walk already knows — callers used to
/// re-derive file-vs-directory with a second stat pass (or a second whole
/// walk) because this returned bare paths.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DirectoryEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: DirectoryEntryType,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DirectoryEntryType {
    File,
    Directory,
}

impl DirectoryEntry {
    fn new(path: String, is_dir: bool) -> Self {
        Self {
            path,
            entry_type: if is_dir {
                DirectoryEntryType::Directory
            } else {
                DirectoryEntryType::File
            },
        }
    }
}

/// Ignore filtering is opt-in per call: the frontend passes its ignore
/// config (utils/ignore.ts) only for workspace listings. Callers that must
/// see the complete tree — notably the git storage host — pass nothing and
/// get today's unfiltered behavior.
#[tauri::command]
pub async fn read_directory(
    path: String,
    recursive: bool,
    include_files: bool,
    include_directories: bool,
    include_hidden: bool,
    ignore_directories: Option<Vec<String>>,
    ignore_extensions: Option<Vec<String>>,
) -> Result<Vec<DirectoryEntry>> {
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
    let ignore_directories = ignore_directories.unwrap_or_default();
    let ignore_extensions = ignore_extensions.unwrap_or_default();

    if recursive {
        let options = WalkOptions {
            follow_links: true,
            exclude_hidden: !include_hidden,
            exclude_patterns: ignore_directories,
            base_path: path_buf.clone(),
        };

        if let Err(e) = walk_directory(&path_buf, &options, |entry| {
            let entry_path = entry.path();
            // walkdir caches the readdir file type (the followed target's
            // type under follow_links) — no extra stat.
            let is_dir = entry.file_type().is_dir();

            if !is_dir && has_ignored_extension(entry_path, &ignore_extensions) {
                return Ok(());
            }

            if (is_dir && include_directories) || (!is_dir && include_files) {
                results.push(DirectoryEntry::new(
                    entry_path.to_string_lossy().to_string(),
                    is_dir,
                ));
            }

            Ok(())
        }) {
            return Result::err(path, FileSystemErrorType::IoError, e);
        }
    } else {
        match fs::read_dir(&path_buf).await {
            Ok(mut entries) => {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let entry_path = entry.path();

                    if !include_hidden && is_hidden_relative_to(&entry_path, &path_buf) {
                        continue;
                    }

                    let entry_name = entry.file_name().to_string_lossy().to_lowercase();
                    if ignore_directories
                        .iter()
                        .any(|p| matches_exclude_pattern(&entry_name, p))
                    {
                        continue;
                    }

                    // readdir already knows the entry type; stat only symlinks
                    // (is_dir() classifies by the followed target's type).
                    let is_dir = match entry.file_type().await {
                        Ok(ft) if !ft.is_symlink() => ft.is_dir(),
                        _ => fs::metadata(&entry_path)
                            .await
                            .map(|m| m.is_dir())
                            .unwrap_or(false),
                    };
                    if !is_dir && has_ignored_extension(&entry_path, &ignore_extensions) {
                        continue;
                    }

                    if (is_dir && include_directories) || (!is_dir && include_files) {
                        results.push(DirectoryEntry::new(
                            entry_path.to_string_lossy().to_string(),
                            is_dir,
                        ));
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

/// Raw-body text read: the file's UTF-8 bytes ride Tauri's raw IPC channel
/// (the frontend decodes with TextDecoder) — no JSON string escape/parse of
/// document content. `read_to_string` keeps the old command's UTF-8
/// validation: invalid UTF-8 is an io error, never silently replaced.
#[tauri::command]
pub async fn read_file(
    path: String,
) -> std::result::Result<tauri::ipc::Response, FileSystemError> {
    match fs::read_to_string(&path).await {
        Ok(content) => Ok(tauri::ipc::Response::new(content.into_bytes())),
        Err(err) => Err(map_io_error(&path, err)),
    }
}

/// Raw-body binary read: the file's bytes ride Tauri's raw IPC channel as an
/// `ArrayBuffer` — no JSON `number[]` encode/parse of the payload (the old
/// batch command serialized a 10MB packfile as ~35MB of JSON text the webview
/// then parsed on its main thread). Errors reject the invoke with the
/// serialized `FileSystemError`.
#[tauri::command]
pub async fn read_binary_file(
    path: String,
) -> std::result::Result<tauri::ipc::Response, FileSystemError> {
    match fs::read(&path).await {
        Ok(data) => Ok(tauri::ipc::Response::new(data)),
        Err(err) => Err(map_io_error(&path, err)),
    }
}

#[derive(Deserialize)]
pub struct FileToWrite {
    pub path: String,
    pub content: String,
}

/// One text-file write — the engine `write_file` and `create_files` share:
/// parents ensured, watcher-echo registered BEFORE the write (the race
/// guard), then the atomic temp+rename.
async fn write_text_file(
    path: String,
    content: String,
) -> std::result::Result<String, FileSystemError> {
    let path_buf = PathBuf::from(&path);

    if let Err(err) = ensure_parent_dir(&path_buf).await {
        return Err(map_io_error(&path, err));
    }

    // Register write before writing to prevent race condition with watcher
    let hash = compute_content_hash(&content);
    register_app_write(path.clone(), hash);

    match atomic_write(&path_buf, &content).await {
        Ok(_) => Ok(path),
        Err(err) => Err(map_io_error(&path, err)),
    }
}

/// Raw-body text write: the document's UTF-8 bytes ride Tauri's raw IPC
/// channel (no JSON string escape of content per autosave), destination
/// path in the percent-encoded header.
#[tauri::command]
pub async fn write_file(
    request: RawRequest,
) -> std::result::Result<String, FileSystemError> {
    let path = raw_request_path(&request)?;
    let content = String::from_utf8(request.body).map_err(|_| FileSystemError {
        path: path.clone(),
        error_type: FileSystemErrorType::IoError,
        message: "write_file body is not valid UTF-8".to_string(),
    })?;
    write_text_file(path, content).await
}

/// Batch engine for `create_files`; not a command (the frontend writes
/// documents through `write_file`'s raw body).
async fn write_files(files: Vec<FileToWrite>) -> BatchResult<String> {
    let mut result = BatchResult::new();

    let tasks: Vec<_> = files
        .into_iter()
        .map(|file| write_text_file(file.path, file.content))
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

/// Renames that replace an existing destination transiently fail on Windows
/// with ERROR_SHARING_VIOLATION when AV/indexer/our own watcher briefly
/// holds a handle on it (flagged in the MET-157 spike, MET-158). Bounded
/// retry with backoff rather than surfacing a spurious save failure.
const ATOMIC_RENAME_MAX_ATTEMPTS: u32 = 5;

async fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    // Append ".tmp" to the whole file name rather than replacing the
    // extension (`with_extension`): "note.md" and "note.txt" both mapped to
    // "note.tmp" there, so concurrent saves of sibling files sharing a stem
    // could stomp each other's temp file.
    let mut temp_name = path
        .file_name()
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no file name")
        })?
        .to_os_string();
    temp_name.push(".tmp");
    let temp_path = path.with_file_name(temp_name);

    let mut file = fs::File::create(&temp_path).await?;
    file.write_all(content.as_bytes()).await?;
    file.sync_all().await?;
    drop(file);

    for attempt in 1..=ATOMIC_RENAME_MAX_ATTEMPTS {
        match fs::rename(&temp_path, path).await {
            Ok(()) => return Ok(()),
            Err(err) if attempt < ATOMIC_RENAME_MAX_ATTEMPTS => {
                eprintln!(
                    "atomic_write: rename attempt {attempt}/{ATOMIC_RENAME_MAX_ATTEMPTS} failed for {}: {err}",
                    path.display()
                );
                tokio::time::sleep(std::time::Duration::from_millis(30 * attempt as u64)).await;
            }
            Err(err) => return Err(err),
        }
    }

    unreachable!("loop always returns by the last attempt")
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

/// Header carrying the destination path for raw-body writes,
/// percent-encoded (HTTP header values must be ASCII; paths need not be).
pub const WRITE_BINARY_PATH_HEADER: &str = "x-notefig-path";

/// Owned raw invoke body + headers. Tauri's own `ipc::Request` borrows the
/// invoke message, which forces raw-body commands to be sync — and sync
/// commands run their file IO on the IPC thread. This extractor pays one
/// memcpy of the payload to keep raw-body commands async like every other
/// fs command (`CommandItem.message` and its accessors are public API).
pub struct RawRequest {
    pub body: Vec<u8>,
    pub headers: tauri::http::HeaderMap,
}

impl<'a, R: tauri::Runtime> tauri::ipc::CommandArg<'a, R> for RawRequest {
    fn from_command(
        command: tauri::ipc::CommandItem<'a, R>,
    ) -> std::result::Result<Self, tauri::ipc::InvokeError> {
        match command.message.payload() {
            tauri::ipc::InvokeBody::Raw(data) => Ok(Self {
                body: data.clone(),
                headers: command.message.headers().clone(),
            }),
            tauri::ipc::InvokeBody::Json(_) => Err(tauri::ipc::InvokeError(
                serde_json::Value::String(format!(
                    "command {} requires a raw request body",
                    command.name
                )),
            )),
        }
    }
}

/// The percent-decoded destination path of a raw-body write request.
fn raw_request_path(request: &RawRequest) -> std::result::Result<String, FileSystemError> {
    let invalid = |message: &str| FileSystemError {
        path: String::new(),
        error_type: FileSystemErrorType::InvalidPath,
        message: message.to_string(),
    };
    let encoded = request
        .headers
        .get(WRITE_BINARY_PATH_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| invalid("raw write requires the path header"))?;
    percent_decode(encoded)
        .ok_or_else(|| invalid("raw write path header is not valid percent-encoded UTF-8"))
}

/// Core of `write_binary_file`, separated so tests can exercise it without
/// constructing a `tauri::ipc::Request`. Same semantics as the old batch
/// write: parents created, plain write (no watcher-echo registration —
/// binary writes never carried one).
pub fn write_binary_file_impl(
    path: &str,
    data: &[u8],
) -> std::result::Result<String, FileSystemError> {
    let path_buf = PathBuf::from(path);
    if let Some(parent) = path_buf.parent() {
        if !parent.exists() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                return Err(map_io_error(path, err));
            }
        }
    }
    match std::fs::write(&path_buf, data) {
        Ok(()) => Ok(path.to_string()),
        Err(err) => Err(map_io_error(path, err)),
    }
}

/// Raw-body binary write: bytes arrive on Tauri's raw IPC channel (no JSON
/// `number[]`), destination path in a percent-encoded header.
#[tauri::command]
pub async fn write_binary_file(
    request: RawRequest,
) -> std::result::Result<String, FileSystemError> {
    let path = raw_request_path(&request)?;
    write_binary_file_impl(&path, &request.body)
}

/// Minimal percent-decoder for the path header (the frontend encodes with
/// `encodeURIComponent`); returns None on malformed input.
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hi = char::from(hex[0]).to_digit(16)?;
            let lo = char::from(hex[1]).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        tempfile::tempdir().expect("Failed to create temp directory")
    }

    /// A path no platform can create: a child of a regular FILE. The old
    /// "/nonexistent/…" fixtures were creatable on Windows — a leading `/`
    /// is drive-relative there, and the write paths create missing parents,
    /// so the "failure" tests succeeded and failed their assertions.
    fn file_blocked_path(temp_dir: &TempDir, name: &str) -> String {
        let blocker = temp_dir.path().join("blocker-file");
        std::fs::write(&blocker, "x").expect("Failed to write blocker file");
        blocker.join(name).to_string_lossy().to_string()
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

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, "subdir/file2.txt", "content2").await;
        create_test_file(&temp_dir, "subdir/nested/file3.txt", "content3").await;

        let result = read_directory(root_path.clone(), true, true, false, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 3);
            assert!(value.iter().any(|e| e.path.contains("file1.txt")));
            assert!(value.iter().any(|e| e.path.contains("file2.txt")));
            assert!(value.iter().any(|e| e.path.contains("file3.txt")));
        }
    }

    /// MET-135: the app dir (".notefig") is not hidden — it is walked by
    /// default — but only its scratchpads folder is: every other child is
    /// hidden by position, dot-named (".notefig/.git") or not.
    #[tokio::test]
    async fn test_read_directory_walks_app_dir_but_not_its_hidden_children() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "notes.md", "x").await;
        create_test_file(&temp_dir, ".notefig/scratchpads/untitled.md", "x").await;
        create_test_file(&temp_dir, ".notefig/.git/HEAD", "x").await;
        create_test_file(&temp_dir, ".notefig/tasks.json", "x").await;
        create_test_file(&temp_dir, ".git/HEAD", "x").await;

        let result =
            read_directory(root_path.clone(), true, true, false, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().any(|e| e.path.contains("untitled.md")));
            assert!(value.iter().any(|e| e.path.contains("notes.md")));
            assert!(!value.iter().any(|e| e.path.contains("HEAD")));
            assert!(!value.iter().any(|e| e.path.contains("tasks.json")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_lists_files_non_recursively() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, "subdir/file2.txt", "content2").await;

        let result = read_directory(root_path.clone(), false, true, false, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 1);
            assert!(value[0].path.contains("file1.txt"));
        }
    }

    #[tokio::test]
    async fn test_read_directory_applies_ignore_rules_recursively() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "chapter.md", "content").await;
        create_test_file(&temp_dir, "LICENSE", "license").await;
        create_test_file(&temp_dir, "clip.mp4", "video").await;
        create_test_file(&temp_dir, "node_modules/pkg/index.js", "js").await;
        create_test_file(&temp_dir, "docs/dist/out.md", "built").await;

        let ignore_dirs = Some(vec!["node_modules".to_string(), "dist".to_string()]);
        let ignore_exts = Some(vec!["mp4".to_string()]);
        let result = read_directory(
            root_path.clone(),
            true,
            true,
            true,
            false,
            ignore_dirs,
            ignore_exts,
        )
        .await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().any(|e| e.path.contains("chapter.md")));
            // Extensionless files stay tracked (denylist, not allowlist).
            assert!(value.iter().any(|e| e.path.contains("LICENSE")));
            assert!(value.iter().any(|e| e.path.ends_with("docs")));
            assert!(!value.iter().any(|e| e.path.contains("clip.mp4")));
            assert!(!value.iter().any(|e| e.path.contains("node_modules")));
            assert!(!value.iter().any(|e| e.path.contains("dist")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_applies_ignore_rules_non_recursively() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "chapter.md", "content").await;
        create_test_file(&temp_dir, "archive.ZIP", "zip").await;
        create_test_file(&temp_dir, "node_modules/pkg/index.js", "js").await;

        let ignore_dirs = Some(vec!["node_modules".to_string()]);
        let ignore_exts = Some(vec!["zip".to_string()]);
        let result = read_directory(
            root_path.clone(),
            false,
            true,
            true,
            false,
            ignore_dirs,
            ignore_exts,
        )
        .await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 1);
            assert!(value[0].path.contains("chapter.md"));
        }
    }

    #[tokio::test]
    async fn test_read_directory_without_ignore_args_is_unfiltered() {
        // The git storage host path: no ignore args ⇒ complete listing.
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "node_modules/pkg/index.js", "js").await;
        create_test_file(&temp_dir, "clip.mp4", "video").await;

        let result = read_directory(root_path.clone(), true, true, true, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().any(|e| e.path.contains("index.js")));
            assert!(value.iter().any(|e| e.path.contains("clip.mp4")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_filters_hidden_files() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, ".hidden.txt", "hidden").await;
        create_test_file(&temp_dir, ".git/config", "git config").await;

        let result = read_directory(root_path.clone(), true, true, true, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().any(|e| e.path.contains("file1.txt")));
            assert!(!value.iter().any(|e| e.path.contains(".hidden.txt")));
            assert!(!value.iter().any(|e| e.path.contains(".git")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_includes_hidden_files_when_requested() {
        let temp_dir = setup_test_dir();
        let root_path = temp_dir.path().to_string_lossy().to_string();

        create_test_file(&temp_dir, "file1.txt", "content1").await;
        create_test_file(&temp_dir, ".hidden.txt", "hidden").await;
        create_test_file(&temp_dir, ".git/config", "git config").await;

        let result = read_directory(root_path.clone(), true, true, true, true, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().any(|e| e.path.contains("file1.txt")));
            assert!(value.iter().any(|e| e.path.contains(".hidden.txt")));
            assert!(value.iter().any(|e| e.path.contains(".git")));
        }
    }

    #[tokio::test]
    async fn test_read_directory_handles_paths_with_trailing_slashes() {
        let temp_dir = setup_test_dir();
        let mut root_path = temp_dir.path().to_string_lossy().to_string();
        root_path.push('/');

        create_test_file(&temp_dir, "file1.txt", "content1").await;

        let result = read_directory(root_path, false, true, false, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert_eq!(value.len(), 1);
        }
    }

    #[tokio::test]
    async fn test_read_directory_returns_error_for_invalid_workspace_path() {
        let result = read_directory("".to_string(), false, true, true, false, None, None).await;

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

        let result = read_directory(root_path.clone(), false, true, false, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().all(|e| !e.path.contains("subdir")));
            assert!(value.iter().any(|e| e.path.contains("file1.txt")));
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

        let result = read_directory(root_path.clone(), false, false, true, false, None, None).await;

        assert!(matches!(result, Result::Ok { .. }));
        if let Result::Ok { value, .. } = result {
            assert!(value.iter().all(|e| !e.path.contains("file1.txt")));
            assert!(value.iter().any(|e| e.path.contains("subdir")));
        }
    }

    // ========== read_files Tests ==========

    #[tokio::test]
    async fn test_read_file_returns_raw_utf8_bytes() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};

        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "file1.txt", "content1").await;

        let response = read_file(file1).await.expect("read should succeed");
        match response.body().expect("response body") {
            InvokeResponseBody::Raw(data) => assert_eq!(data, b"content1".to_vec()),
            InvokeResponseBody::Json(_) => panic!("expected a raw body"),
        }
    }

    #[tokio::test]
    async fn test_read_file_rejects_missing_path_with_typed_error() {
        let temp_dir = setup_test_dir();
        let missing_file = temp_dir
            .path()
            .join("missing.txt")
            .to_string_lossy()
            .to_string();

        let err = match read_file(missing_file.clone()).await {
            Ok(_) => panic!("read should fail"),
            Err(err) => err,
        };

        assert_eq!(err.path, missing_file);
        assert!(matches!(err.error_type, FileSystemErrorType::NotFound));
    }

    #[tokio::test]
    async fn test_read_file_rejects_invalid_utf8() {
        let temp_dir = setup_test_dir();
        let path = temp_dir.path().join("bad.bin");
        tokio::fs::write(&path, [0xffu8, 0xfe, 0xfd])
            .await
            .expect("write");

        let result = read_file(path.to_string_lossy().to_string()).await;
        assert!(result.is_err(), "invalid UTF-8 must stay an error");
    }

    #[tokio::test]
    async fn test_read_file_returns_empty_body_for_empty_files() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};

        let temp_dir = setup_test_dir();
        let file1 = create_test_file(&temp_dir, "empty.txt", "").await;

        let response = read_file(file1).await.expect("read should succeed");
        match response.body().expect("response body") {
            InvokeResponseBody::Raw(data) => assert!(data.is_empty()),
            InvokeResponseBody::Json(_) => panic!("expected a raw body"),
        }
    }

    #[tokio::test]
    async fn test_read_binary_file_returns_raw_bytes() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};

        let temp_dir = setup_test_dir();
        let file_path = temp_dir.path().join("file1.bin");
        tokio::fs::write(&file_path, vec![1u8, 2, 3])
            .await
            .expect("Failed to write binary file");

        let response = read_binary_file(file_path.to_string_lossy().to_string())
            .await
            .expect("read should succeed");

        match response.body().expect("response body") {
            InvokeResponseBody::Raw(data) => assert_eq!(data, vec![1u8, 2, 3]),
            InvokeResponseBody::Json(_) => panic!("expected a raw body"),
        }
    }

    #[tokio::test]
    async fn test_read_binary_file_rejects_missing_path_with_typed_error() {
        let temp_dir = setup_test_dir();
        let missing = temp_dir
            .path()
            .join("missing.bin")
            .to_string_lossy()
            .to_string();

        let err = match read_binary_file(missing.clone()).await {
            Ok(_) => panic!("read should fail"),
            Err(err) => err,
        };

        assert_eq!(err.path, missing);
        assert!(matches!(err.error_type, FileSystemErrorType::NotFound));
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

    /// MET-158: atomic_write's old temp name (`path.with_extension("tmp")`)
    /// mapped "note.md" and "note.txt" to the same "note.tmp", so writing
    /// both concurrently could stomp one temp file with the other's
    /// content. The temp name now appends to the whole file name instead.
    #[tokio::test]
    async fn test_write_files_does_not_collide_on_shared_stem() {
        let temp_dir = setup_test_dir();
        let md_path = temp_dir.path().join("note.md").to_string_lossy().to_string();
        let txt_path = temp_dir.path().join("note.txt").to_string_lossy().to_string();

        let files = vec![
            FileToWrite {
                path: md_path.clone(),
                content: "markdown content".to_string(),
            },
            FileToWrite {
                path: txt_path.clone(),
                content: "plain text content".to_string(),
            },
        ];

        let result = write_files(files).await;

        assert_eq!(result.succeeded.len(), 2);
        assert!(result.failed.is_empty());
        assert_eq!(
            tokio::fs::read_to_string(&md_path).await.unwrap(),
            "markdown content"
        );
        assert_eq!(
            tokio::fs::read_to_string(&txt_path).await.unwrap(),
            "plain text content"
        );
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
        let temp_dir = setup_test_dir();
        let invalid_file = file_blocked_path(&temp_dir, "file.txt");

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
        let temp_dir = setup_test_dir();
        let invalid_dir = file_blocked_path(&temp_dir, "subdir");

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
    async fn test_write_binary_file_writes_binary_data_creating_parents() {
        let temp_dir = setup_test_dir();
        let file = temp_dir
            .path()
            .join("nested/dir/image.png")
            .to_string_lossy()
            .to_string();

        let data = vec![0u8, 1, 2, 3, 255];
        write_binary_file_impl(&file, &data).expect("write should succeed");

        let read_data = tokio::fs::read(&file).await.expect("Failed to read file");
        assert_eq!(read_data, data);
    }

    #[tokio::test]
    async fn test_write_binary_file_handles_empty_body() {
        let temp_dir = setup_test_dir();
        let file = temp_dir
            .path()
            .join("empty.bin")
            .to_string_lossy()
            .to_string();

        write_binary_file_impl(&file, &[]).expect("write should succeed");

        let read_data = tokio::fs::read(&file).await.expect("Failed to read file");
        assert!(read_data.is_empty());
    }

    #[tokio::test]
    async fn test_write_binary_file_returns_typed_error() {
        let temp_dir = setup_test_dir();
        let invalid_file = file_blocked_path(&temp_dir, "file.bin");

        let err = write_binary_file_impl(&invalid_file, &[1]).expect_err("write should fail");

        assert_eq!(err.path, invalid_file);
    }

    #[test]
    fn test_percent_decode_round_trips_unicode_paths() {
        // Mirror of the frontend's encodeURIComponent for a non-ASCII path.
        assert_eq!(
            percent_decode("%2Fws%2Fd%C3%A9j%C3%A0%20vu.bin").as_deref(),
            Some("/ws/déjà vu.bin")
        );
        assert_eq!(percent_decode("plain-ascii"), Some("plain-ascii".to_string()));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%2"), None);
    }
}
