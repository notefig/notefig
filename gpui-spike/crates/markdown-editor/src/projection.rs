//! Projection of the editing model into the shared renderer's `BlockNode`s
//! (design §7.3, D3).
//!
//! Each top-level block is projected directly into `BlockNode`s
//! (`direct.rs`), so the editor renders through the same renderer as
//! `TextView`. Every text leaf's `InlineState` is tagged with its `BlockId` as the
//! `editor_key`, which is how the renderer reports layouts back (the seam
//! in `text::editor_seam`). A top-level block is re-projected only when its
//! per-block revision changes, so one keystroke re-projects one block.

use std::rc::Rc;

use super::{
    direct::NodeCache,
    document::{BlockContent, EditorDocument},
    id::BlockId,
    kind::BlockKindData,
};
use gpui_kit::base::text::editor_host::BlockNode;

/// One projected top-level block.
pub(crate) struct ProjectedBlock {
    pub(crate) id: BlockId,
    revision: u64,
    pub(crate) nodes: Vec<BlockNode>,
}

/// Geometry facts the frame needs about a caret leaf.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LeafInfo {
    pub(crate) block: BlockId,
    /// Caret offsets are 0/1 (code blocks in the spike).
    pub(crate) atomic: bool,
    /// Model text length (bytes); for atomic leaves the rendered text length.
    pub(crate) len: usize,
}

#[derive(Default)]
pub(crate) struct Snapshot {
    pub(crate) blocks: Vec<Rc<ProjectedBlock>>,
    /// Leaves that have a rendered text layout, in document order.
    pub(crate) leaves: Rc<Vec<LeafInfo>>,
    /// Tables and their keyed cells, for node selection (no caret in cells).
    pub(crate) tables: Rc<Vec<(BlockId, Vec<BlockId>)>>,
    /// Index of each top-level block among the root's children.
    pub(crate) top_index: Rc<super::id::IdMap<usize>>,
}

#[derive(Default)]
pub(crate) struct ProjectionCache {
    revision: Option<u64>,
    snapshot: Rc<Snapshot>,
    by_id: super::id::IdMap<Rc<ProjectedBlock>>,
    pub(crate) nodes: NodeCache,
    /// `cfg(test)`-checked perf counter (D9): snapshot rebuilds.
    pub(crate) rebuilds: usize,
    /// The document structure (order generation, root) of the snapshot.
    order_gen: Option<(u64, BlockId)>,
}

impl ProjectionCache {
    pub(crate) fn snapshot(&mut self, doc: &EditorDocument) -> Rc<Snapshot> {
        if self.revision == Some(doc.revision) {
            return self.snapshot.clone();
        }
        self.rebuilds += 1;
        let top = doc.children(doc.root);
        // Same structure as the last snapshot (a text edit): reuse the
        // block list, re-projecting only blocks whose revision moved, and
        // the table and index maps.
        let same_structure = self.order_gen == Some((doc.order_gen, doc.root))
            && self.snapshot.blocks.len() == top.len();
        let mut blocks = Vec::with_capacity(top.len());
        if same_structure {
            for (ix, id) in top.iter().enumerate() {
                let prev = &self.snapshot.blocks[ix];
                let revision = doc.block_revision(*id);
                if prev.id == *id && prev.revision == revision {
                    blocks.push(prev.clone());
                    continue;
                }
                let block = Rc::new(ProjectedBlock {
                    id: *id,
                    revision,
                    nodes: self.nodes.node(doc, *id).into_iter().collect(),
                });
                self.by_id.insert(*id, block.clone());
                blocks.push(block);
            }
        } else {
            let mut by_id = super::id::IdMap::with_capacity_and_hasher(top.len(), Default::default());
            for id in top {
                let revision = doc.block_revision(*id);
                let block = match self.by_id.get(id) {
                    Some(prev) if prev.revision == revision => prev.clone(),
                    _ => Rc::new(ProjectedBlock {
                        id: *id,
                        revision,
                        nodes: self.nodes.node(doc, *id).into_iter().collect(),
                    }),
                };
                by_id.insert(*id, block.clone());
                blocks.push(block);
            }
            self.by_id = by_id;
            self.nodes.collect_garbage(doc);
        }
        let leaves = doc
            .leaves()
            .iter()
            .filter_map(|id| leaf_info(doc, *id))
            .collect();
        let (tables, top_index) = if same_structure {
            (self.snapshot.tables.clone(), self.snapshot.top_index.clone())
        } else {
            let mut tables: Vec<(BlockId, Vec<BlockId>)> = Vec::new();
            for id in doc.leaves() {
                if doc.kind(*id) != Some(&BlockKindData::TableCell) {
                    continue;
                }
                let Some(table) = doc
                    .path(*id)
                    .into_iter()
                    .rev()
                    .find(|b| matches!(doc.kind(*b), Some(BlockKindData::Table { .. })))
                else {
                    continue;
                };
                match tables.last_mut() {
                    Some((last, cells)) if *last == table => cells.push(*id),
                    _ => tables.push((table, vec![*id])),
                }
            }
            let top_index = top
                .iter()
                .enumerate()
                .map(|(ix, id)| (*id, ix))
                .collect::<super::id::IdMap<usize>>();
            (Rc::new(tables), Rc::new(top_index))
        };
        self.snapshot = Rc::new(Snapshot {
            blocks,
            leaves: Rc::new(leaves),
            tables,
            top_index,
        });
        self.revision = Some(doc.revision);
        self.order_gen = Some((doc.order_gen, doc.root));
        self.snapshot.clone()
    }

    /// Whether images are projected as placeholders; a change drops the cache.
    pub(crate) fn set_placeholders(&mut self, placeholders: bool) {
        if self.nodes.placeholders != placeholders {
            self.invalidate();
            self.nodes.placeholders = placeholders;
        }
    }

    /// Drop the projection of every top-level block not in `keep` (their
    /// nodes, and the inline states the renderer retains layouts for, die).
    pub(crate) fn evict_except(
        &mut self,
        doc: &EditorDocument,
        keep: &std::collections::HashSet<BlockId>,
    ) {
        let drop: Vec<BlockId> = self
            .by_id
            .keys()
            .filter(|id| !keep.contains(id))
            .copied()
            .collect();
        for id in drop {
            self.by_id.remove(&id);
            self.nodes.evict_subtree(doc, id);
        }
        self.revision = None;
        self.order_gen = None;
    }

    /// Top-level index of `id` in the current snapshot.
    pub(crate) fn top_index(&self, id: BlockId) -> Option<usize> {
        self.snapshot.top_index.get(&id).copied()
    }

    pub(crate) fn invalidate(&mut self) {
        self.revision = None;
        self.order_gen = None;
        self.by_id.clear();
        self.nodes.clear();
    }

    /// Nodes and table rows built rather than reused (D9).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn built(&self) -> usize {
        self.nodes.built
    }
}

fn leaf_info(doc: &EditorDocument, id: BlockId) -> Option<LeafInfo> {
    let entry = doc.get(id)?;
    match &entry.content {
        BlockContent::Inline(inline) => Some(LeafInfo {
            block: id,
            atomic: false,
            len: inline.len(),
        }),
        BlockContent::Plain(code) => Some(LeafInfo {
            block: id,
            atomic: false,
            len: code.len(),
        }),
        _ => None,
    }
}
