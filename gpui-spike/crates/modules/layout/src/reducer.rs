//! The dock's own edits — resize, reorder, move, split, select — a port of
//! `components/dockable/reducer.ts`. The dock view dispatches these on a
//! drag or a divider move and hands the result to `core.tabs.apply_layout`.
//!
//! Addresses are index paths from the root panel (the layout's top-level
//! nodes are the root's children), as in TS.

use std::cell::Cell;

use crate::node::{LayoutNode, Orientation, PanelNode, WindowNode};

/// Where a tab dropped on a window's edge goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitDirection {
    Left,
    Right,
    Top,
    Bottom,
}

/// The dock's actions (`reducer.ts`'s `Action`).
#[derive(Clone, Debug, PartialEq)]
pub enum DockAction {
    /// New sizes for the children of the panel at `address`.
    Resize { sizes: Vec<f64>, address: Vec<usize> },
    /// Move `source_tab_id` to where `target_tab_id` is, in one window.
    ReorderTabs { source_tab_id: String, target_tab_id: String, address: Vec<usize> },
    SelectTab { tab_id: String, address: Vec<usize> },
    /// Move a tab to the end of another window's strip.
    MoveTab { tab_id: String, source_window_address: Vec<usize>, target_window_address: Vec<usize> },
    /// Drop a tab on a window's edge: a new window beside it.
    SplitWindow {
        tab_id: String,
        source_window_address: Vec<usize>,
        target_window_address: Vec<usize>,
        direction: SplitDirection,
        /// The orientation of the panel holding the target window.
        orientation: Orientation,
    },
    /// Drop a tab on a divider: a new window after `target_address`.
    InsertPanel { tab_id: String, source_address: Vec<usize>, target_address: Vec<usize> },
    SetState { children: Vec<LayoutNode> },
}

thread_local! {
    static NONCE: Cell<u64> = const { Cell::new(0) };
}

/// `"window-" + Date.now()`, unique within the process.
fn new_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let n = NONCE.with(|c| {
        c.set(c.get() + 1);
        c.get()
    });
    format!("{prefix}-{millis}-{n}")
}

/// Apply `action` to the layout (the root panel's children), returning the
/// new layout. Invalid addresses leave the layout as it was.
pub fn reduce(layout: &[LayoutNode], action: DockAction) -> Vec<LayoutNode> {
    let mut root = PanelNode {
        id: "root".into(),
        orientation: Some(Orientation::Row),
        size: Some(1.),
        children: layout.to_vec(),
    };
    if apply(&mut root, action).is_none() {
        return layout.to_vec();
    }
    root.children
}

fn node_at<'a>(root: &'a mut PanelNode, address: &[usize]) -> Option<&'a mut LayoutNode> {
    let (first, rest) = address.split_first()?;
    let mut node = root.children.get_mut(*first)?;
    for i in rest {
        match node {
            LayoutNode::Panel(p) => node = p.children.get_mut(*i)?,
            LayoutNode::Window(_) => return None,
        }
    }
    Some(node)
}

fn panel_at<'a>(root: &'a mut PanelNode, address: &[usize]) -> Option<&'a mut PanelNode> {
    if address.is_empty() {
        return Some(root);
    }
    match node_at(root, address)? {
        LayoutNode::Panel(p) => Some(p),
        LayoutNode::Window(_) => None,
    }
}

fn window_at<'a>(root: &'a mut PanelNode, address: &[usize]) -> Option<&'a mut WindowNode> {
    match node_at(root, address)? {
        LayoutNode::Window(w) => Some(w),
        LayoutNode::Panel(_) => None,
    }
}

fn take_tab(window: &mut WindowNode, tab_id: &str) -> Option<()> {
    let index = window.children.iter().position(|c| c == tab_id)?;
    window.children.remove(index);
    window.selected = window.children.first().cloned().unwrap_or_default();
    Some(())
}

