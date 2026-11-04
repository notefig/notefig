//! Ports of `utils/__tests__/dockable-layout.test.ts`, the `core.layout`
//! half of `modules/tabs/tabs-module.test.ts`, and reducer cases the dock's
//! drags exercise.

use std::cell::Cell;
use std::rc::Rc;

use crate::*;

fn two_windows() -> Vec<LayoutNode> {
    vec![LayoutNode::Panel(PanelNode {
        id: "panel-root".into(),
        orientation: Some(Orientation::Row),
        size: Some(1.),
        children: vec![
            LayoutNode::Window(WindowNode { id: "window-left".into(), children: vec!["a.md".into(), "b.md".into()], selected: "b.md".into(), size: Some(0.5) }),
            LayoutNode::Window(WindowNode { id: "window-right".into(), children: vec!["c.md".into()], selected: "c.md".into(), size: Some(0.5) }),
        ],
    })]
}

fn open(layout: &[LayoutNode], tab: &str, intent: OpenFileIntent, target: Option<&str>, move_if_open: bool) -> Vec<LayoutNode> {
    open_file_in_layout(layout, OpenFileInLayoutOptions { tab_id: tab, intent, target_window_id: target, move_if_open })
}

fn win_of<'a>(l: &'a [LayoutNode], tab: &str) -> Option<&'a WindowNode> {
    find_window_containing_tab(l, tab)
}

#[test]
fn rename_swaps_in_place_and_moves_selection() {
    let l = rename_tab_in_layout(&two_windows(), "a.md", "z.md");
    assert_eq!(win_of(&l, "z.md").unwrap().children, ["z.md", "b.md"]);
    assert_eq!(win_of(&l, "z.md").unwrap().selected, "b.md");
    let l = rename_tab_in_layout(&two_windows(), "b.md", "y.md");
    assert_eq!(win_of(&l, "y.md").unwrap().selected, "y.md");
    assert_eq!(rename_tab_in_layout(&two_windows(), "missing.md", "x.md"), two_windows());
}

