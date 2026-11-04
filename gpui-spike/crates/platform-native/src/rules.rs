//! What the walker, the watcher and search leave out: hidden entries (by
//! position, as `walkdir_utils.rs` decides) and the caller's ignore rules
//! (`utils/ignore.ts`, handed over per call as [`IgnoreRules`]).

use std::path::Path;

use notefig_platform::IgnoreRules;

/// The app's own directory: not hidden, but only its `scratchpads` child is
/// surfaced (MET-135).
pub const APP_DIR_NAME: &str = ".notefig";
pub const APP_VISIBLE_CHILD_NAME: &str = "scratchpads";

/// Whether `name`, directly inside a folder named `parent`, counts as
/// hidden: dot-named (longer than "."), or any child of the app dir other
/// than the scratchpads folder.
pub fn is_hidden_child(parent: Option<&str>, name: &str) -> bool {
    if parent == Some(APP_DIR_NAME) {
        return name != APP_VISIBLE_CHILD_NAME;
    }
    name.starts_with('.') && name.len() > 1 && name != APP_DIR_NAME
}

/// Whether any component of `rel` (relative to a watch or walk root) is
/// hidden. Only components inside the root count: a workspace may itself
/// live under a dot folder.
pub fn has_hidden_component(rel: &Path) -> bool {
    let mut parent: Option<String> = None;
    for component in rel.components() {
        let std::path::Component::Normal(os) = component else { continue };
        let Some(name) = os.to_str() else { continue };
        if is_hidden_child(parent.as_deref(), name) {
            return true;
        }
        parent = Some(name.to_string());
    }
    false
}

/// Ignore rules, lowercased once.
#[derive(Debug, Clone, Default)]
pub struct Rules {
    directories: Vec<String>,
    extensions: Vec<String>,
}

impl Rules {
    pub fn new(rules: Option<&IgnoreRules>) -> Self {
        let Some(rules) = rules else { return Self::default() };
        Self {
            directories: rules.directories.iter().map(|d| d.to_lowercase()).collect(),
            extensions: rules.extensions.iter().map(|e| e.to_lowercase()).collect(),
        }
    }

    pub fn is_ignored_directory(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        self.directories.iter().any(|d| *d == lower)
    }

    /// Extensionless names (LICENSE) are never ignored.
    pub fn has_ignored_extension(&self, name: &str) -> bool {
        match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => {
                let ext = ext.to_lowercase();
                self.extensions.iter().any(|e| *e == ext)
            }
            _ => false,
        }
    }

    /// A path relative to its root: any component an ignored directory, or
    /// the last one an ignored extension.
    pub fn is_ignored_rel(&self, rel: &Path) -> bool {
        let names: Vec<&str> = rel
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(os) => os.to_str(),
                _ => None,
            })
            .collect();
        let Some(last) = names.last() else { return false };
        names.iter().any(|n| self.is_ignored_directory(n)) || self.has_ignored_extension(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_dir_exposes_only_scratchpads() {
        assert!(!has_hidden_component(Path::new(".notefig")));
        assert!(!has_hidden_component(Path::new(".notefig/scratchpads/a.md")));
        assert!(has_hidden_component(Path::new(".notefig/.git/HEAD")));
        assert!(has_hidden_component(Path::new(".notefig/agents.json")));
        assert!(has_hidden_component(Path::new("docs/.hidden.md")));
        assert!(has_hidden_component(Path::new(".git")));
    }

    #[test]
    fn ignore_rules_are_case_insensitive_denylists() {
        let rules = Rules::new(Some(&IgnoreRules {
            directories: vec!["node_modules".into(), "Pods".into()],
            extensions: vec!["zip".into()],
        }));
        assert!(rules.is_ignored_rel(Path::new("node_modules/x/index.js")));
        assert!(rules.is_ignored_rel(Path::new("app/pods/x")));
        assert!(rules.is_ignored_rel(Path::new("a/b.ZIP")));
        assert!(!rules.is_ignored_rel(Path::new("LICENSE")));
        assert!(!rules.is_ignored_rel(Path::new("notes/build-log.md")));
    }
}
