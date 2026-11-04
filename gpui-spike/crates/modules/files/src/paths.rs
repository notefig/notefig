//! Path helpers every file-facing module agrees on: a port of the parts of
//! `utils/path.ts` the files layer uses. Paths are absolute and native;
//! the tree domain (relative paths) is always `/`-separated.

use std::path::{Component, Path};

/// The tree-domain (`/`-separated) path of `absolute` relative to `root`:
/// `""` for the root itself, `None` when outside it — component-wise, so a
/// sibling `/ws-backup` is not inside `/ws`.
pub fn relative_tree_path(root: &str, absolute: &str) -> Option<String> {
    let rel = Path::new(absolute).strip_prefix(Path::new(root)).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// `root` joined with a tree-domain relative path.
pub fn from_tree_path(root: &str, rel: &str) -> String {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return root.to_string();
    }
    let mut out = std::path::PathBuf::from(root);
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        out.push(part);
    }
    out.to_string_lossy().into_owned()
}

/// Join a native directory and a name.
pub fn join(dir: &str, name: &str) -> String {
    Path::new(dir).join(name).to_string_lossy().into_owned()
}

/// The directory holding `path` (itself for a root).
pub fn dirname(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The last component of a native path.
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
}

/// Collapse duplicate and trailing separators (`/ws/` and `/ws` are one
/// workspace).
pub fn normalize(path: &str) -> String {
    let p = Path::new(path);
    let mut out = std::path::PathBuf::new();
    for c in p.components() {
        out.push(c.as_os_str());
    }
    let s = out.to_string_lossy().into_owned();
    if s.is_empty() { path.to_string() } else { s }
}

/// THE key for anything keyed by a workspace path (`workspaceKey`):
/// normalized; identity on posix.
pub fn workspace_key(workspace_path: &str) -> String {
    normalize(workspace_path)
}

/// The lowercased extension of a name or path, `""` when there is none.
pub fn extension(path: &str) -> String {
    let name = basename(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_lowercase(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_tree_paths() {
        assert_eq!(relative_tree_path("/ws", "/ws").as_deref(), Some(""));
        assert_eq!(relative_tree_path("/ws", "/ws/a/b.md").as_deref(), Some("a/b.md"));
        assert_eq!(relative_tree_path("/ws", "/ws-backup/a.md"), None);
        assert_eq!(from_tree_path("/ws", "a/b.md/"), "/ws/a/b.md");
        assert_eq!(basename("/ws/a/b.md"), "b.md");
        assert_eq!(dirname("/ws/a/b.md"), "/ws/a");
        assert_eq!(normalize("/ws//a/"), "/ws/a");
        assert_eq!(extension("/x/README.MD"), "md");
        assert_eq!(extension("/x/.env"), "");
    }
}