fn apply(root: &mut PanelNode, action: DockAction) -> Option<()> {
    match action {
        DockAction::SetState { children } => root.children = children,
        DockAction::Resize { sizes, address } => {
            let panel = panel_at(root, &address)?;
            for (child, size) in panel.children.iter_mut().zip(sizes) {
                child.set_size(Some(size));
            }
        }
        DockAction::SelectTab { tab_id, address } => {
            window_at(root, &address)?.selected = tab_id;
        }
        DockAction::ReorderTabs { source_tab_id, target_tab_id, address } => {
            let w = window_at(root, &address)?;
            let from = w.children.iter().position(|c| *c == source_tab_id)?;
            let to = w.children.iter().position(|c| *c == target_tab_id)?;
            let tab = w.children.remove(from);
            w.children.insert(to, tab);
            w.selected = source_tab_id;
        }
        DockAction::MoveTab { tab_id, source_window_address, target_window_address } => {
            if source_window_address == target_window_address {
                return Some(());
            }
            let source = window_at(root, &source_window_address)?;
            let index = source.children.iter().position(|c| *c == tab_id)?;
            source.children.remove(index);
            if source.children.is_empty() {
                source.selected.clear();
            } else if source.selected == tab_id {
                source.selected = source.children[0].clone();
            }
            let target = window_at(root, &target_window_address)?;
            target.children.push(tab_id.clone());
            target.selected = tab_id;
            cleanup(root);
        }
        DockAction::InsertPanel { tab_id, source_address, target_address } => {
            take_tab(window_at(root, &source_address)?, &tab_id)?;
            let (index, parent) = target_address.split_last()?;
            let parent = panel_at(root, parent)?;
            let new_window = LayoutNode::Window(WindowNode {
                id: new_id("window"),
                children: vec![tab_id.clone()],
                selected: tab_id,
                size: Some(1.),
            });
            let at = (index + 1).min(parent.children.len());
            parent.children.insert(at, new_window);
            cleanup(root);
        }
        DockAction::SplitWindow {
            tab_id,
            source_window_address,
            target_window_address,
            direction,
            orientation,
        } => {
            let same = source_window_address == target_window_address;
            {
                let source = window_at(root, &source_window_address)?;
                if same && source.children.len() == 1 {
                    return Some(());
                }
                take_tab(source, &tab_id)?;
            }
            let mut new_window = WindowNode {
                id: new_id("window"),
                children: vec![tab_id.clone()],
                selected: tab_id,
                size: None,
            };
            let aligned = matches!(
                (orientation, direction),
                (Orientation::Row, SplitDirection::Left | SplitDirection::Right)
                    | (Orientation::Column, SplitDirection::Top | SplitDirection::Bottom)
            );
            let (index, parent_address) = target_window_address.split_last()?;
            let parent = panel_at(root, parent_address)?;
            let target = parent.children.get_mut(*index)?;
            let before = matches!(direction, SplitDirection::Left | SplitDirection::Top);
            if aligned {
                let half = target.size().unwrap_or(1.) / 2.;
                target.set_size(Some(half));
                new_window.size = Some(half);
                let at = index + if before { 0 } else { 1 };
                parent.children.insert(at, LayoutNode::Window(new_window));
            } else {
                let mut old = target.clone();
                let size = old.size();
                old.set_size(Some(1.));
                new_window.size = Some(1.);
                let new_node = LayoutNode::Window(new_window);
                let children = if before { vec![new_node, old] } else { vec![old, new_node] };
                // TS leaves the new panel's orientation unset; the dock
                // renders an unset panel across its parent's axis.
                *target = LayoutNode::Panel(PanelNode {
                    id: new_id("panel"),
                    orientation: Some(match orientation {
                        Orientation::Row => Orientation::Column,
                        Orientation::Column => Orientation::Row,
                    }),
                    size,
                    children,
                });
            }
            cleanup(root);
        }
    }
    Some(())
}

/// Drop empty windows and panels, inline a panel whose one child is a
/// panel, and renormalize sizes.
fn cleanup(root: &mut PanelNode) {
    let children = &mut root.children;
    let mut i = children.len();
    while i > 0 {
        i -= 1;
        let remove = match &mut children[i] {
            LayoutNode::Window(w) => w.children.is_empty(),
            LayoutNode::Panel(panel) => {
                cleanup(panel);
                let mut flat = Vec::new();
                for child in std::mem::take(&mut panel.children) {
                    match child {
                        LayoutNode::Panel(mut inner)
                            if inner.children.len() == 1 && matches!(inner.children[0], LayoutNode::Panel(_)) =>
                        {
                            let parent_size = inner.size.unwrap_or(1.);
                            if let LayoutNode::Panel(only) = inner.children.remove(0) {
                                for mut grandchild in only.children {
                                    let s = grandchild.size().unwrap_or(1.);
                                    grandchild.set_size(Some(s * parent_size));
                                    flat.push(grandchild);
                                }
                            }
                        }
                        other => flat.push(other),
                    }
                }
                normalize(&mut flat);
                panel.children = flat;
                panel.children.is_empty()
            }
        };
        if remove {
            children.remove(i);
            normalize(children);
        }
    }
}

fn normalize(children: &mut [LayoutNode]) {
    let total: f64 = children.iter().map(|c| c.size().filter(|s| *s != 0.).unwrap_or(1.)).sum();
    for child in children {
        let s = child.size().filter(|s| *s != 0.);
        child.set_size(Some(match s {
            Some(s) => s / total,
            None => 1.,
        }));
    }
}