#[test]
fn creates_initial_layout_and_round_trips_ts_json() {
    let l = create_initial_layout("first.md");
    let json = serialize_layout(&l);
    assert_eq!(json, r#"[{"type":"Window","id":"editor-window","selected":"first.md","children":["first.md"],"size":1.0}]"#);
    assert_eq!(parse_layout(Some(&json)), l);
    let ts = r#"[{"type":"Panel","id":"p","orientation":"row","children":[{"type":"Window","id":"w","children":["x"],"selected":"x","size":1}],"size":1}]"#;
    assert_eq!(extract_tab_ids(&parse_layout(Some(ts))), ["x"]);
    assert!(parse_layout(Some("{nope")).is_empty());
}

#[test]
fn resolves_target_and_replaces_or_appends() {
    let l = two_windows();
    assert_eq!(resolve_target_window_id(&l, Some("window-right")).unwrap(), "window-right");
    assert_eq!(resolve_target_window_id(&l, Some("missing")).unwrap(), "window-left");
    let n = replace_selected_tab_in_window(&l, "window-left", "x.md");
    assert_eq!(win_of(&n, "x.md").unwrap().children, ["a.md", "x.md"]);
    assert!(win_of(&n, "b.md").is_none());
    let n = open_tab_in_window(&l, "window-right", "d.md", OpenFileIntent::NewTab);
    assert_eq!(win_of(&n, "d.md").unwrap().children, ["c.md", "d.md"]);
    let n = open_tab_in_window(&l, "window-right", "d.md", OpenFileIntent::Replace);
    assert_eq!(win_of(&n, "d.md").unwrap().children, ["d.md"]);
}

#[test]
fn open_file_in_layout_cases() {
    assert_eq!(open(&[], "a.md", OpenFileIntent::Replace, None, false), create_initial_layout("a.md"));
    let l = two_windows();
    let n = open(&l, "new.md", OpenFileIntent::Replace, Some("window-left"), false);
    assert_eq!(win_of(&n, "new.md").unwrap().children, ["a.md", "new.md"]);
    let n = open(&l, "new.md", OpenFileIntent::NewTab, Some("window-left"), false);
    assert_eq!(win_of(&n, "new.md").unwrap().children, ["a.md", "b.md", "new.md"]);
    // Open elsewhere: selected in place, not duplicated.
    let n = open(&l, "a.md", OpenFileIntent::NewTab, Some("window-right"), false);
    assert_eq!(win_of(&n, "a.md").unwrap().id, "window-left");
    assert_eq!(win_of(&n, "a.md").unwrap().selected, "a.md");
    // moveIfOpen relocates; an emptied window collapses.
    let n = open(&l, "a.md", OpenFileIntent::NewTab, Some("window-right"), true);
    assert_eq!(win_of(&n, "a.md").unwrap().children, ["c.md", "a.md"]);
    assert_eq!(win_of(&n, "b.md").unwrap().children, ["b.md"]);
    let n = open(&l, "c.md", OpenFileIntent::NewTab, Some("window-left"), true);
    assert_ne!(resolve_target_window_id(&n, Some("window-right")).unwrap(), "window-right");
    // Agent ids ride the same layout.
    let n = open(&l, "agent:t1", OpenFileIntent::NewTab, Some("window-left"), false);
    let n = open(&n, "agent:t1", OpenFileIntent::NewTab, Some("window-right"), false);
    assert_eq!(extract_tab_ids(&n).iter().filter(|t| *t == "agent:t1").count(), 1);
}

#[test]
fn add_and_remove() {
    let n = add_tab_to_layout(&two_windows(), "x.md");
    assert_eq!(win_of(&n, "x.md").unwrap().id, "window-left");
    assert!(remove_tab_from_layout(&create_initial_layout("only.md"), "only.md").is_empty());
    let n = remove_tab_from_layout(&two_windows(), "c.md");
    assert!(find_window_by_id(&n, "window-right").is_none());
}

fn layout_over(search: &str) -> (Rc<MemoryUrl>, Rc<LayoutApi>) {
    let url = MemoryUrl::new(search);
    (url.clone(), Rc::new(create_layout(url)))
}

#[test]
fn core_layout_reads_one_reference_until_it_changes() {
    let mut p = SearchParams::default();
    p.set("layout", serialize_layout(&create_initial_layout("/a.md")));
    let (_url, layout) = layout_over(&p.to_search());
    let first = layout.read();
    assert!(Rc::ptr_eq(&first, &layout.read()));
    layout.update_with(|c| add_tab_to_layout(c, "/b.md"), Default::default());
    assert!(!Rc::ptr_eq(&first, &layout.read()));
    assert_eq!(layout.open_tab_ids(), ["/a.md", "/b.md"]);
}

#[test]
fn core_layout_keeps_other_params_and_notifies_only_on_layout_changes() {
    let mut p = SearchParams::parse("settings=open");
    p.set("layout", serialize_layout(&create_initial_layout("/a.md")));
    let (url, layout) = layout_over(&p.to_search());
    let calls = Rc::new(Cell::new(0));
    let c = calls.clone();
    let _sub = layout.subscribe(move || c.set(c.get() + 1));
    url.set_search(&format!("{}&sidebar=files", url.search()), false);
    assert_eq!(calls.get(), 0);
    layout.update(vec![], Default::default());
    assert_eq!(calls.get(), 1);
    assert_eq!(url.search(), "?settings=open&sidebar=files");
}

#[test]
fn core_layout_changes_other_params_in_the_same_write() {
    let (url, layout) = layout_over("?settings=open");
    layout.update(
        create_initial_layout("/a.md"),
        LayoutUpdateOptions { replace: false, params: Some(Box::new(|p| p.delete("settings"))) },
    );
    assert!(SearchParams::parse(&url.search()).get("settings").is_none());
    assert_eq!(layout.open_tab_ids(), ["/a.md"]);
}

#[test]
fn reducer_splits_moves_and_cleans_up() {
    let l = vec![LayoutNode::Window(WindowNode { id: "w".into(), children: vec!["a".into(), "b".into()], selected: "a".into(), size: Some(1.) })];
    // Drop "b" on the right edge of its own window: two windows in a row.
    let split = reduce(&l, DockAction::SplitWindow {
        tab_id: "b".into(),
        source_window_address: vec![0],
        target_window_address: vec![0],
        direction: SplitDirection::Right,
        orientation: Orientation::Row,
    });
    assert_eq!(windows(&split).len(), 2);
    assert_eq!(windows(&split)[1].children, ["b"]);
    assert!((split[0].size().unwrap() - 0.5).abs() < 1e-9);
    // A bottom split nests a column panel.
    let stacked = reduce(&split, DockAction::SplitWindow {
        tab_id: "a".into(),
        source_window_address: vec![0],
        target_window_address: vec![1],
        direction: SplitDirection::Bottom,
        orientation: Orientation::Row,
    });
    // "a" left its window, which emptied and collapsed.
    assert_eq!(stacked.len(), 1);
    assert!(matches!(&stacked[0], LayoutNode::Panel(p) if p.orientation == Some(Orientation::Column)));
    // Moving every tab back into one window collapses the panel.
    let back = reduce(&split, DockAction::MoveTab { tab_id: "b".into(), source_window_address: vec![1], target_window_address: vec![0] });
    assert_eq!(windows(&back).len(), 1);
    assert_eq!(windows(&back)[0].children, ["a", "b"]);
    assert_eq!(windows(&back)[0].selected, "b");
    // Reorder and resize.
    let r = reduce(&back, DockAction::ReorderTabs { source_tab_id: "b".into(), target_tab_id: "a".into(), address: vec![0] });
    assert_eq!(windows(&r)[0].children, ["b", "a"]);
    let r = reduce(&split, DockAction::Resize { sizes: vec![0.3, 0.7], address: vec![] });
    assert_eq!(r[1].size(), Some(0.7));
}
