//! The dock layout model: panes of tabs arranged in nested splits. Pure data
//! (no gpui) so it unit-tests fast and serializes to the per-workspace
//! session. The views render it; every change goes through these methods.

use serde::{Deserialize, Serialize};

/// What a tab shows. `File` paths are workspace-relative.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Tab {
    File { rel: String },
    /// An agent session (task): the chat tab.
    Chat { task_id: String },
    /// The settings tab (harnesses, usage); a singleton.
    Settings,
}

impl Tab {
    pub fn file(rel: impl Into<String>) -> Self {
        Tab::File { rel: rel.into() }
    }
    pub fn rel(&self) -> Option<&str> {
        match self {
            Tab::File { rel } => Some(rel),
            Tab::Chat { .. } | Tab::Settings => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabEntry {
    pub tab: Tab,
    /// A preview tab is replaced by the next preview open in the same pane.
    #[serde(default)]
    pub preview: bool,
}

pub type PaneId = u64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pane {
    pub id: PaneId,
    pub tabs: Vec<TabEntry>,
    pub active: usize,
}

impl Pane {
    pub fn active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.active).map(|t| &t.tab)
    }
    fn position(&self, tab: &Tab) -> Option<usize> {
        self.tabs.iter().position(|t| &t.tab == tab)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    /// Children side by side.
    Row,
    /// Children stacked.
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitDirection {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Pane(Pane),
    Split {
        axis: Axis,
        children: Vec<Node>,
        /// Child sizes in pixels from the last resize (empty = equal). The
        /// renderer scales them to the container.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sizes: Vec<f32>,
    },
}

impl Node {
    /// The first pane in reading order: a stable key for a split's child.
    pub fn first_pane(&self) -> PaneId {
        match self {
            Node::Pane(p) => p.id,
            Node::Split { children, .. } => children.first().map(Node::first_pane).unwrap_or(0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub root: Node,
    pub focused: PaneId,
    next_id: PaneId,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            root: Node::Pane(Pane {
                id: 1,
                tabs: Vec::new(),
                active: 0,
            }),
            focused: 1,
            next_id: 2,
        }
    }
}

/// How `open` places a tab.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    /// Replace the pane's preview tab (or add one).
    Preview,
    /// Add (or pin) a permanent tab.
    Pinned,
}

impl Layout {
    // ---- queries ------------------------------------------------------

    pub fn panes(&self) -> Vec<&Pane> {
        fn walk<'a>(node: &'a Node, out: &mut Vec<&'a Pane>) {
            match node {
                Node::Pane(p) => out.push(p),
                Node::Split { children, .. } => children.iter().for_each(|c| walk(c, out)),
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }

    pub fn pane(&self, id: PaneId) -> Option<&Pane> {
        self.panes().into_iter().find(|p| p.id == id)
    }

    fn pane_mut(&mut self, id: PaneId) -> Option<&mut Pane> {
        fn walk(node: &mut Node, id: PaneId) -> Option<&mut Pane> {
            match node {
                Node::Pane(p) if p.id == id => Some(p),
                Node::Pane(_) => None,
                Node::Split { children, .. } => children.iter_mut().find_map(|c| walk(c, id)),
            }
        }
        walk(&mut self.root, id)
    }

    pub fn focused_pane(&self) -> &Pane {
        self.pane(self.focused)
            .unwrap_or_else(|| self.panes()[0])
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.focused_pane().active_tab()
    }

    /// Every tab in every pane.
    pub fn all_tabs(&self) -> Vec<Tab> {
        self.panes()
            .iter()
            .flat_map(|p| p.tabs.iter().map(|t| t.tab.clone()))
            .collect()
    }

    pub fn contains(&self, tab: &Tab) -> bool {
        self.panes().iter().any(|p| p.position(tab).is_some())
    }

    // ---- mutations ----------------------------------------------------

    pub fn focus(&mut self, pane: PaneId) {
        if self.pane(pane).is_some() {
            self.focused = pane;
        }
    }

    /// Open `tab` in the focused pane. An already-open tab is activated (and
    /// pinned when `mode` is Pinned). A preview open replaces the pane's
    /// current preview tab.
    pub fn open(&mut self, tab: Tab, mode: OpenMode) {
        let focused = self.focused;
        self.open_in(focused, tab, mode);
    }

    pub fn open_in(&mut self, pane_id: PaneId, tab: Tab, mode: OpenMode) {
        let Some(pane) = self.pane_mut(pane_id) else {
            return;
        };
        if let Some(ix) = pane.position(&tab) {
            pane.active = ix;
            if mode == OpenMode::Pinned {
                pane.tabs[ix].preview = false;
            }
        } else {
            let entry = TabEntry {
                tab,
                preview: mode == OpenMode::Preview,
            };
            match pane.tabs.iter().position(|t| t.preview) {
                Some(ix) if mode == OpenMode::Preview => {
                    pane.tabs[ix] = entry;
                    pane.active = ix;
                }
                _ => {
                    let at = if pane.tabs.is_empty() { 0 } else { pane.active + 1 };
                    pane.tabs.insert(at, entry);
                    pane.active = at;
                }
            }
        }
        self.focused = pane_id;
    }

    /// Make a preview tab permanent (on edit or double click).
    pub fn pin(&mut self, tab: &Tab) {
        for pane in self.panes_mut() {
            if let Some(ix) = pane.position(tab) {
                pane.tabs[ix].preview = false;
            }
        }
    }

    pub fn select(&mut self, pane_id: PaneId, index: usize) {
        if let Some(pane) = self.pane_mut(pane_id) {
            if index < pane.tabs.len() {
                pane.active = index;
            }
            self.focused = pane_id;
        }
    }

    /// Close one tab in one pane. An emptied pane is removed unless it is
    /// the last one.
    pub fn close(&mut self, pane_id: PaneId, tab: &Tab) {
        let Some(pane) = self.pane_mut(pane_id) else {
            return;
        };
        let Some(ix) = pane.position(tab) else {
            return;
        };
        pane.tabs.remove(ix);
        if pane.active > ix || pane.active >= pane.tabs.len() {
            pane.active = pane.active.saturating_sub(1);
        }
        if pane.tabs.is_empty() {
            self.remove_pane(pane_id);
        }
    }

    /// Close the focused pane's active tab (Cmd+W). Returns the closed tab.
    pub fn close_active(&mut self) -> Option<Tab> {
        let pane = self.focused_pane();
        let id = pane.id;
        let tab = pane.active_tab()?.clone();
        self.close(id, &tab);
        Some(tab)
    }

    /// Close a tab wherever it is open.
    pub fn close_everywhere(&mut self, tab: &Tab) {
        let ids: Vec<PaneId> = self.panes().iter().map(|p| p.id).collect();
        for id in ids {
            self.close(id, tab);
        }
    }

    /// Move a tab within its pane (drag reorder).
    pub fn reorder(&mut self, pane_id: PaneId, from: usize, to: usize) {
        let Some(pane) = self.pane_mut(pane_id) else {
            return;
        };
        if from >= pane.tabs.len() {
            return;
        }
        let active = pane.tabs[pane.active].tab.clone();
        let entry = pane.tabs.remove(from);
        let to = to.min(pane.tabs.len());
        pane.tabs.insert(to, entry);
        pane.active = pane.position(&active).unwrap_or(0);
    }

    /// Move a tab from one pane to another (at `index`, or the end).
    pub fn move_tab(&mut self, from_pane: PaneId, tab: &Tab, to_pane: PaneId, index: Option<usize>) {
        if from_pane == to_pane {
            if let (Some(pane), Some(index)) = (self.pane(from_pane), index) {
                if let Some(from) = pane.position(tab) {
                    self.reorder(from_pane, from, index);
                }
            }
            return;
        }
        let Some(entry) = self
            .pane(from_pane)
            .and_then(|p| p.position(tab).map(|i| p.tabs[i].clone()))
        else {
            return;
        };
        if self.pane(to_pane).is_none() {
            return;
        }
        self.close(from_pane, tab);
        let Some(pane) = self.pane_mut(to_pane) else {
            return;
        };
        if let Some(existing) = pane.position(tab) {
            pane.active = existing;
        } else {
            let at = index.unwrap_or(pane.tabs.len()).min(pane.tabs.len());
            pane.tabs.insert(at, entry);
            pane.active = at;
        }
        self.focused = to_pane;
    }

    /// Split `pane_id`, putting a copy of its active tab (or nothing) in a
    /// new pane on the given side. Returns the new pane's id.
    pub fn split(&mut self, pane_id: PaneId, direction: SplitDirection) -> Option<PaneId> {
        let source = self.pane(pane_id)?.clone();
        let new_id = self.next_id;
        self.next_id += 1;
        let tabs: Vec<TabEntry> = source
            .active_tab()
            .map(|t| {
                vec![TabEntry {
                    tab: t.clone(),
                    preview: false,
                }]
            })
            .unwrap_or_default();
        let new_pane = Node::Pane(Pane {
            id: new_id,
            tabs,
            active: 0,
        });
        let axis = match direction {
            SplitDirection::Left | SplitDirection::Right => Axis::Row,
            SplitDirection::Up | SplitDirection::Down => Axis::Column,
        };
        let after = matches!(direction, SplitDirection::Right | SplitDirection::Down);
        insert_split(&mut self.root, pane_id, new_pane, axis, after);
        self.focused = new_id;
        Some(new_id)
    }

    /// Remove a pane (keeping at least one).
    pub fn remove_pane(&mut self, pane_id: PaneId) {
        if self.panes().len() <= 1 {
            return;
        }
        remove_from(&mut self.root, pane_id);
        normalize(&mut self.root);
        if self.pane(self.focused).is_none() {
            self.focused = self.panes()[0].id;
        }
    }

    /// Path-level updates after a rename on disk (a file or a folder).
    pub fn rename_path(&mut self, from: &str, to: &str) {
        for pane in self.panes_mut() {
            for entry in &mut pane.tabs {
                if let Tab::File { rel } = &mut entry.tab {
                    if let Some(new) = renamed(rel, from, to) {
                        *rel = new;
                    }
                }
            }
            // A rename can make two tabs in one pane identical; keep the first.
            let mut seen = Vec::new();
            let active = pane.tabs.get(pane.active).map(|t| t.tab.clone());
            pane.tabs.retain(|t| {
                if seen.contains(&t.tab) {
                    false
                } else {
                    seen.push(t.tab.clone());
                    true
                }
            });
            pane.active = active
                .and_then(|a| pane.position(&a))
                .unwrap_or(0)
                .min(pane.tabs.len().saturating_sub(1));
        }
    }

    /// Close every tab at or under `rel` (a deleted file or folder).
    pub fn remove_path(&mut self, rel: &str) {
        let doomed: Vec<Tab> = self
            .all_tabs()
            .into_iter()
            .filter(|t| t.rel().is_some_and(|r| r == rel || r.starts_with(&format!("{rel}/"))))
            .collect();
        for tab in doomed {
            self.close_everywhere(&tab);
        }
    }

    /// Repair a deserialized layout: unique ids, valid indices, no empty
    /// splits, focus on an existing pane.
    pub fn sanitize(mut self) -> Self {
        normalize(&mut self.root);
        let max = self.panes().iter().map(|p| p.id).max().unwrap_or(0);
        self.next_id = self.next_id.max(max + 1);
        for pane in self.panes_mut() {
            if pane.active >= pane.tabs.len() {
                pane.active = pane.tabs.len().saturating_sub(1);
            }
        }
        if self.pane(self.focused).is_none() {
            self.focused = self.panes()[0].id;
        }
        self
    }

    fn panes_mut(&mut self) -> Vec<&mut Pane> {
        fn walk<'a>(node: &'a mut Node, out: &mut Vec<&'a mut Pane>) {
            match node {
                Node::Pane(p) => out.push(p),
                Node::Split { children, .. } => children.iter_mut().for_each(|c| walk(c, out)),
            }
        }
        let mut out = Vec::new();
        walk(&mut self.root, &mut out);
        out
    }

    /// Record the sizes of the split whose children start with `key` (each
    /// child's first pane).
    pub fn set_split_sizes(&mut self, key: &[PaneId], new_sizes: Vec<f32>) {
        fn walk(node: &mut Node, key: &[PaneId], new_sizes: &[f32]) -> bool {
            if let Node::Split { children, sizes, .. } = node {
                let ids: Vec<PaneId> = children.iter().map(Node::first_pane).collect();
                if ids == key {
                    if new_sizes.len() == children.len() {
                        *sizes = new_sizes.to_vec();
                    }
                    return true;
                }
                return children.iter_mut().any(|c| walk(c, key, new_sizes));
            }
            false
        }
        walk(&mut self.root, key, &new_sizes);
    }

    /// Focus the next/previous pane in reading order.
    pub fn focus_offset(&mut self, delta: isize) {
        let ids: Vec<PaneId> = self.panes().iter().map(|p| p.id).collect();
        let ix = ids.iter().position(|&i| i == self.focused).unwrap_or(0) as isize;
        let n = ids.len() as isize;
        self.focused = ids[((ix + delta) % n + n) as usize % ids.len()];
    }

    /// Select the next/previous tab in the focused pane.
    pub fn cycle_tab(&mut self, delta: isize) {
        let focused = self.focused;
        if let Some(pane) = self.pane_mut(focused) {
            let n = pane.tabs.len() as isize;
            if n > 0 {
                pane.active = (((pane.active as isize + delta) % n + n) % n) as usize;
            }
        }
    }
}

/// `rel` after renaming `from` → `to`, if affected.
pub fn renamed(rel: &str, from: &str, to: &str) -> Option<String> {
    if rel == from {
        Some(to.to_string())
    } else {
        rel.strip_prefix(&format!("{from}/"))
            .map(|rest| format!("{to}/{rest}"))
    }
}

fn insert_split(node: &mut Node, target: PaneId, new: Node, axis: Axis, after: bool) -> bool {
    match node {
        Node::Pane(p) if p.id == target => {
            let old = std::mem::replace(
                node,
                Node::Split {
                    axis,
                    children: Vec::new(),
                    sizes: Vec::new(),
                },
            );
            if let Node::Split { children, .. } = node {
                if after {
                    children.extend([old, new]);
                } else {
                    children.extend([new, old]);
                }
            }
            true
        }
        Node::Pane(_) => false,
        Node::Split {
            axis: split_axis,
            children,
            sizes,
        } => {
            // Same-axis split: insert as a sibling instead of nesting.
            if let Some(ix) = children
                .iter()
                .position(|c| matches!(c, Node::Pane(p) if p.id == target))
            {
                if *split_axis == axis {
                    children.insert(if after { ix + 1 } else { ix }, new);
                    sizes.clear();
                    return true;
                }
            }
            for child in children.iter_mut() {
                if insert_split(child, target, new.clone(), axis, after) {
                    return true;
                }
            }
            false
        }
    }
}

fn remove_from(node: &mut Node, target: PaneId) {
    if let Node::Split { children, sizes, .. } = node {
        let before = children.len();
        children.retain(|c| !matches!(c, Node::Pane(p) if p.id == target));
        if children.len() != before {
            sizes.clear();
        }
        for child in children.iter_mut() {
            remove_from(child, target);
        }
    }
}

/// Collapse single-child splits and drop empty ones.
fn normalize(node: &mut Node) {
    if let Node::Split {
        children,
        axis,
        sizes,
    } = node
    {
        for child in children.iter_mut() {
            normalize(child);
        }
        children.retain(|c| !matches!(c, Node::Split { children, .. } if children.is_empty()));
        // Flatten same-axis nesting.
        let mut flat = Vec::new();
        for child in children.drain(..) {
            match child {
                Node::Split {
                    axis: a,
                    children: grand,
                    ..
                } if a == *axis => flat.extend(grand),
                other => flat.push(other),
            }
        }
        *children = flat;
        if sizes.len() != children.len() {
            sizes.clear();
        }
        if children.len() == 1 {
            *node = children.pop().unwrap();
        } else if children.is_empty() {
            *node = Node::Pane(Pane {
                id: 1,
                tabs: Vec::new(),
                active: 0,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(rel: &str) -> Tab {
        Tab::file(rel)
    }

    #[test]
    fn preview_replaces_preview() {
        let mut l = Layout::default();
        l.open(f("a.md"), OpenMode::Preview);
        l.open(f("b.md"), OpenMode::Preview);
        assert_eq!(l.all_tabs(), vec![f("b.md")]);
        l.pin(&f("b.md"));
        l.open(f("c.md"), OpenMode::Preview);
        assert_eq!(l.all_tabs(), vec![f("b.md"), f("c.md")]);
        l.open(f("d.md"), OpenMode::Pinned);
        assert_eq!(l.all_tabs(), vec![f("b.md"), f("c.md"), f("d.md")]);
        assert_eq!(l.active_tab(), Some(&f("d.md")));
    }

    #[test]
    fn split_close_and_collapse() {
        let mut l = Layout::default();
        l.open(f("a.md"), OpenMode::Pinned);
        let first = l.focused;
        let second = l.split(first, SplitDirection::Right).unwrap();
        assert_eq!(l.panes().len(), 2);
        assert_eq!(l.focused, second);
        assert_eq!(l.active_tab(), Some(&f("a.md")));
        l.open(f("b.md"), OpenMode::Pinned);
        let third = l.split(second, SplitDirection::Right).unwrap();
        // Same axis: flat, not nested.
        match &l.root {
            Node::Split { axis, children, .. } => {
                assert_eq!(*axis, Axis::Row);
                assert_eq!(children.len(), 3);
            }
            _ => panic!(),
        }
        l.close(third, &f("b.md"));
        assert_eq!(l.panes().len(), 2);
        // Focus fell back to the first pane; closing its only tab removes it.
        assert_eq!(l.focused, first);
        l.close_active();
        assert_eq!(l.focused, second);
        l.close_active();
        assert_eq!(l.panes().len(), 1);
        assert_eq!(l.all_tabs(), vec![f("a.md")]);
    }

    #[test]
    fn rename_and_remove_paths() {
        let mut l = Layout::default();
        l.open(f("dir/a.md"), OpenMode::Pinned);
        l.open(f("dir/sub/b.md"), OpenMode::Pinned);
        l.open(f("dirx/c.md"), OpenMode::Pinned);
        l.open(Tab::Chat { task_id: "t1".into() }, OpenMode::Pinned);
        l.rename_path("dir", "notes");
        assert_eq!(
            l.all_tabs(),
            vec![
                f("notes/a.md"),
                f("notes/sub/b.md"),
                f("dirx/c.md"),
                Tab::Chat { task_id: "t1".into() }
            ]
        );
        l.remove_path("notes");
        assert_eq!(
            l.all_tabs(),
            vec![f("dirx/c.md"), Tab::Chat { task_id: "t1".into() }]
        );
    }

    #[test]
    fn reorder_and_move() {
        let mut l = Layout::default();
        for n in ["a", "b", "c"] {
            l.open(f(n), OpenMode::Pinned);
        }
        let p = l.focused;
        l.reorder(p, 0, 2);
        let names: Vec<_> = l.pane(p).unwrap().tabs.iter().map(|t| t.tab.clone()).collect();
        assert_eq!(names, vec![f("b"), f("c"), f("a")]);
        assert_eq!(l.active_tab(), Some(&f("c")));
        let q = l.split(p, SplitDirection::Down).unwrap();
        l.move_tab(p, &f("a"), q, None);
        assert_eq!(l.pane(q).unwrap().tabs.len(), 2); // the split copied c, then a moved in
        assert_eq!(l.pane(p).unwrap().tabs.len(), 2);
        assert!(l.pane(q).unwrap().tabs.iter().any(|t| t.tab == f("a")));
    }

    #[test]
    fn split_sizes_survive_until_the_shape_changes() {
        let mut l = Layout::default();
        l.open(f("a"), OpenMode::Pinned);
        let a = l.focused;
        let b = l.split(a, SplitDirection::Right).unwrap();
        l.set_split_sizes(&[a, b], vec![300., 700.]);
        let json = serde_json::to_value(&l).unwrap();
        let back: Layout = serde_json::from_value(json).unwrap();
        assert!(matches!(&back.root, Node::Split { sizes, .. } if sizes == &vec![300., 700.]));
        l.split(b, SplitDirection::Right);
        assert!(matches!(&l.root, Node::Split { sizes, .. } if sizes.is_empty()));
    }

    #[test]
    fn serde_roundtrip() {
        let mut l = Layout::default();
        l.open(f("a.md"), OpenMode::Pinned);
        l.split(l.focused, SplitDirection::Right);
        l.open(Tab::Chat { task_id: "x".into() }, OpenMode::Pinned);
        let json = serde_json::to_value(&l).unwrap();
        let back: Layout = serde_json::from_value(json).unwrap();
        assert_eq!(back.clone().sanitize(), l);
    }
}
