//! Change tracking for agent rounds (Notefig spec §3.2.7).
//!
//! A transaction whose origin is [`EditOrigin::Agent`] with a round that is
//! being tracked records every span its steps touched. Every later
//! transaction (including undo and redo) maps the recorded spans; a span
//! whose block is removed is dropped, a span that collapses is dropped unless
//! it recorded a pure deletion.

use std::collections::HashSet;
use std::ops::Range;

use super::{
    document::{BlockContent, EditorDocument},
    id::BlockId,
    position::BlockPosition,
    step::{DetachedBlock, DetachedContent, Step, StepMap},
    transaction::EditOrigin,
};

/// Identifies an agent round (a prompt widget's turn). The app chooses the
/// numbers; the editor only compares them.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct RoundId(pub u64);

/// A span an agent round changed: `range` is a byte range in the leaf
/// `block`'s flat text (an empty range marks a pure deletion).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackedChange {
    pub round: RoundId,
    pub block: BlockId,
    pub range: Range<usize>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ChangeTracker {
    pub(crate) tracking: HashSet<RoundId>,
    pub(crate) changes: Vec<TrackedChange>,
}

impl ChangeTracker {
    /// Map recorded spans through `maps`, then record the spans of `steps`
    /// when `origin` is a tracked agent round. `inverse` (aligned so that
    /// `inverse[n - 1 - i]` undoes `steps[i]`) lets text a join moved into
    /// another block keep its span; `doc` is the document after the steps.
    pub(crate) fn apply(
        &mut self,
        origin: EditOrigin,
        steps: &[Step],
        maps: &[StepMap],
        inverse: &[Step],
        doc: &EditorDocument,
    ) {
        if self.changes.is_empty() && self.tracking.is_empty() {
            return;
        }
        let reloc = relocations(steps, inverse);
        self.changes
            .retain_mut(|change| map_change(change, maps, 0, &reloc));
        let EditOrigin::Agent { round: Some(round) } = origin else {
            return;
        };
        if !self.tracking.contains(&round) {
            return;
        }
        for (ix, step) in steps.iter().enumerate() {
            let mut spans = Vec::new();
            touched(step, &mut spans);
            for (block, range) in spans {
                let mut change = TrackedChange {
                    round,
                    block,
                    range,
                };
                if map_change(&mut change, maps, ix + 1, &reloc) {
                    self.changes.push(change);
                }
            }
            // A removed block leaves a zero-width deletion marker where it
            // was (at the start of what follows it, else the end of what
            // precedes it), in the document after the transaction.
            if let Step::RemoveBlocks { parent, range } = step
                && doc.get(*parent).is_some()
            {
                let siblings = doc.children(*parent);
                let anchor = match siblings.get(range.start) {
                    Some(next) => Some(doc.first_leaf_in(*next)),
                    None => range
                        .start
                        .checked_sub(1)
                        .and_then(|i| siblings.get(i))
                        .map(|prev| doc.last_leaf_in(*prev)),
                };
                if let Some(anchor) = anchor
                    && doc.leaf_len(anchor.block).is_some()
                {
                    let marker = TrackedChange {
                        round,
                        block: anchor.block,
                        range: anchor.offset..anchor.offset,
                    };
                    if !self.changes.contains(&marker) {
                        self.changes.push(marker);
                    }
                }
            }
        }
    }

    /// Drop spans whose block no longer exists or that fall outside it.
    pub(crate) fn validate(&mut self, doc: &EditorDocument) {
        self.changes.retain(|change| {
            doc.leaf_len(change.block)
                .is_some_and(|len| change.range.end <= len)
        });
    }
}

/// For each step index that removes blocks: removed leaf -> (block, base
/// offset) its text was appended to earlier in the same transaction (a join).
/// Entries: (removed leaf, target block, base offset, step index after which
/// the target offset is valid).
type Relocations = std::collections::HashMap<usize, Vec<(BlockId, BlockId, usize, usize)>>;

fn relocations(steps: &[Step], inverse: &[Step]) -> Relocations {
    let mut out = Relocations::new();
    let n = steps.len();
    if inverse.len() != n {
        return out;
    }
    for (i, step) in steps.iter().enumerate() {
        if !matches!(step, Step::RemoveBlocks { .. }) {
            continue;
        }
        let Step::InsertBlocks { blocks, .. } = &inverse[n - 1 - i] else {
            continue;
        };
        let mut removed = Vec::new();
        for block in blocks {
            inline_leaves(block, &mut removed);
        }
        for (leaf, text) in removed {
            if text.is_empty() {
                continue;
            }
            let target = steps.iter().enumerate().find_map(|(j, s)| match s {
                Step::ReplaceText {
                    block,
                    range,
                    insert,
                } if j != i && insert.text().ends_with(text.as_str()) => {
                    Some((*block, range.start + insert.len() - text.len(), j))
                }
                _ => None,
            });
            if let Some((block, base, j)) = target {
                out.entry(i).or_default().push((leaf, block, base, j));
            }
        }
    }
    out
}

fn inline_leaves(block: &DetachedBlock, out: &mut Vec<(BlockId, String)>) {
    match &block.content {
        DetachedContent::Children(children) => {
            for child in children {
                inline_leaves(child, out);
            }
        }
        DetachedContent::Leaf(BlockContent::Inline(inline)) => {
            out.push((block.id, inline.text().to_string()))
        }
        DetachedContent::Leaf(_) => {}
    }
}

