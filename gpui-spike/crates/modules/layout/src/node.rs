//! The dock's layout tree (`components/dockable/utils/serializeLayout.ts`),
//! its codec (`utils/layout-codec.ts`) and the pure edits the app makes to
//! it (`utils/dockable-layout.ts`). Serialized exactly as the TS app writes
//! it into `?layout=`.

use serde::{Deserialize, Serialize};

/// `LayoutNode`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LayoutNode {
    Window(WindowNode),
    Panel(PanelNode),
}

/// A dock window: a tab strip over the selected tab.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowNode {
    pub id: String,
    /// The selected tab id ("" for none).
    pub selected: String,
    /// Tab ids, in strip order.
    pub children: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    /// Children side by side.
    Row,
    /// Children stacked.
    Column,
}

/// A split: children laid out along `orientation` by their `size` share.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PanelNode {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<Orientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    pub children: Vec<LayoutNode>,
}

impl LayoutNode {
    pub fn id(&self) -> &str {
        match self {
            LayoutNode::Window(w) => &w.id,
            LayoutNode::Panel(p) => &p.id,
        }
    }

    pub fn size(&self) -> Option<f64> {
        match self {
            LayoutNode::Window(w) => w.size,
            LayoutNode::Panel(p) => p.size,
        }
    }

    pub fn set_size(&mut self, size: Option<f64>) {
        match self {
            LayoutNode::Window(w) => w.size = size,
            LayoutNode::Panel(p) => p.size = size,
        }
    }

    pub fn window(id: &str, children: &[&str], selected: &str) -> Self {
        LayoutNode::Window(WindowNode {
            id: id.into(),
            selected: selected.into(),
            children: children.iter().map(|s| s.to_string()).collect(),
            size: None,
        })
    }
}

// ---------------------------------------------------------------------------
// The codec (`utils/layout-codec.ts`).
// ---------------------------------------------------------------------------

pub const LAYOUT_PARAM: &str = "layout";

/// Parse a JSON-encoded `LayoutNode[]`; `[]` on any failure.
pub fn parse_layout(raw: Option<&str>) -> Vec<LayoutNode> {
    raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default()
}

pub fn serialize_layout(layout: &[LayoutNode]) -> String {
    serde_json::to_string(layout).unwrap_or_else(|_| "[]".into())
}

/// Every tab id in the tree, in window order.
pub fn extract_tab_ids(nodes: &[LayoutNode]) -> Vec<String> {
    let mut ids = Vec::new();
    for node in nodes {
        match node {
            LayoutNode::Window(w) => ids.extend(w.children.iter().cloned()),
            LayoutNode::Panel(p) => ids.extend(extract_tab_ids(&p.children)),
        }
    }
    ids
}

/// The selected tab of the first window that has one.
pub fn find_layout_selected_tab(nodes: &[LayoutNode]) -> Option<String> {
    for node in nodes {
        match node {
            LayoutNode::Window(w) if !w.selected.is_empty() => return Some(w.selected.clone()),
            LayoutNode::Panel(p) => {
                if let Some(found) = find_layout_selected_tab(&p.children) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Edits (`utils/dockable-layout.ts`).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum OpenFileIntent {
    /// Swap out the target window's selected tab.
    #[default]
    Replace,
    NewTab,
}

pub struct OpenFileInLayoutOptions<'a> {
    pub tab_id: &'a str,
    pub intent: OpenFileIntent,
    pub target_window_id: Option<&'a str>,
    /// When the tab is open in another window than the target, move it
    /// there (only explicit placement gestures set this).
    pub move_if_open: bool,
}

fn map_windows(nodes: &[LayoutNode], f: &mut dyn FnMut(&WindowNode) -> WindowNode) -> Vec<LayoutNode> {
    nodes
        .iter()
        .map(|node| match node {
            LayoutNode::Window(w) => LayoutNode::Window(f(w)),
            LayoutNode::Panel(p) => LayoutNode::Panel(PanelNode {
                children: map_windows(&p.children, f),
                ..p.clone()
            }),
        })
        .collect()
}

pub fn find_first_window(nodes: &[LayoutNode]) -> Option<&WindowNode> {
    for node in nodes {
        match node {
            LayoutNode::Window(w) => return Some(w),
            LayoutNode::Panel(p) => {
                if let Some(w) = find_first_window(&p.children) {
                    return Some(w);
                }
            }
        }
    }
    None
}

pub fn find_window_by_id<'a>(nodes: &'a [LayoutNode], id: &str) -> Option<&'a WindowNode> {
    find_window(nodes, &|w| w.id == id)
}

pub fn find_window_containing_tab<'a>(nodes: &'a [LayoutNode], tab_id: &str) -> Option<&'a WindowNode> {
    find_window(nodes, &|w| w.children.iter().any(|c| c == tab_id))
}

