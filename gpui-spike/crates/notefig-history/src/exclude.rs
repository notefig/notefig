//! Managed writes to a gitdir's `info/exclude` (git-exclude.ts).
use std::path::Path;

use crate::{HistoryError, Result};

/// Ensure every line is present in `<git_dir>/info/exclude`, appending only
/// the missing ones; existing (user-authored) content is never rewritten or
/// reordered. Creates the file if missing. A read failure other than "not
/// found" is an error: treating it as empty would destroy user patterns.
pub fn ensure_exclude_lines(git_dir: &Path, lines: &[&str]) -> Result<()> {
    let path = git_dir.join("info").join("exclude");
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(HistoryError::io(format!("Failed to read '{}'", path.display()), error)),
    };
    let present: std::collections::HashSet<&str> = current.split('\n').map(str::trim).collect();
    let missing: Vec<&str> = lines.iter().copied().filter(|line| !present.contains(line)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut next = current.clone();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&missing.join("\n"));
    next.push('\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| HistoryError::io(format!("Failed to update '{}'", path.display()), e))?;
    }
    crate::gix_repo::write_atomic(&path, next.as_bytes())
        .map_err(|e| HistoryError::io(format!("Failed to update '{}'", path.display()), e))
}
