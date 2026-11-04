//! Port of `tree-model.test.ts`, plus the model behaviours trees gave the
//! TS app for free (flattening, keyboard moves, inline create).

use crate::*;

fn p(path: &str, is_dir: bool, modified_ms: u64) -> TreePath {
    TreePath { path: path.into(), is_dir, modified_ms }
}

fn sample() -> Vec<TreePath> {
    vec![
        p(".notefig", true, 0),
        p(".notefig/scratchpads", true, 0),
        p(".notefig/scratchpads/sunny-otter.md", false, 5),
        p("a.md", false, 1),
        p("Zeta", true, 9),
        p("Zeta/inner.md", false, 2),
        p("beta.md", false, 7),
    ]
}

fn labels(m: &TreeModel) -> Vec<String> {
    m.rows().iter().map(|r| r.label.clone()).collect()
}

#[test]
fn keeps_the_scratchpads_root_above_regular_files_in_every_order() {
    for order in [SortOrder::NameAsc, SortOrder::NameDesc, SortOrder::DateModified] {
        let mut m = TreeModel::new(order);
        m.reset_paths(sample());
        assert_eq!(m.rows()[0].label, ".notefig / scratchpads", "{order:?}");
        assert_eq!(m.rows()[0].path, ".notefig/scratchpads");
    }
}

#[test]
fn orders_regular_root_items_by_the_sort_state_files_and_folders_together() {
    let mut m = TreeModel::new(SortOrder::NameAsc);
    m.reset_paths(sample());
    assert_eq!(labels(&m)[1..], ["a.md", "beta.md", "Zeta"]);
    m.set_sort(SortOrder::NameDesc);
    assert_eq!(labels(&m)[1..], ["Zeta", "beta.md", "a.md"]);
    m.set_sort(SortOrder::DateModified);
    assert_eq!(labels(&m)[1..], ["Zeta", "beta.md", "a.md"]);
}

#[test]
fn expansion_reveal_and_keyboard_moves() {
    let mut m = TreeModel::new(SortOrder::NameAsc);
    m.reset_paths(sample());
    m.toggle("Zeta");
    assert_eq!(labels(&m).last().unwrap(), "inner.md");
    assert_eq!(m.rows().last().unwrap().depth, 1);
    m.toggle("Zeta");
    assert_eq!(m.reveal("Zeta/inner.md"), Some(4));
    m.set_focused(Some("Zeta"));
    m.focus_left();
    assert!(!m.is_expanded("Zeta"));
    m.focus_right();
    assert!(m.is_expanded("Zeta"));
    m.focus_right();
    assert_eq!(m.focused(), Some("Zeta/inner.md"));
    m.focus_left();
    assert_eq!(m.focused(), Some("Zeta"));
    m.move_focus(-1, true);
    assert_eq!(m.selected_paths(), vec!["Zeta".to_string(), "beta.md".to_string()]);
    m.focus_edge(false);
    assert_eq!(m.focused(), Some(".notefig/scratchpads"));
}

#[test]
fn inline_create_proposes_untitled_names_and_cancel_removes_the_placeholder() {
    let mut m = TreeModel::new(SortOrder::NameAsc);
    m.reset_paths(vec![p("untitled.md", false, 0), p("docs", true, 0)]);
    let placeholder = m.start_creating("", false);
    assert_eq!(placeholder, "untitled-2.md");
    assert!(m.rows().iter().any(|r| r.renaming && r.path == "untitled-2.md"));
    // A data tick mid-entry keeps the placeholder.
    m.reset_paths(vec![p("untitled.md", false, 0), p("docs", true, 0)]);
    assert!(m.contains("untitled-2.md"));
    m.cancel_rename();
    assert!(!m.contains("untitled-2.md"));
    let folder = m.start_creating("docs", true);
    assert_eq!(folder, "docs/untitled");
    assert!(m.is_expanded("docs"));
    let commit = m.commit_rename("notes").unwrap();
    assert_eq!(commit, RenameCommit { source: "docs/untitled".into(), destination: "docs/notes".into(), is_dir: true, was_placeholder: true });
}

#[test]
fn rename_commits_only_a_real_change() {
    let mut m = TreeModel::new(SortOrder::NameAsc);
    m.reset_paths(vec![p("a.md", false, 0)]);
    assert!(m.start_renaming("a.md"));
    assert_eq!(m.commit_rename("a.md"), None);
    m.start_renaming("a.md");
    assert_eq!(m.commit_rename("bad/name"), None);
    m.start_renaming("a.md");
    assert_eq!(m.commit_rename(" b.md ").unwrap().destination, "b.md");
}

#[test]
fn drop_rules() {
    assert!(!can_move(".notefig/scratchpads", |_| false));
    assert!(!can_move("docs", |p| p == "docs"));
    assert!(can_move(".notefig/scratchpads/a.md", |_| false));
    assert_eq!(drop_destination("a.md", "docs").as_deref(), Some("docs/a.md"));
    assert_eq!(drop_destination("docs/a.md", "docs"), None);
    assert_eq!(drop_destination("docs", "docs/sub"), None);
    assert_eq!(drop_destination("docs/a.md", "").as_deref(), Some("a.md"));
}

#[test]
fn the_workspace_model_outlives_a_mount() {
    let tm = create_workspace_tree_model();
    let a = tm.acquire(TreeModelInit { order: SortOrder::NameAsc, initial_selected: None, initial_expanded: None });
    a.borrow_mut().model.reset_paths(sample());
    let b = tm.acquire(TreeModelInit { order: SortOrder::NameDesc, initial_selected: None, initial_expanded: Some(vec![]) });
    assert!(std::rc::Rc::ptr_eq(&a, &b));
    assert!(b.borrow().needs_default_expansion);
}
