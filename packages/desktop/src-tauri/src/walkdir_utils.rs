use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Configuration options for directory traversal
#[derive(Debug, Clone)]
pub struct WalkOptions {
    pub follow_links: bool,
    pub exclude_hidden: bool,
    pub exclude_patterns: Vec<String>,
    /// Base path for relative path calculations (reserved for future use)
    #[allow(dead_code)]
    pub base_path: PathBuf,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            follow_links: true,
            exclude_hidden: true,
            exclude_patterns: vec![],
            base_path: PathBuf::new(),
        }
    }
}

/// The app's own directory is deliberately NOT hidden (MET-135): it holds
/// user-visible scratchpads and appears in the tree. Its dot-named children
/// (.metrists/.git, .metrists/.agent) stay hidden like any other dot path.
/// MET-115 renames this alongside the TS constant (entities/scratchpads.ts).
pub const APP_DIR_NAME: &str = ".metrists";

/// Whether a single path component counts as hidden (dot-named, longer than
/// ".", and not the app's own directory).
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') && name.len() > 1 && name != APP_DIR_NAME
}

/// Check if a path contains any component that starts with a dot (hidden file/directory)
/// Examples: .git, .vscode, .DS_Store, etc.
/// Note: Single dot "." is not considered hidden
pub fn is_hidden_path(path: &Path) -> bool {
    path.components().any(|component| {
        if let std::path::Component::Normal(os_str) = component {
            if let Some(name) = os_str.to_str() {
                return is_hidden_name(name);
            }
        }
        false
    })
}

/// Shared directory traversal with consistent filtering
pub fn walk_directory<F>(path: &Path, options: &WalkOptions, mut callback: F) -> Result<(), String>
where
    F: FnMut(&walkdir::DirEntry) -> Result<(), String>,
{
    let root_canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    let walker = WalkDir::new(path)
        .follow_links(options.follow_links)
        .into_iter()
        .filter_entry(|e| {
            // Always allow the root entry to pass through
            if let Ok(canonical) = e.path().canonicalize() {
                if canonical == root_canonical {
                    return true;
                }
            } else if e.path() == path {
                return true;
            }
            should_traverse_entry(e, options)
        });

    for entry in walker {
        match entry {
            Ok(entry) => {
                if entry.path() == path {
                    continue;
                }
                // Also check canonical path for symlinked roots
                if let Ok(canonical) = entry.path().canonicalize() {
                    if canonical == root_canonical {
                        continue;
                    }
                }

                callback(&entry)?;
            }
            Err(e) => {
                // Log error but continue walking
                eprintln!("Error accessing entry: {}", e);
                continue;
            }
        }
    }

    Ok(())
}

/// Determine if we should traverse into a directory
fn should_traverse_entry(entry: &walkdir::DirEntry, options: &WalkOptions) -> bool {
    let file_name = entry.file_name().to_string_lossy();

    if options.exclude_hidden && is_hidden_name(&file_name) {
        return false;
    }

    // Case-insensitive: patterns arrive lowercased from the frontend ignore
    // config (utils/ignore.ts), and macOS filesystems are case-insensitive.
    let file_name_lower = file_name.to_lowercase();
    for pattern in &options.exclude_patterns {
        if matches_exclude_pattern(&file_name_lower, pattern) {
            return false;
        }
    }

    true
}

/// Whether a path's extension is in the (lowercased) ignore list.
pub fn has_ignored_extension(path: &Path, extensions: &[String]) -> bool {
    if extensions.is_empty() {
        return false;
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext_lower = ext.to_lowercase();
            extensions.iter().any(|e| *e == ext_lower)
        }
        None => false,
    }
}

/// Check if a filename matches an exclude pattern
/// Supports: exact match, prefix*, *suffix, and *contains*
pub fn matches_exclude_pattern(file_name: &str, pattern: &str) -> bool {
    if pattern.starts_with('*') && pattern.ends_with('*') && pattern.len() > 2 {
        // *match* - contains
        let inner = &pattern[1..pattern.len() - 1];
        file_name.contains(inner)
    } else if let Some(prefix) = pattern.strip_suffix('*') {
        // prefix* - starts with
        file_name.starts_with(prefix)
    } else if let Some(suffix) = pattern.strip_prefix('*') {
        // *suffix - ends with
        file_name.ends_with(suffix)
    } else {
        // Exact match
        file_name == pattern
    }
}

/// Check if path is hidden relative to base path
/// This is useful when the base path itself might be in a hidden directory (e.g., temp dirs)
/// but we only want to filter based on hidden components within the workspace
pub fn is_hidden_relative_to(path: &Path, base: &Path) -> bool {
    if let Ok(relative) = path.strip_prefix(base) {
        relative.components().any(|component| {
            if let std::path::Component::Normal(os_str) = component {
                if let Some(name) = os_str.to_str() {
                    return is_hidden_name(name);
                }
            }
            false
        })
    } else {
        // Can't get relative path, fall back to full path check
        is_hidden_path(path)
    }
}

