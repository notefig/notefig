//! App-side ignore rules for workspace scanning: a port of `utils/ignore.ts`.
//! The single source of truth: walks, search and the watcher receive these
//! lists per call ([`ignore_rules`]). A denylist: unknown and extensionless
//! files stay tracked.

use notefig_platform::IgnoreRules;

use crate::paths::{extension, relative_tree_path};

pub const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules", "bower_components", "vendor", "target", "dist", "build", "out", "coverage",
    "__pycache__", "venv", "Pods", "DerivedData",
];

pub const IGNORED_EXTENSIONS: &[&str] = &[
    // Archives
    "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
    // Executables / build objects
    "exe", "dll", "so", "dylib", "o", "a", "class", "pyc", "wasm", "jar",
    // Audio / video
    "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "ogg", "m4a",
    // Fonts
    "ttf", "otf", "woff", "woff2", "eot",
    // Disk images / packages / databases
    "iso", "dmg", "pkg", "deb", "rpm", "db", "sqlite", "sqlite3", "bin", "dat",
    // Office / design
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "psd", "ai", "sketch",
];

/// `IGNORE_RULES`: the rules every walk, search and watch is handed.
pub static IGNORE_RULES: std::sync::LazyLock<IgnoreRules> = std::sync::LazyLock::new(ignore_rules);

/// `IGNORE_RULES`, as a fresh value: lowercased, as the platform compares them.
pub fn ignore_rules() -> IgnoreRules {
    IgnoreRules {
        directories: IGNORED_DIRECTORIES.iter().map(|d| d.to_lowercase()).collect(),
        extensions: IGNORED_EXTENSIONS.iter().map(|e| e.to_lowercase()).collect(),
    }
}

pub fn is_ignored_directory(name: &str) -> bool {
    let lower = name.to_lowercase();
    IGNORED_DIRECTORIES.iter().any(|d| d.to_lowercase() == lower)
}

/// Extensionless ⇒ false.
pub fn is_ignored_file(path: &str) -> bool {
    let ext = extension(path);
    !ext.is_empty() && IGNORED_EXTENSIONS.contains(&ext.as_str())
}

/// Whether a path is ignored: a component inside `base` names an ignored
/// directory, or the last has an ignored extension. Only components inside
/// the workspace count (it may live under `~/build/my-book`).
pub fn is_ignored_path(path: &str, base: Option<&str>) -> bool {
    let relative = match base {
        Some(base) if path == base => return false,
        Some(base) => relative_tree_path(base, path).unwrap_or_else(|| path.replace('\\', "/")),
        None => path.replace('\\', "/"),
    };
    let components: Vec<&str> = relative.split('/').filter(|c| !c.is_empty()).collect();
    let Some(last) = components.last() else { return false };
    components.iter().any(|c| is_ignored_directory(c)) || is_ignored_file(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_inside_the_base_only() {
        assert!(is_ignored_path("/home/build/book/node_modules/x.md", Some("/home/build/book")));
        assert!(!is_ignored_path("/home/build/book/ch1.md", Some("/home/build/book")));
        assert!(is_ignored_path("/ws/a.ZIP", Some("/ws")));
        assert!(is_ignored_path("/ws/ios/pods/x", Some("/ws")));
        assert!(!is_ignored_path("/ws/LICENSE", Some("/ws")));
    }
}
