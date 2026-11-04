use std::fmt;

/// `GitErrorCode` from types.ts, restricted to what the history repo can
/// produce, plus `Io` for filesystem failures (TS: a separate fs boundary
/// error kind).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum HistoryErrorCode {
    /// No history repo (no `HEAD`/`config` in the gitdir), or a missing
    /// object/path/revision.
    RepoNotFound,
    /// A revert would overwrite changes made since the reverted commit.
    MergeRequired,
    /// Another writer holds `index.lock` or a ref lock (real git locks now).
    LockUnavailable,
    /// Anything gix could not read or write.
    CorruptRepository,
    /// Bad caller input (empty message, reverting the root commit...).
    InvalidInput,
    /// Worktree I/O failed.
    Io,
    /// Anything else (TS `"Unknown"`: a plain `Error` flattened to data),
    /// such as a call on a workspace's history after it closed.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryError {
    pub code: HistoryErrorCode,
    pub message: String,
}

pub type Result<T, E = HistoryError> = std::result::Result<T, E>;

impl HistoryError {
    pub fn new(code: HistoryErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new(HistoryErrorCode::RepoNotFound, message)
    }
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(HistoryErrorCode::InvalidInput, message)
    }
    /// A gix failure: lock contention becomes `LockUnavailable`, the rest
    /// `CorruptRepository`.
    pub(crate) fn git(context: &str, error: impl fmt::Display) -> Self {
        let text = format!("{context}: {error:#}");
        let lower = text.to_lowercase();
        let code = if lower.contains("lock") {
            HistoryErrorCode::LockUnavailable
        } else {
            HistoryErrorCode::CorruptRepository
        };
        Self::new(code, text)
    }
    pub(crate) fn io(context: impl fmt::Display, error: std::io::Error) -> Self {
        Self::new(HistoryErrorCode::Io, format!("{context}: {error}"))
    }
}

impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HistoryError {}
