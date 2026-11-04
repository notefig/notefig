//! A workspace: one folder on disk. Paths given to and returned by this API
//! are workspace-relative, `/`-separated strings (`notes/today.md`); the root
//! is `""`. Every path is checked for containment before touching the disk.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use anyhow::{Context as _, Result, anyhow, bail};

use crate::rules;

/// MD5 hex of the content, compatible with the Tauri app's
/// `compute_content_hash`.
pub fn content_hash(content: &str) -> String {
    format!("{:x}", md5::compute(content.as_bytes()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Workspace-relative path, `/`-separated.
    pub rel: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

impl Entry {
    pub fn name(&self) -> &str {
        file_name(&self.rel)
    }
    pub fn is_dir(&self) -> bool {
        self.kind == EntryKind::Dir
    }
}

/// The last path component of a relative path.
pub fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// The parent of a relative path (`""` for top-level entries).
pub fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// Join a relative parent and a child name.
pub fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Snapshot of the workspace tree, keyed by relative path (sorted).
pub type Tree = BTreeMap<String, Entry>;

/// Content hashes this process knows for files (from its own reads and
/// writes). The watcher compares against them to drop echoes of our own
/// writes and to pair renames.
#[derive(Default)]
pub(crate) struct Known {
    pub(crate) hashes: HashMap<String, String>,
}

#[derive(Clone)]
pub struct Workspace {
    root: PathBuf,
    pub(crate) known: Arc<Mutex<Known>>,
}

impl std::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace").field("root", &self.root).finish()
    }
}

impl Workspace {
    /// Open an existing folder. The root is canonicalized so `/tmp` and
    /// `/private/tmp` spellings agree with the watcher's paths.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let root = std::fs::canonicalize(path)
            .with_context(|| format!("cannot open workspace {}", path.display()))?;
        if !root.is_dir() {
            bail!("{} is not a folder", root.display());
        }
        Ok(Self {
            root,
            known: Default::default(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Display name (the folder name).
    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.display().to_string())
    }

    /// Resolve a relative path to an absolute one inside the root. Rejects
    /// absolute paths, `..` escapes and symlinked parents that leave the root.
    pub fn abs(&self, rel: &str) -> Result<PathBuf> {
        let rel_path = Path::new(rel);
        let mut out = self.root.clone();
        for comp in rel_path.components() {
            match comp {
                Component::Normal(c) => out.push(c),
                Component::CurDir => {}
                _ => bail!("path escapes the workspace: {rel}"),
            }
        }
        // If the parent exists, make sure it resolves inside the root
        // (symlinks pointing out are refused).
        if let Some(parent) = out.parent() {
            if let Ok(canon) = std::fs::canonicalize(parent) {
                if !canon.starts_with(&self.root) {
                    bail!("path escapes the workspace: {rel}");
                }
            }
        }
        Ok(out)
    }

    /// The relative path of an absolute path, if it is inside this workspace
    /// (component-wise; a sibling `/ws-other` is not inside `/ws`).
    pub fn rel_of(&self, abs: &Path) -> Option<String> {
        let stripped = abs.strip_prefix(&self.root).ok()?;
        let parts: Vec<String> = stripped
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        Some(parts.join("/"))
    }

    /// Like `rel_of`, but also tries the canonical spelling of the parent
    /// (for watcher paths such as `/tmp/...` vs `/private/tmp/...`).
    pub fn rel_of_loose(&self, abs: &Path) -> Option<String> {
        if let Some(rel) = self.rel_of(abs) {
            return Some(rel);
        }
        let parent = std::fs::canonicalize(abs.parent()?).ok()?;
        self.rel_of(&parent.join(abs.file_name()?))
    }

    /// The workspace walk: `.gitignore` plus Notefig's hidden/denylist rules.
    pub(crate) fn walker(&self) -> ignore::Walk {
        ignore::WalkBuilder::new(&self.root)
            .hidden(false) // our own hidden rule (the app dir is visible)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(true)
            .require_git(false)
            .parents(false)
            .follow_links(false)
            .sort_by_file_name(|a, b| a.cmp(b))
            .filter_entry(move |entry| {
                let Some(name) = entry.file_name().to_str() else {
                    return false;
                };
                if entry.depth() == 0 {
                    return true;
                }
                let parent = entry
                    .path()
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str());
                let parent = if entry.depth() == 1 { None } else { parent };
                if rules::is_hidden_child(parent, name) {
                    return false;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if is_dir {
                    !rules::is_ignored_directory(name)
                } else {
                    !rules::is_ignored_file(name)
                }
            })
            .build()
    }

    /// Walk the workspace, respecting `.gitignore` and Notefig's denylist.
    pub fn scan(&self) -> Result<Tree> {
        let mut tree = Tree::new();
        let walker = self.walker();
        for item in walker {
            let entry = match item {
                Ok(e) => e,
                Err(err) => {
                    log::debug!("walk error: {err}");
                    continue;
                }
            };
            if entry.depth() == 0 {
                continue;
            }
            let Some(rel) = self.rel_of(entry.path()) else {
                continue;
            };
            let meta = entry.metadata().ok();
            let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                EntryKind::Dir
            } else {
                EntryKind::File
            };
            tree.insert(
                rel.clone(),
                Entry {
                    rel,
                    kind,
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: meta.and_then(|m| m.modified().ok()),
                },
            );
        }
        Ok(tree)
    }

    /// Read a text file and remember its hash.
    pub fn read(&self, rel: &str) -> Result<(String, String)> {
        let abs = self.abs(rel)?;
        let bytes = std::fs::read(&abs).with_context(|| format!("read {rel}"))?;
        let text = String::from_utf8(bytes).map_err(|_| anyhow!("{rel} is not UTF-8 text"))?;
        let hash = content_hash(&text);
        self.remember(rel, &hash);
        Ok((text, hash))
    }

    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        let abs = self.abs(rel)?;
        std::fs::read(&abs).with_context(|| format!("read {rel}"))
    }

    /// Write a text file atomically (temp file + rename), creating parent
    /// folders. Registers the hash first so the watcher drops our own echo.
    pub fn write(&self, rel: &str, content: &str) -> Result<String> {
        let abs = self.abs(rel)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let hash = content_hash(content);
        self.remember(rel, &hash);
        let tmp = abs.with_file_name(format!(
            ".{}.notefig-{}.tmp",
            abs.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
            std::process::id()
        ));
        std::fs::write(&tmp, content).with_context(|| format!("write {rel}"))?;
        if let Err(err) = std::fs::rename(&tmp, &abs) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err).with_context(|| format!("write {rel}"));
        }
        Ok(hash)
    }

    /// The last hash this process read or wrote for `rel`.
    pub fn known_hash(&self, rel: &str) -> Option<String> {
        self.known.lock().unwrap().hashes.get(rel).cloned()
    }

    pub(crate) fn remember(&self, rel: &str, hash: &str) {
        self.known
            .lock()
            .unwrap()
            .hashes
            .insert(rel.to_string(), hash.to_string());
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.abs(rel).map(|p| p.exists()).unwrap_or(false)
    }

    /// Create a new file; fails if it exists.
    pub fn create_file(&self, rel: &str, content: &str) -> Result<()> {
        if self.exists(rel) {
            bail!("{rel} already exists");
        }
        self.write(rel, content)?;
        Ok(())
    }

    pub fn create_dir(&self, rel: &str) -> Result<()> {
        let abs = self.abs(rel)?;
        if abs.exists() {
            bail!("{rel} already exists");
        }
        std::fs::create_dir_all(&abs)?;
        Ok(())
    }

    /// Rename or move. Fails if the target exists.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        if from.is_empty() || to.is_empty() {
            bail!("cannot rename the workspace root");
        }
        let a = self.abs(from)?;
        let b = self.abs(to)?;
        if !a.exists() {
            bail!("{from} does not exist");
        }
        // Case-only renames on case-insensitive filesystems: target "exists".
        let case_only = from.to_lowercase() == to.to_lowercase() && from != to;
        if b.exists() && !case_only {
            bail!("{to} already exists");
        }
        if let Some(parent) = b.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&a, &b).with_context(|| format!("rename {from} → {to}"))?;
        let mut known = self.known.lock().unwrap();
        let moved: Vec<(String, String)> = known
            .hashes
            .iter()
            .filter(|(k, _)| *k == from || k.starts_with(&format!("{from}/")))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (k, v) in moved {
            known.hashes.remove(&k);
            known.hashes.insert(format!("{to}{}", &k[from.len()..]), v);
        }
        Ok(())
    }

    /// Move to the OS trash; falls back to removal where there is no trash.
    pub fn delete(&self, rel: &str) -> Result<()> {
        if rel.is_empty() {
            bail!("cannot delete the workspace root");
        }
        let abs = self.abs(rel)?;
        if !abs.exists() {
            bail!("{rel} does not exist");
        }
        if let Err(err) = move_to_trash(&abs) {
            log::warn!("trash failed for {rel}: {err}; removing");
            if abs.is_dir() {
                std::fs::remove_dir_all(&abs)?;
            } else {
                std::fs::remove_file(&abs)?;
            }
        }
        let mut known = self.known.lock().unwrap();
        known
            .hashes
            .retain(|k, _| k != rel && !k.starts_with(&format!("{rel}/")));
        Ok(())
    }

    /// A name for a new entry in `parent` that does not exist yet:
    /// `Untitled.md`, `Untitled 2.md`, …
    pub fn unique_name(&self, parent: &str, stem: &str, ext: Option<&str>) -> String {
        for n in 1.. {
            let name = match (n, ext) {
                (1, Some(e)) => format!("{stem}.{e}"),
                (1, None) => stem.to_string(),
                (n, Some(e)) => format!("{stem} {n}.{e}"),
                (n, None) => format!("{stem} {n}"),
            };
            let rel = join_rel(parent, &name);
            if !self.exists(&rel) {
                return rel;
            }
        }
        unreachable!()
    }
}