fn map_change(change: &mut TrackedChange, maps: &[StepMap], first: usize, reloc: &Relocations) -> bool {
    let deletion = change.range.is_empty();
    let mut start = BlockPosition::new(change.block, change.range.start);
    let mut end = BlockPosition::new(change.block, change.range.end);
    let mut i = first;
    while i < maps.len() {
        match (maps[i].map(start), maps[i].map(end)) {
            (Some(a), Some(b)) => {
                start = a;
                end = b;
            }
            _ => {
                // Text a join moved elsewhere keeps its span.
                let moved = reloc.get(&i).and_then(|list| {
                    list.iter().find(|(leaf, ..)| *leaf == start.block)
                });
                let Some((_, block, base, j)) = moved else {
                    return false;
                };
                start = BlockPosition::new(*block, base + start.offset);
                end = BlockPosition::new(*block, base + end.offset);
                i = i.max(*j);
            }
        }
        i += 1;
    }
    if start.offset > end.offset || (!deletion && start.offset == end.offset) {
        return false;
    }
    change.block = start.block;
    change.range = start.offset..end.offset;
    true
}

fn touched(step: &Step, out: &mut Vec<(BlockId, Range<usize>)>) {
    match step {
        Step::ReplaceText {
            block,
            range,
            insert,
        } => out.push((*block, range.start..range.start + insert.len())),
        Step::ReplacePlain {
            block,
            range,
            insert,
        } => out.push((*block, range.start..range.start + insert.len())),
        Step::InsertBlocks { blocks, .. } => {
            for block in blocks {
                leaves(block, out);
            }
        }
        Step::RemoveBlocks { .. } | Step::SetKind { .. } => {}
        Step::SetFrontmatter { .. } | Step::SetSourceMap { .. } => {}
    }
}

fn leaves(block: &DetachedBlock, out: &mut Vec<(BlockId, Range<usize>)>) {
    match &block.content {
        DetachedContent::Children(children) => {
            for child in children {
                leaves(child, out);
            }
        }
        DetachedContent::Leaf(content) => {
            let len = match content {
                BlockContent::Inline(inline) => inline.len(),
                BlockContent::Plain(code) => code.len(),
                BlockContent::Atom(_) => 1,
                BlockContent::Children(_) => 0,
            };
            if len > 0 {
                out.push((block.id, 0..len));
            }
        }
    }
}

impl super::editor::BlockEditorModel {
    /// Start recording the spans that transactions tagged
    /// `EditOrigin::Agent { round: Some(round) }` touch.
    pub fn track_changes(&mut self, round: RoundId) {
        self.tracker.tracking.insert(round);
    }

    /// Stop recording `round` and forget its spans.
    pub fn untrack_changes(&mut self, round: RoundId) {
        self.tracker.tracking.remove(&round);
        self.tracker.changes.retain(|c| c.round != round);
    }

    /// Forget `round`'s spans but keep recording (a new turn on the same
    /// widget).
    pub fn clear_tracked_changes(&mut self, round: RoundId) {
        self.tracker.changes.retain(|c| c.round != round);
    }

    /// The spans `round` changed, mapped to the current document.
    pub fn tracked_changes(&self, round: RoundId) -> Vec<TrackedChange> {
        self.tracker
            .changes
            .iter()
            .filter(|c| c.round == round && self.doc.get(c.block).is_some())
            .cloned()
            .collect()
    }

    /// The top-level blocks holding `round`'s changes, in document order
    /// (one gutter bar each).
    pub fn changed_blocks(&self, round: RoundId) -> Vec<BlockId> {
        let mut tops: HashSet<BlockId> = HashSet::new();
        for change in &self.tracker.changes {
            if change.round != round {
                continue;
            }
            if let Some(top) = self.doc.path(change.block).get(1) {
                tops.insert(*top);
            }
        }
        self.doc
            .children(self.doc.root)
            .iter()
            .copied()
            .filter(|id| tops.contains(id))
            .collect()
    }

    /// One stop per changed top-level block, in document order: the first
    /// change position inside it (the change navigator's stops).
    pub fn change_stops(&self, round: RoundId) -> Vec<(BlockId, BlockPosition)> {
        let leaves = self.doc.leaves();
        let order = |id: BlockId| leaves.iter().position(|l| *l == id).unwrap_or(usize::MAX);
        self.changed_blocks(round)
            .into_iter()
            .filter_map(|top| {
                self.tracker
                    .changes
                    .iter()
                    .filter(|c| c.round == round && self.doc.path(c.block).get(1) == Some(&top))
                    .map(|c| BlockPosition::new(c.block, c.range.start))
                    .min_by_key(|p| (order(p.block), p.offset))
                    .map(|p| (top, p))
            })
            .collect()
    }

    /// Restore spans saved earlier (e.g. persisted review ranges). Spans
    /// whose block is gone or out of range are dropped.
    pub fn restore_tracked_changes(&mut self, changes: Vec<TrackedChange>) {
        self.tracker.changes.extend(changes);
        self.tracker.validate(&self.doc);
    }
}
