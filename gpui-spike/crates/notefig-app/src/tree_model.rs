//! File tree model: which folders are expanded and the flattened list of
//! visible rows the virtualized view draws. Pure (no gpui).

use std::collections::{BTreeMap, HashSet};

use notefig_workspace::{Entry, Tree, parent_rel};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub rel: String,
    pub name: String,
    pub depth: usize,
    pub is_dir: bool,
    pub expanded: bool,
}

#[derive(Default)]
pub struct TreeModel {
    pub expanded: HashSet<String>,
    /// Children of each folder, sorted (folders first, then by name).
    children: BTreeMap<String, Vec<Entry>>,
    rows: Vec<Row>,
}

impl TreeModel {
    pub fn new(expanded: impl IntoIterator<Item = String>) -> Self {
        Self {
            expanded: expanded.into_iter().collect(),
            ..Default::default()
        }
    }

    /// Rebuild from a new tree snapshot. Expansion of folders that no longer
    /// exist is dropped.
    pub fn set_tree(&mut self, tree: &Tree) {
        let mut children: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
        for entry in tree.values() {
            children
                .entry(parent_rel(&entry.rel).to_string())
                .or_default()
                .push(entry.clone());
        }
        for list in children.values_mut() {
            list.sort_by(|a, b| {
                b.is_dir()
                    .cmp(&a.is_dir())
                    .then_with(|| a.name().to_lowercase().cmp(&b.name().to_lowercase()))
                    .then_with(|| a.name().cmp(b.name()))
            });
        }
        self.children = children;
        self.expanded.retain(|rel| tree.get(rel).is_some_and(|e| e.is_dir()));
        self.rebuild();
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn toggle(&mut self, rel: &str) {
        if !self.expanded.remove(rel) {
            self.expanded.insert(rel.to_string());
        }
        self.rebuild();
    }

    pub fn set_expanded(&mut self, rel: &str, expanded: bool) {
        if expanded {
            self.expanded.insert(rel.to_string());
        } else {
            self.expanded.remove(rel);
        }
        self.rebuild();
    }

    /// Expand every ancestor of `rel` so it becomes visible. Returns its row.
    pub fn reveal(&mut self, rel: &str) -> Option<usize> {
        let mut parent = parent_rel(rel);
        while !parent.is_empty() {
            self.expanded.insert(parent.to_string());
            parent = parent_rel(parent);
        }
        self.rebuild();
        self.index_of(rel)
    }

    pub fn index_of(&self, rel: &str) -> Option<usize> {
        self.rows.iter().position(|r| r.rel == rel)
    }

    pub fn expanded_sorted(&self) -> Vec<String> {
        let mut v: Vec<String> = self.expanded.iter().cloned().collect();
        v.sort();
        v
    }

    fn rebuild(&mut self) {
        let mut rows = Vec::new();
        self.push_children("", 0, &mut rows);
        self.rows = rows;
    }

    fn push_children(&self, parent: &str, depth: usize, rows: &mut Vec<Row>) {
        let Some(list) = self.children.get(parent) else {
            return;
        };
        for entry in list {
            let expanded = entry.is_dir() && self.expanded.contains(&entry.rel);
            rows.push(Row {
                rel: entry.rel.clone(),
                name: entry.name().to_string(),
                depth,
                is_dir: entry.is_dir(),
                expanded,
            });
            if expanded {
                self.push_children(&entry.rel, depth + 1, rows);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_workspace::EntryKind;

    fn tree(paths: &[(&str, bool)]) -> Tree {
        paths
            .iter()
            .map(|(p, dir)| {
                (
                    p.to_string(),
                    Entry {
                        rel: p.to_string(),
                        kind: if *dir { EntryKind::Dir } else { EntryKind::File },
                        size: 0,
                        modified: None,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn rows_expand_and_reveal() {
        let t = tree(&[
            ("b.md", false),
            ("A.md", false),
            ("z", true),
            ("z/inner", true),
            ("z/inner/deep.md", false),
            ("z/c.md", false),
        ]);
        let mut m = TreeModel::new([]);
        m.set_tree(&t);
        let names: Vec<_> = m.rows().iter().map(|r| r.rel.as_str()).collect();
        assert_eq!(names, vec!["z", "A.md", "b.md"]);
        m.toggle("z");
        let names: Vec<_> = m.rows().iter().map(|r| r.rel.as_str()).collect();
        assert_eq!(names, vec!["z", "z/inner", "z/c.md", "A.md", "b.md"]);
        m.toggle("z");
        assert_eq!(m.reveal("z/inner/deep.md"), Some(2));
        assert_eq!(m.rows()[2].depth, 2);
        assert_eq!(m.expanded_sorted(), vec!["z", "z/inner"]);
        // A removed folder drops out of the expansion set.
        m.set_tree(&tree(&[("A.md", false)]));
        assert!(m.expanded.is_empty());
    }
}