/// Trash via NSFileManager on macOS (the default Finder/AppleScript path
/// needs Automation permission and can hang for a minute without it).
fn move_to_trash(abs: &Path) -> Result<(), trash::Error> {
    if std::env::var_os("NOTEFIG_NO_TRASH").is_some() {
        return Err(trash::Error::Unknown {
            description: "trash disabled".into(),
        });
    }
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(abs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(abs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn containment() {
        let (_d, ws) = ws();
        assert!(ws.abs("../etc/passwd").is_err());
        assert!(ws.abs("/etc/passwd").is_err());
        assert!(ws.abs("a/../../x").is_err());
        assert!(ws.abs("a/b.md").is_ok());
        let outside = ws.root().parent().unwrap().join("sibling");
        assert_eq!(ws.rel_of(&outside), None);
        assert_eq!(ws.rel_of(&ws.root().join("a/b.md")).as_deref(), Some("a/b.md"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_refused() {
        let (_d, ws) = ws();
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), ws.root().join("link")).unwrap();
        assert!(ws.abs("link/x.md").is_err());
    }

    #[test]
    fn read_write_hash() {
        let (_d, ws) = ws();
        let h = ws.write("notes/a.md", "# A\n").unwrap();
        assert_eq!(h, content_hash("# A\n"));
        let (text, h2) = ws.read("notes/a.md").unwrap();
        assert_eq!(text, "# A\n");
        assert_eq!(h, h2);
        assert_eq!(ws.known_hash("notes/a.md"), Some(h));
        // No temp files left behind.
        let names: Vec<_> = std::fs::read_dir(ws.root().join("notes")).unwrap().collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn scan_respects_rules() {
        let (_d, ws) = ws();
        ws.write("a.md", "a").unwrap();
        ws.write("dir/b.md", "b").unwrap();
        ws.write("node_modules/x.js", "x").unwrap();
        ws.write(".git/HEAD", "x").unwrap();
        ws.write(".notefig/scratchpads/s.md", "x").unwrap();
        ws.write(".notefig/internal.json", "x").unwrap();
        ws.write("ignored-by-git.log", "x").unwrap();
        ws.write(".gitignore", "*.log\n").unwrap();
        ws.write("arch.zip", "x").unwrap();
        let tree = ws.scan().unwrap();
        let keys: Vec<_> = tree.keys().cloned().collect();
        assert_eq!(
            keys,
            vec![
                ".notefig",
                ".notefig/scratchpads",
                ".notefig/scratchpads/s.md",
                "a.md",
                "dir",
                "dir/b.md"
            ]
        );
        assert!(tree["dir"].is_dir());
    }

    #[test]
    fn create_rename_delete() {
        let (_d, ws) = ws();
        ws.create_file("x.md", "x").unwrap();
        assert!(ws.create_file("x.md", "y").is_err());
        ws.create_dir("d").unwrap();
        ws.rename("x.md", "d/y.md").unwrap();
        assert!(!ws.exists("x.md"));
        assert!(ws.exists("d/y.md"));
        assert_eq!(ws.known_hash("d/y.md"), Some(content_hash("x")));
        ws.delete("d").unwrap();
        assert!(!ws.exists("d"));
        assert!(ws.delete("").is_err());
        assert_eq!(ws.unique_name("", "Untitled", Some("md")), "Untitled.md");
        ws.write("Untitled.md", "").unwrap();
        assert_eq!(ws.unique_name("", "Untitled", Some("md")), "Untitled 2.md");
    }
}
