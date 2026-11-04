//! Ignore rules, ported from the TS app (`utils/ignore.ts`) and the Tauri
//! walker (`walkdir_utils.rs`). A denylist: unknown and extensionless files
//! stay visible.

/// The app's own directory inside a workspace. It is not hidden, but only
/// its `scratchpads` child is surfaced.
pub const APP_DIR_NAME: &str = ".notefig";
pub const APP_VISIBLE_CHILD_NAME: &str = "scratchpads";

pub const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    "bower_components",
    "vendor",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    "venv",
    "pods",
    "deriveddata",
];

pub const IGNORED_EXTENSIONS: &[&str] = &[
    "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", // archives
    "exe", "dll", "so", "dylib", "o", "a", "class", "pyc", "wasm", "jar", // binaries
    "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "ogg", "m4a", // media
    "ttf", "otf", "woff", "woff2", "eot", // fonts
    "iso", "dmg", "pkg", "deb", "rpm", "db", "sqlite", "sqlite3", "bin", "dat", // images, dbs
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "psd", "ai", "sketch", // office
    "tmp",
];

pub fn is_ignored_directory(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORED_DIRECTORIES.contains(&lower.as_str())
}

pub fn is_ignored_file(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            IGNORED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// Whether `name`, a child of the directory named `parent`, counts as
/// hidden: dot-named (except the app dir), or any child of the app dir other
/// than the scratchpads folder.
pub fn is_hidden_child(parent: Option<&str>, name: &str) -> bool {
    if parent == Some(APP_DIR_NAME) {
        return name != APP_VISIBLE_CHILD_NAME;
    }
    name.starts_with('.') && name.len() > 1 && name != APP_DIR_NAME
}

/// Whether a workspace-relative path (`a/b/c.md`) is excluded from the tree:
/// a hidden component, an ignored directory component, or an ignored
/// extension on the last component.
pub fn is_ignored_rel(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    let Some(last) = parts.last() else {
        return false;
    };
    let mut parent: Option<&str> = None;
    for (i, part) in parts.iter().enumerate() {
        if is_hidden_child(parent, part) {
            return true;
        }
        if i + 1 < parts.len() && is_ignored_directory(part) {
            return true;
        }
        parent = Some(part);
    }
    // The last component could be an ignored directory or file; callers that
    // know it is a directory use `is_ignored_directory` directly.
    is_ignored_directory(last) || is_ignored_file(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_and_app_dir() {
        assert!(is_ignored_rel(".git/config"));
        assert!(is_ignored_rel(".vscode"));
        assert!(!is_ignored_rel(".notefig"));
        assert!(!is_ignored_rel(".notefig/scratchpads/a.md"));
        assert!(is_ignored_rel(".notefig/state.json"));
        assert!(is_ignored_rel("docs/.hidden.md"));
    }

    #[test]
    fn denylist() {
        assert!(is_ignored_rel("node_modules/x/index.js"));
        assert!(is_ignored_rel("app/Pods/x"));
        assert!(is_ignored_rel("a/b.ZIP"));
        assert!(!is_ignored_rel("LICENSE"));
        assert!(!is_ignored_rel("notes/build-log.md"));
        assert!(!is_ignored_rel("notes/readme.md"));
    }
}