/// Detect circular symlinks using canonical path tracking
/// Returns true if this path was already visited (circular symlink detected)
pub fn check_circular_symlink(path: &Path, visited: &mut HashSet<PathBuf>) -> bool {
    if let Ok(canonical) = path.canonicalize() {
        !visited.insert(canonical)
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_is_hidden_relative_to() {
        let base = Path::new("/workspace");
        assert!(is_hidden_relative_to(Path::new("/workspace/.git"), base));
        assert!(is_hidden_relative_to(
            Path::new("/workspace/src/.hidden"),
            base
        ));
        assert!(!is_hidden_relative_to(
            Path::new("/workspace/src/main.rs"),
            base
        ));
        // Single dot should not be considered hidden
        assert!(!is_hidden_relative_to(Path::new("/workspace/./src"), base));
    }

    #[test]
    fn test_is_hidden_path() {
        assert!(is_hidden_path(Path::new("/workspace/.git")));
        assert!(is_hidden_path(Path::new(
            "/workspace/.vscode/settings.json"
        )));
        assert!(!is_hidden_path(Path::new("/workspace/src/main.rs")));
        // Single dot should not be considered hidden
        assert!(!is_hidden_path(Path::new("/workspace/./src")));
    }

    #[test]
    fn test_matches_exclude_pattern_prefix() {
        assert!(matches_exclude_pattern("node_modules", "node*"));
        assert!(matches_exclude_pattern("node", "node*"));
        assert!(!matches_exclude_pattern("mynode", "node*"));
    }

    #[test]
    fn test_matches_exclude_pattern_suffix() {
        assert!(matches_exclude_pattern("test.log", "*.log"));
        assert!(matches_exclude_pattern(".log", "*.log"));
        assert!(!matches_exclude_pattern("test.txt", "*.log"));
    }

    #[test]
    fn test_matches_exclude_pattern_contains() {
        assert!(matches_exclude_pattern("myfile.txt", "*file*"));
        assert!(matches_exclude_pattern("file", "*file*"));
        assert!(!matches_exclude_pattern("test.txt", "*file*"));
    }

    #[test]
    fn test_walk_directory_basic() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("file1.txt"), "content").unwrap();
        fs::write(temp.path().join("file2.md"), "content").unwrap();

        let mut files = Vec::new();
        let options = WalkOptions::default();

        walk_directory(temp.path(), &options, |entry| {
            if entry.path().is_file() {
                files.push(entry.path().to_string_lossy().to_string());
            }
            Ok(())
        })
        .unwrap();

        assert_eq!(files.len(), 2);
    }

    #[test]
    fn test_walk_directory_exclude_patterns() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("node_modules")).unwrap();
        fs::write(temp.path().join("node_modules/file.js"), "content").unwrap();
        fs::create_dir_all(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/main.rs"), "content").unwrap();

        let mut files = Vec::new();
        let options = WalkOptions {
            exclude_patterns: vec!["node_modules".to_string()],
            ..Default::default()
        };

        walk_directory(temp.path(), &options, |entry| {
            if entry.path().is_file() {
                files.push(entry.path().to_string_lossy().to_string());
            }
            Ok(())
        })
        .unwrap();

        assert_eq!(files.len(), 1); // Only src/main.rs
        assert!(files[0].contains("main.rs"));
    }

    #[test]
    fn test_walk_directory_hidden_files() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("visible.txt"), "content").unwrap();
        fs::write(temp.path().join(".hidden"), "content").unwrap();

        // With exclude_hidden = true
        let mut files = Vec::new();
        let options = WalkOptions {
            exclude_hidden: true,
            ..Default::default()
        };

        walk_directory(temp.path(), &options, |entry| {
            if entry.path().is_file() {
                files.push(entry.path().to_string_lossy().to_string());
            }
            Ok(())
        })
        .unwrap();

        assert_eq!(files.len(), 1);
        assert!(files[0].contains("visible.txt"));

        // With exclude_hidden = false
        let mut files = Vec::new();
        let options = WalkOptions {
            exclude_hidden: false,
            ..Default::default()
        };

        walk_directory(temp.path(), &options, |entry| {
            if entry.path().is_file() {
                files.push(entry.path().to_string_lossy().to_string());
            }
            Ok(())
        })
        .unwrap();

        assert_eq!(files.len(), 2);
    }

    #[test]
    fn test_circular_symlink_detection() {
        let mut visited = HashSet::new();
        let temp = TempDir::new().unwrap();
        let dir_a = temp.path().join("a");
        fs::create_dir(&dir_a).unwrap();

        // First visit should succeed (returns false = not circular)
        assert!(!check_circular_symlink(&dir_a, &mut visited));

        // Second visit should be detected as circular (returns true)
        assert!(check_circular_symlink(&dir_a, &mut visited));
    }

    #[cfg(unix)]
    #[test]
    fn test_circular_symlink_detection_with_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let dir_a = temp.path().join("a");
        let dir_b = temp.path().join("b");
        fs::create_dir(&dir_a).unwrap();
        fs::create_dir(&dir_b).unwrap();

        // Create symlinks: a/link -> b, b/link -> a
        symlink(&dir_b, dir_a.join("link")).unwrap();
        symlink(&dir_a, dir_b.join("link")).unwrap();

        let mut visited = HashSet::new();

        // Visit dir_a
        assert!(!check_circular_symlink(&dir_a, &mut visited));

        // Visit dir_b
        assert!(!check_circular_symlink(&dir_b, &mut visited));

        // Try to visit dir_a again via symlink - should be detected
        assert!(check_circular_symlink(&dir_a, &mut visited));
    }
}
