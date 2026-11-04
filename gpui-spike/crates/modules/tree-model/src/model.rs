//! The tree model itself: what `@pierre/trees`' `FileTree` holds for the TS
//! app (paths, sort, expansion, selection, focus, the inline rename/create
//! session) and its visible-row projection. GPUI-free; the view renders
//! [`TreeModel::rows`] and calls the gestures.
//!
//! Paths are tree-domain: workspace-relative, `/`-separated, no trailing
//! slash (the kind is carried alongside, where trees uses a trailing `/`).

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};

use notefig_core::{Listeners, Subscription};

use crate::APP_DIR_NAME;

/// `SortOrder` (`utils/fs.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortOrder {
    #[default]
    NameAsc,
    NameDesc,
    DateModified,
}

impl SortOrder {
    pub fn key(self) -> &'static str {
        match self {
            SortOrder::NameAsc => "name-asc",
            SortOrder::NameDesc => "name-desc",
            SortOrder::DateModified => "date-modified",
        }
    }

    pub fn from_key(key: &str) -> Self {
        match key {
            "name-desc" => SortOrder::NameDesc,
            "date-modified" => SortOrder::DateModified,
            _ => SortOrder::NameAsc,
        }
    }
}

/// One input path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreePath {
    pub path: String,
    pub is_dir: bool,
    /// mtime millis, for the date-modified sort (0 when not stat'd).
    pub modified_ms: u64,
}

/// One visible row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRow {
    /// The row's path: for a flattened chain (`a/b` shown as `a / b`), the
    /// deepest directory's, as trees' `data-item-path`.
    pub path: String,
    /// What the row shows: the name, or the chain's names joined by ` / `.
    pub label: String,
    /// Each name of a flattened chain with its own path, for per-segment
    /// drop targets; a single entry otherwise.
    pub segments: Vec<(String, String)>,
    pub depth: usize,
    pub is_dir: bool,
    pub expanded: bool,
    pub selected: bool,
    pub focused: bool,
    /// The row is the inline rename/create field.
    pub renaming: bool,
}

/// The inline text entry: renaming a row, or naming a placeholder a "New
/// File"/"New Folder" added (`startRenaming(path, { removeIfCanceled })`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameSession {
    pub path: String,
    pub is_dir: bool,
    /// The placeholder goes away when the entry is cancelled.
    pub remove_if_canceled: bool,
}

/// What a committed rename asks of the app (trees' `onRename`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameCommit {
    pub source: String,
    pub destination: String,
    pub is_dir: bool,
    /// The placeholder of a create, not an existing entry.
    pub was_placeholder: bool,
}

#[derive(Default)]
pub struct TreeModel {
    entries: HashMap<String, TreePath>,
    children: HashMap<String, Vec<String>>,
    expanded: HashSet<String>,
    selected: BTreeSet<String>,
    anchor: Option<String>,
    focused: Option<String>,
    rename: Option<RenameSession>,
    sort: SortOrder,
    rows: Vec<TreeRow>,
    changed: Listeners<()>,
}

pub(crate) fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub(crate) fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

