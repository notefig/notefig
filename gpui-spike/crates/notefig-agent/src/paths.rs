//! Workspace containment for harness-supplied paths
//! (`acp-file-system.ts` / `resolveWorkspacePath`): relative paths resolve
//! against the root; anything that lands outside it (`../`, an absolute
//! path elsewhere, a sibling sharing the root's name) is refused.

use std::path::{Component, Path, PathBuf};

/// Lexically normalize (`.`/`..`), without touching the disk.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `(absolute, workspace-relative)` for a path inside the workspace.
pub fn resolve_workspace_path(workspace: &Path, target: &str) -> Result<(PathBuf, String), String> {
    if target.is_empty() {
        return Err("path is empty".into());
    }
    let root = normalize(workspace);
    let candidate = Path::new(target);
    let absolute = normalize(&if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    });
    match absolute.strip_prefix(&root) {
        Ok(relative) => Ok((
            absolute.clone(),
            relative.to_string_lossy().replace('\\', "/"),
        )),
        Err(_) => Err(format!("path is outside the workspace: {target}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment() {
        let ws = Path::new("/ws");
        assert_eq!(
            resolve_workspace_path(ws, "a/b.md").unwrap(),
            (PathBuf::from("/ws/a/b.md"), "a/b.md".into())
        );
        assert_eq!(resolve_workspace_path(ws, "/ws/./x.md").unwrap().1, "x.md");
        assert!(resolve_workspace_path(ws, "../etc/passwd").is_err());
        assert!(resolve_workspace_path(ws, "/ws-backup/x").is_err());
        assert!(resolve_workspace_path(ws, "/etc/passwd").is_err());
        assert!(resolve_workspace_path(ws, "a/../../x").is_err());
    }
}
