//! `FileSystemSurface`.

use futures::future::LocalBoxFuture;
use serde::{Deserialize, Serialize};

use notefig_core::Subscription;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsErrorKind {
    NotFound,
    PermissionDenied,
    HandleMissing,
    AlreadyExists,
    InvalidPath,
    NotEmpty,
    IsDirectory,
    IsFile,
    IoError,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsError {
    pub kind: FsErrorKind,
    pub path: String,
    pub message: String,
}

impl FsError {
    pub fn new(kind: FsErrorKind, path: impl Into<String>) -> Self {
        let path = path.into();
        let message = format!("{}: {path}", format!("{kind:?}").to_lowercase());
        Self { kind, path, message }
    }

    pub fn from_io(err: &std::io::Error, path: impl Into<String>) -> Self {
        use std::io::ErrorKind as K;
        let kind = match err.kind() {
            K::NotFound => FsErrorKind::NotFound,
            K::PermissionDenied => FsErrorKind::PermissionDenied,
            K::AlreadyExists => FsErrorKind::AlreadyExists,
            K::DirectoryNotEmpty => FsErrorKind::NotEmpty,
            K::IsADirectory => FsErrorKind::IsDirectory,
            K::NotADirectory => FsErrorKind::IsFile,
            K::InvalidInput | K::InvalidFilename => FsErrorKind::InvalidPath,
            _ => FsErrorKind::IoError,
        };
        let path = path.into();
        Self {
            kind,
            message: format!("{err}: {path}"),
            path,
        }
    }

    /// The workspace's folder went away or lost permission.
    pub fn is_workspace_access_error(&self) -> bool {
        matches!(self.kind, FsErrorKind::PermissionDenied | FsErrorKind::HandleMissing)
    }
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FsError {}

pub type FsResult<T> = Result<T, FsError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub path: String,
    pub kind: EntryType,
}

/// What succeeded and what failed, per path.
#[derive(Debug, Clone)]
pub struct BatchResult<T> {
    pub succeeded: Vec<T>,
    pub failed: Vec<FsError>,
}

impl<T> Default for BatchResult<T> {
    fn default() -> Self {
        Self { succeeded: Vec::new(), failed: Vec::new() }
    }
}

#[derive(Debug, Clone)]
pub struct FileMetadata {
    pub path: String,
    pub kind: EntryType,
    pub size: u64,
    pub modified_ms: u64,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IgnoreRules {
    pub directories: Vec<String>,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ReadDirectoryOptions {
    pub recursive: bool,
    pub include_files: bool,
    pub include_directories: bool,
    pub include_hidden: bool,
    pub ignore: Option<IgnoreRules>,
}

impl ReadDirectoryOptions {
    pub fn all_recursive() -> Self {
        Self {
            recursive: true,
            include_files: true,
            include_directories: true,
            include_hidden: false,
            ignore: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataChangeKind {
    Created,
    Deleted,
    Renamed { old_path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataChange {
    pub kind: MetadataChangeKind,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentChange {
    pub path: String,
    pub content: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsChangeEvent {
    Metadata { watch_id: String, changes: Vec<MetadataChange> },
    Content { watch_id: String, changes: Vec<ContentChange> },
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub query: String,
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub file_pattern: Option<String>,
    pub file_includes: Vec<String>,
    pub max_results: Option<usize>,
    pub ignore: Option<IgnoreRules>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMatch {
    pub file_path: String,
    pub match_text: String,
    pub line_text: String,
    /// 1-based line.
    pub line: u32,
    /// Which occurrence of `match_text` in the file this is (0-based).
    pub occurrence: u32,
}

/// `FileSystemSurface`. Every call is async so a browser backend fits.
pub trait FileSystem {
    fn read_directory(&self, path: &str, options: ReadDirectoryOptions) -> LocalBoxFuture<'static, FsResult<Vec<DirectoryEntry>>>;
    fn create_directories(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>>;
    /// To the OS trash where there is one.
    fn delete_directories(&self, paths: Vec<String>, recursive: bool) -> LocalBoxFuture<'static, BatchResult<String>>;
    fn move_directory(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>>;
    fn read_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<(String, String)>>;
    fn read_binary_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<(String, Vec<u8>)>>;
    fn write_files(&self, files: Vec<(String, String)>) -> LocalBoxFuture<'static, BatchResult<String>>;
    fn write_binary_files(&self, files: Vec<(String, Vec<u8>)>) -> LocalBoxFuture<'static, BatchResult<String>>;
    /// Create empty files; fails per path that exists.
    fn create_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>>;
    /// To the OS trash where there is one.
    fn delete_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>>;
    fn move_file(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>>;
    fn copy_file(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>>;
    fn exists(&self, paths: Vec<String>) -> LocalBoxFuture<'static, Vec<(String, Option<EntryType>)>>;
    fn metadata(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<FileMetadata>>;
    /// Watch `paths` (recursively): metadata changes, and content changes
    /// for files the caller marks with [`FileSystem::watch_content`].
    /// Events from this watch carry `watch_id`; the platform suppresses the
    /// echo of its own writes. Dropping the subscription stops it.
    fn watch(
        &self,
        paths: Vec<String>,
        watch_id: &str,
        ignore: Option<IgnoreRules>,
        listener: std::rc::Rc<dyn Fn(&FsChangeEvent)>,
    ) -> LocalBoxFuture<'static, FsResult<Subscription>>;
    /// Ask a running watch to report content changes for these files.
    fn watch_content(&self, watch_id: &str, paths: Vec<String>);
    /// Search file contents under `directory`. Matches stream to `on_match`
    /// in file order; resolves when done.
    fn search_content(
        &self,
        directory: &str,
        options: SearchOptions,
        on_match: Box<dyn FnMut(SearchMatch)>,
    ) -> LocalBoxFuture<'static, FsResult<()>>;
    /// A URL or path an image element can load (`resolveAssetUrl`).
    fn resolve_asset(&self, relative: &str, workspace: &str) -> String;
}

/// The content hash the TS app uses (md5 hex) — shared so every backend and
/// module agrees on echo detection.
pub fn content_hash(content: &str) -> String {
    md5_hex(content.as_bytes())
}

// A small md5 so this crate stays dependency-light (and wasm-clean).
fn md5_hex(input: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
        14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
        21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    let mut msg = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    for chunk in msg.chunks(64) {
        let m: Vec<u32> = chunk.chunks(4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])).collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(S[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    [a0, b0, c0, d0]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn md5_matches_known_vectors() {
        assert_eq!(super::content_hash(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(super::content_hash("hello"), "5d41402abc4b2a76b9719d911017c592");
    }
}