fn by_name(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

impl TreeModel {
    pub fn new(sort: SortOrder) -> Self {
        Self { sort, ..Default::default() }
    }

    pub fn sort(&self) -> SortOrder {
        self.sort
    }

    /// Called after every change of rows, expansion, selection or focus.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    fn compare_siblings(&self, a: &str, b: &str) -> Ordering {
        // The app dir is pinned at the top of the tree in every order
        // (MET-254); items inside still sort normally.
        if parent_of(a).is_empty() {
            if name_of(a) == APP_DIR_NAME {
                return Ordering::Less;
            }
            if name_of(b) == APP_DIR_NAME {
                return Ordering::Greater;
            }
        }
        let (an, bn) = (name_of(a), name_of(b));
        match self.sort {
            SortOrder::NameDesc => by_name(bn, an),
            SortOrder::DateModified => {
                let ma = self.entries.get(a).map(|e| e.modified_ms).unwrap_or(0);
                let mb = self.entries.get(b).map(|e| e.modified_ms).unwrap_or(0);
                mb.cmp(&ma).then_with(|| by_name(an, bn))
            }
            SortOrder::NameAsc => by_name(an, bn),
        }
    }

    /// `resetPaths`: the full list; expansion and selection of paths that
    /// survive are kept. Implied parent directories are added.
    pub fn reset_paths(&mut self, paths: Vec<TreePath>) {
        let mut entries: HashMap<String, TreePath> = HashMap::with_capacity(paths.len());
        for p in paths {
            let path = p.path.trim_matches('/').replace("//", "/");
            if path.is_empty() {
                continue;
            }
            let mut parent = parent_of(&path).to_string();
            while !parent.is_empty() && !entries.contains_key(&parent) {
                entries.insert(parent.clone(), TreePath { path: parent.clone(), is_dir: true, modified_ms: 0 });
                parent = parent_of(&parent).to_string();
            }
            entries.insert(path.clone(), TreePath { path, ..p });
        }
        // An in-flight create's placeholder survives a data tick.
        if let Some(r) = &self.rename
            && r.remove_if_canceled
            && !entries.contains_key(&r.path)
        {
            entries.insert(r.path.clone(), TreePath { path: r.path.clone(), is_dir: r.is_dir, modified_ms: u64::MAX });
        }
        self.entries = entries;
        self.selected.retain(|p| self.entries.contains_key(p));
        if self.focused.as_ref().is_some_and(|f| !self.entries.contains_key(f)) {
            self.focused = None;
        }
        self.rebuild_children();
        self.rebuild();
    }

    pub fn set_sort(&mut self, sort: SortOrder) {
        if self.sort != sort {
            self.sort = sort;
            self.rebuild_children();
            self.rebuild();
        }
    }

    fn rebuild_children(&mut self) {
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        for path in self.entries.keys() {
            children.entry(parent_of(path).to_string()).or_default().push(path.clone());
        }
        for list in children.values_mut() {
            list.sort_by(|a, b| self.compare_siblings(a, b));
        }
        self.children = children;
    }

    pub fn contains(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }

    pub fn is_dir(&self, path: &str) -> bool {
        self.entries.get(path).is_some_and(|e| e.is_dir)
    }

    pub fn rows(&self) -> &[TreeRow] {
        &self.rows
    }

    pub fn visible_count(&self) -> usize {
        self.rows.len()
    }

    pub fn index_of(&self, path: &str) -> Option<usize> {
        self.rows.iter().position(|r| r.path == path || r.segments.iter().any(|(p, _)| p == path))
    }

    /// The chain a directory row flattens into: while a directory's only
    /// child is a directory, they show as one row (trees'
    /// `flattenEmptyDirectories`). Never through the inline field.
    fn chain(&self, dir: &str) -> Vec<String> {
        let mut chain = vec![dir.to_string()];
        let mut at = dir.to_string();
        loop {
            let Some(kids) = self.children.get(&at) else { break };
            if kids.len() != 1 || !self.is_dir(&kids[0]) {
                break;
            }
            if self.rename.as_ref().is_some_and(|r| r.path == kids[0] || r.path == at) {
                break;
            }
            at = kids[0].clone();
            chain.push(at.clone());
        }
        chain
    }

    fn rebuild(&mut self) {
        let mut rows = Vec::new();
        self.push_children("", 0, &mut rows);
        self.rows = rows;
        self.changed.emit();
    }

    fn push_children(&self, parent: &str, depth: usize, rows: &mut Vec<TreeRow>) {
        let Some(kids) = self.children.get(parent) else { return };
        for kid in kids {
            let is_dir = self.is_dir(kid);
            let chain = if is_dir { self.chain(kid) } else { vec![kid.clone()] };
            let path = chain.last().unwrap().clone();
            let expanded = is_dir && self.expanded.contains(&path);
            rows.push(TreeRow {
                label: chain.iter().map(|p| name_of(p)).collect::<Vec<_>>().join(" / "),
                segments: chain.iter().map(|p| (p.clone(), name_of(p).to_string())).collect(),
                depth,
                is_dir,
                expanded,
                selected: self.selected.contains(&path),
                focused: self.focused.as_deref() == Some(path.as_str()),
                renaming: self.rename.as_ref().is_some_and(|r| r.path == path),
                path: path.clone(),
            });
            if expanded {
                self.push_children(&path, depth + 1, rows);
            }
        }
    }

    // -- expansion -----------------------------------------------------------

    pub fn is_expanded(&self, path: &str) -> bool {
        self.expanded.contains(path)
    }

    pub fn expanded_paths(&self) -> Vec<String> {
        let mut v: Vec<String> = self.expanded.iter().cloned().collect();
        v.sort();
        v
    }

    /// Replace the expanded set (`initialExpandedPaths`).
    pub fn set_expanded_paths(&mut self, paths: impl IntoIterator<Item = String>) {
        self.expanded = paths.into_iter().collect();
        self.rebuild();
    }

    pub fn set_expanded(&mut self, path: &str, expanded: bool) {
        let path = self.row_path_of(path);
        let changed = if expanded { self.expanded.insert(path) } else { self.expanded.remove(&path) };
        if changed {
            self.rebuild();
        }
    }

    pub fn toggle(&mut self, path: &str) {
        let path = self.row_path_of(path);
        let open = self.expanded.contains(&path);
        self.set_expanded(&path, !open);
    }

    /// The row a path shows on: a directory inside a flattened chain shows
    /// on the chain's row.
    fn row_path_of(&self, path: &str) -> String {
        if self.is_dir(path) { self.chain(path).last().cloned().unwrap_or_else(|| path.to_string()) } else { path.to_string() }
    }

    /// Expand every ancestor so `path` is visible; its row index.
    pub fn reveal(&mut self, path: &str) -> Option<usize> {
        let mut parent = parent_of(path).to_string();
        let mut changed = false;
        while !parent.is_empty() {
            let row = self.row_path_of(&parent);
            changed |= self.expanded.insert(row);
            parent = parent_of(&parent).to_string();
        }
        if changed {
            self.rebuild();
        }
        self.index_of(path)
    }

    // -- selection and focus -------------------------------------------------

    pub fn selected_paths(&self) -> Vec<String> {
        self.selected.iter().cloned().collect()
    }

    pub fn focused(&self) -> Option<&str> {
        self.focused.as_deref()
    }

    /// Single selection: the active tab mirrored into the tree.
    pub fn select_only(&mut self, path: &str) {
        if self.selected.len() == 1 && self.selected.contains(path) && self.focused.as_deref() == Some(path) {
            return;
        }
        self.selected.clear();
        if self.entries.contains_key(path) {
            self.selected.insert(path.to_string());
            self.focused = Some(path.to_string());
            self.anchor = Some(path.to_string());
        }
        self.rebuild();
    }

    /// Mod-toggle one row in or out of the selection.
    pub fn toggle_selected(&mut self, path: &str) {
        if !self.selected.remove(path) {
            self.selected.insert(path.to_string());
        }
        self.focused = Some(path.to_string());
        self.anchor = Some(path.to_string());
        self.rebuild();
    }

    /// Shift-extend from the anchor to `path` over visible rows.
    pub fn select_range(&mut self, path: &str) {
        let anchor = self.anchor.clone().unwrap_or_else(|| path.to_string());
        let (Some(a), Some(b)) = (self.index_of(&anchor), self.index_of(path)) else { return };
        let (lo, hi) = (a.min(b), a.max(b));
        self.selected = self.rows[lo..=hi].iter().map(|r| r.path.clone()).collect();
        self.focused = Some(path.to_string());
        self.rebuild();
    }

    pub fn clear_selection(&mut self) {
        self.selected.clear();
        self.rebuild();
    }

    pub fn set_focused(&mut self, path: Option<&str>) {
        let next = path.map(str::to_string);
        if self.focused != next {
            self.focused = next;
            self.rebuild();
        }
    }

    pub fn focus_first(&mut self) {
        let first = self.rows.first().map(|r| r.path.clone());
        self.set_focused(first.as_deref());
    }

    /// Arrow-key navigation: the focused row moves by `delta` visible rows
    /// (`extend`: shift held, the selection follows as a range).
    pub fn move_focus(&mut self, delta: isize, extend: bool) {
        if self.rows.is_empty() {
            return;
        }
        let at = self.focused.as_deref().and_then(|f| self.index_of(f));
        let next = match at {
            None => 0,
            Some(i) => (i as isize + delta).clamp(0, self.rows.len() as isize - 1) as usize,
        };
        let path = self.rows[next].path.clone();
        if extend {
            if self.anchor.is_none() {
                self.anchor = at.map(|i| self.rows[i].path.clone());
            }
            self.select_range(&path);
        } else {
            self.focused = Some(path);
            self.rebuild();
        }
    }

    pub fn focus_edge(&mut self, last: bool) {
        let n = self.rows.len() as isize;
        self.move_focus(if last { n } else { -n }, false);
    }

    /// Right arrow: expand a closed folder, else step into its first child.
    pub fn focus_right(&mut self) {
        let Some(f) = self.focused.clone() else { return self.focus_first() };
        if self.is_dir(&f) {
            if !self.is_expanded(&f) {
                self.set_expanded(&f, true);
            } else {
                self.move_focus(1, false);
            }
        }
    }

    /// Left arrow: collapse an open folder, else go to the parent row.
    pub fn focus_left(&mut self) {
        let Some(f) = self.focused.clone() else { return };
        if self.is_dir(&f) && self.is_expanded(&f) {
            self.set_expanded(&f, false);
            return;
        }
        let Some(i) = self.index_of(&f) else { return };
        let depth = self.rows[i].depth;
        if let Some(parent) = self.rows[..i].iter().rev().find(|r| r.depth < depth) {
            let p = parent.path.clone();
            self.set_focused(Some(&p));
        }
    }

    // -- inline rename / create ---------------------------------------------

    pub fn rename_session(&self) -> Option<&RenameSession> {
        self.rename.as_ref()
    }

    /// `startRenaming`: the row becomes a text field.
    pub fn start_renaming(&mut self, path: &str) -> bool {
        let Some(entry) = self.entries.get(path) else { return false };
        self.rename = Some(RenameSession { path: path.to_string(), is_dir: entry.is_dir, remove_if_canceled: false });
        self.reveal(path);
        self.focused = Some(path.to_string());
        self.rebuild();
        true
    }

    /// "New File"/"New Folder": a placeholder named `untitled.md` /
    /// `untitled` (`-2`, `-3`… when taken) in `parent`, which expands, and
    /// its name field. Returns the placeholder's path.
    pub fn start_creating(&mut self, parent: &str, is_dir: bool) -> String {
        let join = |name: &str| if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
        let mut name = if is_dir { "untitled".to_string() } else { "untitled.md".to_string() };
        let mut candidate = join(&name);
        let mut counter = 2;
        while self.entries.contains_key(&candidate) {
            name = if is_dir { format!("untitled-{counter}") } else { format!("untitled-{counter}.md") };
            candidate = join(&name);
            counter += 1;
        }
        if !parent.is_empty() {
            self.expanded.insert(self.row_path_of(parent));
        }
        self.entries.insert(candidate.clone(), TreePath { path: candidate.clone(), is_dir, modified_ms: u64::MAX });
        self.rename = Some(RenameSession { path: candidate.clone(), is_dir, remove_if_canceled: true });
        self.focused = Some(candidate.clone());
        self.rebuild_children();
        self.rebuild();
        candidate
    }

    /// End the entry with `name`. An unchanged or empty name commits
    /// nothing (a placeholder with its proposed name is still created).
    pub fn commit_rename(&mut self, name: &str) -> Option<RenameCommit> {
        let session = self.rename.take()?;
        let name = name.trim();
        let placeholder = session.remove_if_canceled;
        if placeholder {
            self.entries.remove(&session.path);
            self.rebuild_children();
        }
        let parent = parent_of(&session.path);
        let valid = !name.is_empty() && !name.contains('/') && name != "." && name != "..";
        let destination = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
        // Focus follows the entry to its new name (the row arrives with the
        // next data tick); an abandoned one leaves nothing focused.
        self.focused = valid.then(|| destination.clone());
        self.rebuild();
        if !valid || (!placeholder && destination == session.path) {
            return None;
        }
        Some(RenameCommit { source: session.path, destination, is_dir: session.is_dir, was_placeholder: placeholder })
    }

    /// Escape: a create's placeholder goes away.
    pub fn cancel_rename(&mut self) {
        let Some(session) = self.rename.take() else { return };
        if session.remove_if_canceled {
            self.entries.remove(&session.path);
            self.rebuild_children();
        }
        self.rebuild();
    }
}