fn find_window<'a>(nodes: &'a [LayoutNode], pred: &dyn Fn(&WindowNode) -> bool) -> Option<&'a WindowNode> {
    for node in nodes {
        match node {
            LayoutNode::Window(w) if pred(w) => return Some(w),
            LayoutNode::Panel(p) => {
                if let Some(w) = find_window(&p.children, pred) {
                    return Some(w);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every window, in tree order.
pub fn windows(nodes: &[LayoutNode]) -> Vec<&WindowNode> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            LayoutNode::Window(w) => out.push(w),
            LayoutNode::Panel(p) => out.extend(windows(&p.children)),
        }
    }
    out
}

/// Add a tab to the first window and select it.
pub fn add_tab_to_layout(layout: &[LayoutNode], tab_id: &str) -> Vec<LayoutNode> {
    match find_first_window(layout) {
        None => create_initial_layout(tab_id),
        Some(w) => {
            let id = w.id.clone();
            open_tab_in_window(layout, &id, tab_id, OpenFileIntent::NewTab)
        }
    }
}

/// Swap a tab id in place: same window, same index; selection follows.
pub fn rename_tab_in_layout(layout: &[LayoutNode], old_id: &str, new_id: &str) -> Vec<LayoutNode> {
    map_windows(layout, &mut |w| {
        if !w.children.iter().any(|c| c == old_id) {
            return w.clone();
        }
        WindowNode {
            children: w.children.iter().map(|c| if c == old_id { new_id.to_string() } else { c.clone() }).collect(),
            selected: if w.selected == old_id { new_id.to_string() } else { w.selected.clone() },
            ..w.clone()
        }
    })
}

/// Select `tab_id` in the window that holds it.
pub fn select_tab_in_layout(layout: &[LayoutNode], tab_id: &str) -> Vec<LayoutNode> {
    map_windows(layout, &mut |w| {
        if w.children.iter().any(|c| c == tab_id) {
            WindowNode { selected: tab_id.to_string(), ..w.clone() }
        } else {
            w.clone()
        }
    })
}

/// A target window id, falling back to the first window.
pub fn resolve_target_window_id(layout: &[LayoutNode], preferred: Option<&str>) -> Option<String> {
    if let Some(p) = preferred
        && find_window_by_id(layout, p).is_some()
    {
        return Some(p.to_string());
    }
    find_first_window(layout).map(|w| w.id.clone())
}

/// Replace the selected tab in a window and select the replacement.
pub fn replace_selected_tab_in_window(layout: &[LayoutNode], window_id: &str, next_tab_id: &str) -> Vec<LayoutNode> {
    map_windows(layout, &mut |w| {
        if w.id != window_id {
            return w.clone();
        }
        if w.children.is_empty() {
            return WindowNode {
                children: vec![next_tab_id.into()],
                selected: next_tab_id.into(),
                ..w.clone()
            };
        }
        let index = w.children.iter().position(|c| *c == w.selected).unwrap_or(0);
        let mut children = w.children.clone();
        children[index] = next_tab_id.into();
        WindowNode {
            children,
            selected: next_tab_id.into(),
            ..w.clone()
        }
    })
}

pub fn open_tab_in_window(layout: &[LayoutNode], window_id: &str, tab_id: &str, mode: OpenFileIntent) -> Vec<LayoutNode> {
    if mode == OpenFileIntent::Replace {
        return replace_selected_tab_in_window(layout, window_id, tab_id);
    }
    map_windows(layout, &mut |w| {
        if w.id != window_id {
            return w.clone();
        }
        let mut children = w.children.clone();
        children.push(tab_id.into());
        WindowNode {
            children,
            selected: tab_id.into(),
            ..w.clone()
        }
    })
}

/// Open with an explicit intent; an open tab is selected (or moved, with
/// `move_if_open`).
pub fn open_file_in_layout(layout: &[LayoutNode], options: OpenFileInLayoutOptions<'_>) -> Vec<LayoutNode> {
    let OpenFileInLayoutOptions {
        tab_id,
        intent,
        target_window_id,
        move_if_open,
    } = options;
    if let Some(existing) = find_window_containing_tab(layout, tab_id) {
        if move_if_open
            && let Some(target) = target_window_id
            && existing.id != target
            && find_window_by_id(layout, target).is_some()
        {
            let without = remove_tab_from_layout(layout, tab_id);
            return open_tab_in_window(&without, target, tab_id, OpenFileIntent::NewTab);
        }
        return select_tab_in_layout(layout, tab_id);
    }
    if layout.is_empty() {
        return create_initial_layout(tab_id);
    }
    match resolve_target_window_id(layout, target_window_id) {
        None => create_initial_layout(tab_id),
        Some(target) => open_tab_in_window(layout, &target, tab_id, intent),
    }
}

pub const INITIAL_WINDOW_ID: &str = "editor-window";

pub fn create_initial_layout(tab_id: &str) -> Vec<LayoutNode> {
    vec![LayoutNode::Window(WindowNode {
        id: INITIAL_WINDOW_ID.into(),
        children: vec![tab_id.into()],
        selected: tab_id.into(),
        size: Some(1.),
    })]
}

/// Remove a tab; a window left empty is removed, and so is an empty panel.
pub fn remove_tab_from_layout(layout: &[LayoutNode], tab_id: &str) -> Vec<LayoutNode> {
    layout
        .iter()
        .filter_map(|node| match node {
            LayoutNode::Window(w) => {
                let children: Vec<String> = w.children.iter().filter(|c| *c != tab_id).cloned().collect();
                if children.is_empty() {
                    return None;
                }
                let selected = if w.selected == tab_id { children[0].clone() } else { w.selected.clone() };
                Some(LayoutNode::Window(WindowNode {
                    children,
                    selected,
                    ..w.clone()
                }))
            }
            LayoutNode::Panel(p) => {
                let children = remove_tab_from_layout(&p.children, tab_id);
                if children.is_empty() {
                    None
                } else {
                    Some(LayoutNode::Panel(PanelNode { children, ..p.clone() }))
                }
            }
        })
        .collect()
}
