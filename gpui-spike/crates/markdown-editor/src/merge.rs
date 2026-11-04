//! External content merge (Notefig spec §2.4): diff the document against a
//! new Markdown source at the level of top-level blocks and apply the
//! difference as ONE transaction. Unchanged blocks keep their ids (so
//! carets, node views and change-tracking spans survive); a changed
//! paragraph, heading or code block is edited in place with a minimal text
//! replace; anything else is removed and re-inserted. Prompt widgets the new
//! text dropped are kept where they were. After the merge, the document
//! writes exactly the new source again (no autosave churn).

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use gpui::SharedString;

use super::{
    command::CommandError,
    document::{BlockContent, EditorDocument},
    editor::BlockEditorModel,
    id::BlockId,
    import::parse_document,
    kind::BlockKindData,
    position::BlockPosition,
    selection::BlockSelection,
    source_map::{Origin, SourceMap},
    step::{DetachedBlock, Step},
    transaction::{EditOrigin, TransactionBuilder},
};

/// What [`BlockEditorModel::apply_external_source`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MergeSummary {
    /// Whether the document changed at all.
    pub changed: bool,
    /// Top-level blocks kept as they were.
    pub kept: usize,
    /// Blocks edited in place (same block id, new text).
    pub edited: usize,
    /// Blocks removed and inserted.
    pub removed: usize,
    pub inserted: usize,
    /// Bound prompt widgets the new text dropped and the editor kept. When
    /// non-zero, the file lacks their markers: write `source()` back.
    pub reinserted_widgets: usize,
    /// Only the changed region was re-parsed (the fast path).
    pub incremental: bool,
}

#[derive(Debug)]
enum Op {
    Keep(BlockId, BlockId),
    Remove(BlockId),
    Insert(BlockId),
}

fn key_of(doc: &EditorDocument, id: BlockId) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match doc.source_map.origins.get(&id) {
        Some(origin) if doc.block_revision(id) == origin.revision => {
            0u8.hash(&mut hasher);
            origin.text().hash(&mut hasher);
        }
        _ => {
            1u8.hash(&mut hasher);
            super::serialize::block_markdown(doc, id).hash(&mut hasher);
        }
    }
    // An unbound widget writes nothing; never let two of them, or one and an
    // empty paragraph, match each other.
    if let Some(widget) = doc.prompt_widget(id) {
        widget.id.hash(&mut hasher);
    }
    hasher.finish()
}

/// Sequence diff over block keys: common prefix and suffix, then an LCS of
/// the middle (or a full replace when the middle is too large).
fn diff(old: &[u64], new: &[u64]) -> Vec<(Option<usize>, Option<usize>)> {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<(Option<usize>, Option<usize>)> = (0..prefix).map(|i| (Some(i), Some(i))).collect();
    let (o, n) = (&old[prefix..old.len() - suffix], &new[prefix..new.len() - suffix]);
    if !o.is_empty() || !n.is_empty() {
        if o.len().saturating_mul(n.len()) <= 4_000_000 {
            // LCS table, row-major (o.len()+1) x (n.len()+1).
            let w = n.len() + 1;
            let mut table = vec![0u32; (o.len() + 1) * w];
            for i in (0..o.len()).rev() {
                for j in (0..n.len()).rev() {
                    table[i * w + j] = if o[i] == n[j] {
                        table[(i + 1) * w + j + 1] + 1
                    } else {
                        table[(i + 1) * w + j].max(table[i * w + j + 1])
                    };
                }
            }
            let (mut i, mut j) = (0, 0);
            while i < o.len() || j < n.len() {
                if i < o.len() && j < n.len() && o[i] == n[j] {
                    out.push((Some(prefix + i), Some(prefix + j)));
                    i += 1;
                    j += 1;
                } else if j < n.len() && (i == o.len() || table[i * w + j + 1] >= table[(i + 1) * w + j]) {
                    out.push((None, Some(prefix + j)));
                    j += 1;
                } else {
                    out.push((Some(prefix + i), None));
                    i += 1;
                }
            }
        } else {
            out.extend((0..o.len()).map(|i| (Some(prefix + i), None)));
            out.extend((0..n.len()).map(|j| (None, Some(prefix + j))));
        }
    }
    out.extend((0..suffix).map(|k| {
        (
            Some(old.len() - suffix + k),
            Some(new.len() - suffix + k),
        )
    }));
    out
}

/// The minimal `(old range, new range)` replacement between two strings,
/// on char boundaries.
fn text_diff(old: &str, new: &str) -> (std::ops::Range<usize>, std::ops::Range<usize>) {
    let prefix: usize = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    let max = old.len().min(new.len()) - prefix;
    let suffix: usize = old[prefix..]
        .chars()
        .rev()
        .zip(new[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .scan(0usize, |acc, len| {
            *acc += len;
            (*acc <= max).then_some(len)
        })
        .sum();
    (prefix..old.len() - suffix, prefix..new.len() - suffix)
}

/// Common prefix and suffix (bytes, on char boundaries, not overlapping) of
/// two strings, compared a chunk at a time.
fn common_ends(a: &str, b: &str) -> (usize, usize) {
    const CHUNK: usize = 256;
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let max = x.len().min(y.len());
    let mut p = 0;
    while p + CHUNK <= max && x[p..p + CHUNK] == y[p..p + CHUNK] {
        p += CHUNK;
    }
    while p < max && x[p] == y[p] {
        p += 1;
    }
    while !a.is_char_boundary(p) || !b.is_char_boundary(p) {
        p -= 1;
    }
    let rest = max - p;
    let mut s = 0;
    while s + CHUNK <= rest && x[x.len() - s - CHUNK..x.len() - s] == y[y.len() - s - CHUNK..y.len() - s] {
        s += CHUNK;
    }
    while s < rest && x[x.len() - s - 1] == y[y.len() - s - 1] {
        s += 1;
    }
    while !a.is_char_boundary(a.len() - s) || !b.is_char_boundary(b.len() - s) {
        s -= 1;
    }
    (p, s)
}

/// What both merge paths hand the shared transaction.
struct Prepared {
    ops: Vec<Op>,
    detached: HashMap<BlockId, DetachedBlock>,
    new_map: SourceMap,
    new_frontmatter: Option<super::source_map::Frontmatter>,
    new_widget_ids: std::collections::HashSet<SharedString>,
    new_keys: HashMap<BlockId, u64>,
}

fn diff_ops(old: &[BlockId], old_keys: &[u64], new: &[BlockId], new_keys: &[u64]) -> Vec<Op> {
    diff(old_keys, new_keys)
        .into_iter()
        .map(|pair| match pair {
            (Some(o), Some(n)) => Op::Keep(old[o], new[n]),
            (Some(o), None) => Op::Remove(old[o]),
            (None, Some(n)) => Op::Insert(new[n]),
            (None, None) => unreachable!(),
        })
        .collect()
}

fn detach_all(doc: &mut EditorDocument) -> HashMap<BlockId, DetachedBlock> {
    let root = doc.root;
    let mut out = HashMap::new();
    while !doc.children(root).is_empty() {
        if let Some(block) = doc.detach(root, doc.children(root).len() - 1) {
            out.insert(block.id, block);
        }
    }
    out
}

/// Full path: parse the whole new text and diff every top-level block.
fn full(doc: &EditorDocument, old_top: &[BlockId], source: &str) -> Result<Prepared, SharedString> {
    let mut new_doc = parse_document(source, doc.extensions.clone())?;
    let new_top: Vec<BlockId> = new_doc.children(new_doc.root).to_vec();
    let old_keys: Vec<u64> = old_top.iter().map(|id| key_of(doc, *id)).collect();
    let new_keys: Vec<u64> = new_top.iter().map(|id| key_of(&new_doc, *id)).collect();
    let ops = diff_ops(old_top, &old_keys, &new_top, &new_keys);
    let new_widget_ids = new_doc.prompt_widgets().into_iter().map(|(_, w)| w.id).collect();
    let keys = collect_nested_keys(&new_doc);
    let detached = detach_all(&mut new_doc);
    Ok(Prepared {
        ops,
        detached,
        new_map: std::mem::take(&mut new_doc.source_map),
        new_frontmatter: new_doc.frontmatter.take(),
        new_widget_ids,
        new_keys: keys,
    })
}

fn fence_lines(text: &str) -> usize {
    text.lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("```") || t.starts_with("~~~")
        })
        .count()
}

fn has_definition(text: &str) -> bool {
    text.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with('[') && t.contains("]:")
    })
}

/// Region text can be parsed on its own and spliced back: fences and HTML
/// comments are balanced the same way, there are no link definitions, and
/// it is separated from its neighbours by blank lines.
fn independent(old_region: &str, new_region: &str) -> bool {
    fence_lines(old_region) % 2 == 0
        && fence_lines(new_region) % 2 == 0
        && old_region.matches("<!--").count() == old_region.matches("-->").count()
        && new_region.matches("<!--").count() == new_region.matches("-->").count()
        && !has_definition(old_region)
        && !has_definition(new_region)
}

/// Incremental path: compare the new text with what the document writes
/// now, re-parse only the top-level blocks around the changed bytes, and
/// keep every other block as it is (with its bytes re-anchored in the new
/// text). `None` when the change cannot be isolated safely.
fn incremental(
    doc: &EditorDocument,
    old_top: &[BlockId],
    layout: &super::source_map::Layout,
    source: &str,
) -> Option<Prepared> {
    use super::source_map::{Trailer, next_generation};
    let old = layout.text.as_str();
    let ranges = &layout.ranges;
    if ranges.len() < 3 {
        return None;
    }
    let (prefix, suffix) = common_ends(old, source);
    if prefix < layout.frontmatter_len {
        return None;
    }
    let change_end = old.len() - suffix;
    let is_list = |ix: usize| matches!(doc.kind(ranges[ix].0), Some(BlockKindData::List { .. }));
    let mut i = ranges
        .iter()
        .position(|(_, r)| r.end >= prefix)
        .unwrap_or(ranges.len() - 1);
    let mut j = ranges.iter().rposition(|(_, r)| r.start <= change_end)?.max(i);
    // One block of context each way, and never split next to a list.
    i = i.saturating_sub(1);
    j = (j + 1).min(ranges.len() - 1);
    while i > 0 && (is_list(i - 1) || is_list(i)) {
        i -= 1;
    }
    while j + 1 < ranges.len() && (is_list(j + 1) || is_list(j)) {
        j += 1;
    }
    let (start, mut old_end) = (ranges[i].1.start, ranges[j].1.end);
    // A change running into the trailing bytes (an append) takes the rest.
    let to_end = j + 1 == ranges.len() && old_end < change_end;
    if to_end {
        old_end = old.len();
    }
    if start > prefix || old_end < change_end {
        return None;
    }
    let new_end = (old_end + source.len()).checked_sub(old.len())?;
    if new_end < start || !source.is_char_boundary(new_end) {
        return None;
    }
    // Blank-line separation from the outside, on both sides.
    let before_ok = i == 0 || source[..start].ends_with("\n\n");
    let after = &source[new_end..];
    let after_ok = j + 1 == ranges.len() || (after.starts_with("\n\n") && !after[2..].starts_with([' ', '\t']));
    if !before_ok || !after_ok || !independent(&old[start..old_end], &source[start..new_end]) {
        return None;
    }
    let mut fragment = super::import::parse_body(&source[start..new_end], doc.extensions.clone()).ok()?;
    // The fragment must not have invented landing paragraphs.
    let frag_top: Vec<BlockId> = fragment
        .children(fragment.root)
        .iter()
        .copied()
        .filter(|id| to_end || !fragment.source_map.synthetic.contains(id))
        .collect();
    // Old blocks of the region (by position in old_top, unbound widgets
    // included).
    let first = old_top.iter().position(|id| *id == ranges[i].0)?;
    let last = if to_end {
        // Trailing empty paragraphs belong to the end region too.
        old_top.len() - 1
    } else {
        old_top.iter().position(|id| *id == ranges[j].0)?
    };
    let region = &old_top[first..=last];
    let old_keys: Vec<u64> = region.iter().map(|id| key_of(doc, *id)).collect();
    let new_keys: Vec<u64> = frag_top.iter().map(|id| key_of(&fragment, *id)).collect();
    let mut ops: Vec<Op> = old_top[..first].iter().map(|id| Op::Keep(*id, *id)).collect();
    ops.extend(diff_ops(region, &old_keys, &frag_top, &new_keys));
    ops.extend(old_top[last + 1..].iter().map(|id| Op::Keep(*id, *id)));

    // The new recorded sources: one generation over the whole new text.
    let shared: std::sync::Arc<str> = std::sync::Arc::from(source);
    let generation = next_generation();
    let delta = source.len() as isize - old.len() as isize;
    let mut spans: Vec<(BlockId, std::ops::Range<usize>)> = Vec::new();
    for (id, r) in &ranges[..i] {
        spans.push((*id, r.clone()));
    }
    for id in &frag_top {
        if let Some(o) = fragment.source_map.origins.get(id) {
            spans.push((*id, start + o.span.start..start + o.span.end));
        }
    }
    for (id, r) in &ranges[j + 1..] {
        let shift = |x: usize| (x as isize + delta) as usize;
        spans.push((*id, shift(r.start)..shift(r.end)));
    }
    let mut map = SourceMap {
        origins: HashMap::new(),
        synthetic: fragment.source_map.synthetic.clone(),
        trailer: None,
        final_newline: source.ends_with('\n') && !source.ends_with("\n\n"),
    };
    let mut prev_end = layout.frontmatter_len;
    for (index, (id, span)) in spans.iter().enumerate() {
        if span.start < prev_end || span.end > source.len() {
            return None;
        }
        map.origins.insert(
            *id,
            Origin {
                generation,
                index,
                last_index: index,
                source: shared.clone(),
                span: span.clone(),
                gap_before: prev_end..span.start,
                revision: 0,
                canonical: None,
            },
        );
        prev_end = span.end;
    }
    map.trailer = Some(Trailer {
        generation,
        last_index: spans.len().saturating_sub(1),
        text: source[prev_end..].to_string(),
    });
    let mut new_widget_ids: std::collections::HashSet<SharedString> = fragment
        .prompt_widgets()
        .into_iter()
        .map(|(_, w)| w.id)
        .collect();
    for id in old_top[..first].iter().chain(&old_top[last + 1..]) {
        let mut stack = vec![*id];
        while let Some(b) = stack.pop() {
            if let Some(w) = doc.prompt_widget(b) {
                new_widget_ids.insert(w.id.clone());
            }
            stack.extend(doc.children(b).iter().copied());
        }
    }
    let keys = collect_nested_keys(&fragment);
    let detached = detach_all(&mut fragment);
    Some(Prepared {
        ops,
        detached,
        new_map: map,
        new_frontmatter: doc.frontmatter.clone(),
        new_widget_ids,
        new_keys: keys,
    })
}

impl BlockEditorModel {
    /// Merge a new Markdown source (a disk change or an agent write) into
    /// the open document as one undoable transaction tagged `origin`
    /// (`EditOrigin::External`, or `EditOrigin::Agent { round }` to feed
    /// change tracking). The caret and selection map through the edit.
    pub fn apply_external_source(
        &mut self,
        source: &str,
        origin: EditOrigin,
    ) -> Result<MergeSummary, SharedString> {
        let mut old_top: Vec<BlockId> = self.doc.children(self.doc.root).to_vec();
        // Trailing UI-only landing paragraphs are not part of the text.
        let mut landing = Vec::new();
        if self.trailing_paragraph {
            while let Some(id) = old_top
                .last()
                .copied()
                .filter(|id| self.doc.source_map.is_synthetic_untouched(&self.doc, *id))
            {
                landing.push(id);
                old_top.pop();
            }
        }
        let layout = super::source_map::serialize_layout(&self.doc);
        let mut fast = false;
        if layout.text == source {
            return Ok(MergeSummary::default());
        }
        let Prepared {
            ops,
            mut detached,
            new_map,
            new_frontmatter,
            new_widget_ids,
            new_keys: new_doc_keys_source,
        } = match incremental(&self.doc, &old_top, &layout, source) {
            Some(prepared) => {
                fast = true;
                prepared
            }
            None => full(&self.doc, &old_top, source)?,
        };
        let mut summary = MergeSummary::default();
        let caret_before = self.caret();
        let caret_top_index = caret_before.and_then(|caret| {
            let path = self.doc.path(caret.block);
            let top = *path.get(1)?;
            old_top.iter().position(|id| *id == top)
        });

        // Keys of every nested new block (canonical Markdown), for the
        // recursive diff inside containers.
        let new_keys = new_doc_keys_source;
        let summary_ref = &mut summary;
        let result = self.transact(origin, move |tx| {
            let root = tx.doc.root;
            let mut ctx = MergeCtx {
                widget_ids: new_widget_ids,
                summary: summary_ref,
                adopted: Vec::new(),
                inserted: Vec::new(),
                new_keys,
            };
            merge_level(tx, root, &ops, &mut detached, &mut ctx, true)?;
            let MergeCtx { adopted, inserted, .. } = ctx;
            if tx.doc.frontmatter.as_ref().map(|f| (&f.yaml, &f.raw))
                != new_frontmatter.as_ref().map(|f| (&f.yaml, &f.raw))
            {
                tx.step(Step::SetFrontmatter {
                    value: new_frontmatter.clone(),
                })?;
            }
            // The recorded sources now describe the new text.
            let mut map = SourceMap {
                origins: HashMap::new(),
                synthetic: landing.iter().copied().collect(),
                trailer: new_map.trailer.clone(),
                final_newline: new_map.final_newline,
            };
            for (old, new) in &adopted {
                if let Some(origin) = new_map.origins.get(new) {
                    map.origins.insert(
                        *old,
                        Origin {
                            revision: tx.doc.block_revision(*old),
                            ..origin.clone()
                        },
                    );
                }
                if new_map.synthetic.contains(new) {
                    map.synthetic.insert(*old);
                }
            }
            for new in &inserted {
                if let Some(origin) = new_map.origins.get(new) {
                    map.origins.insert(
                        *new,
                        Origin {
                            revision: tx.doc.block_revision(*new),
                            ..origin.clone()
                        },
                    );
                }
                if new_map.synthetic.contains(new) {
                    map.synthetic.insert(*new);
                }
            }
            if tx.is_empty() {
                // Same content: adopt the new bytes without an undo step.
                tx.doc.source_map = map;
            } else {
                tx.step(Step::SetSourceMap { map: Box::new(map) })?;
            }
            // A caret whose block was replaced goes to the block now at the
            // same top-level index.
            let selection = match caret_before {
                Some(caret) if tx.doc.get(caret.block).is_none() => {
                    let top = tx.doc.children(root);
                    caret_top_index
                        .and_then(|i| top.get(i.min(top.len().saturating_sub(1))).copied())
                        .map(|b| BlockSelection::caret(tx.doc.first_leaf_in(b)))
                }
                _ => None,
            };
            Ok(selection)
        });
        // The recorded bytes changed even when the content did not.
        *self.source_cache.borrow_mut() = None;
        match result {
            Ok(changed) => {
                summary.changed = changed;
                summary.incremental = fast;
                Ok(summary)
            }
            Err(err) => Err(format!("{err:?}").into()),
        }
    }
}

struct MergeCtx<'s> {
    widget_ids: std::collections::HashSet<SharedString>,
    summary: &'s mut MergeSummary,
    /// (old id, new id): top-level blocks whose recorded source the old one
    /// takes over.
    adopted: Vec<(BlockId, BlockId)>,
    inserted: Vec<BlockId>,
    new_keys: HashMap<BlockId, u64>,
}

fn hash_markdown(doc: &EditorDocument, id: BlockId) -> u64 {
    super::source_map::with_neutral_style(|| hash_markdown_inner(doc, id))
}

fn hash_markdown_inner(doc: &EditorDocument, id: BlockId) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match doc.kind(id) {
        // The serializer writes rows and cells only through their table.
        Some(BlockKindData::TableRow) => {
            for cell in doc.children(id) {
                doc.inline(*cell)
                    .map(super::serialize::inline_markdown)
                    .hash(&mut hasher);
            }
        }
        Some(BlockKindData::TableCell) => {
            doc.inline(id).map(super::serialize::inline_markdown).hash(&mut hasher)
        }
        _ => super::serialize::block_markdown(doc, id).hash(&mut hasher),
    }
    doc.kind(id).map(|k| format!("{:?}", k.public())).hash(&mut hasher);
    if let Some(widget) = doc.prompt_widget(id) {
        widget.id.hash(&mut hasher);
    }
    hasher.finish()
}

/// Canonical keys of every block below the top level of `doc`.
fn collect_nested_keys(doc: &EditorDocument) -> HashMap<BlockId, u64> {
    let mut out = HashMap::new();
    let mut stack: Vec<BlockId> = doc.children(doc.root).to_vec();
    for id in &stack {
        out.insert(*id, hash_markdown(doc, *id));
    }
    while let Some(id) = stack.pop() {
        for child in doc.children(id) {
            out.insert(*child, hash_markdown(doc, *child));
            stack.push(*child);
        }
    }
    out
}

/// Apply diff `ops` to the children of `parent`. Runs of removes and inserts
/// are paired 1:1: same-kind text leaves are edited in place, same-kind
/// containers are merged recursively; widgets the new text dropped stay.
fn merge_level(
    tx: &mut TransactionBuilder<'_>,
    parent: BlockId,
    ops: &[Op],
    detached: &mut HashMap<BlockId, DetachedBlock>,
    ctx: &mut MergeCtx<'_>,
    top: bool,
) -> Result<(), CommandError> {
    let mut idx = 0;
    let mut ix = 0;
    while ix < ops.len() {
        match &ops[ix] {
            Op::Keep(old, new) => {
                if top {
                    ctx.adopted.push((*old, *new));
                    ctx.summary.kept += 1;
                }
                idx += 1;
                ix += 1;
            }
            Op::Remove(_) | Op::Insert(_) => {
                let end = (ix..ops.len())
                    .find(|k| matches!(ops[*k], Op::Keep(..)))
                    .unwrap_or(ops.len());
                let removes: Vec<BlockId> = ops[ix..end]
                    .iter()
                    .filter_map(|op| match op {
                        Op::Remove(id) => Some(*id),
                        _ => None,
                    })
                    .collect();
                let inserts: Vec<BlockId> = ops[ix..end]
                    .iter()
                    .filter_map(|op| match op {
                        Op::Insert(id) => Some(*id),
                        _ => None,
                    })
                    .collect();
                let (mut r, mut n) = (0, 0);
                while r < removes.len() || n < inserts.len() {
                    let old = removes.get(r).copied();
                    let new = inserts.get(n).copied();
                    // Keep a widget the new text dropped.
                    if let Some(old) = old
                        && let Some(widget) = tx.doc.prompt_widget(old).cloned()
                        && !ctx.widget_ids.contains(&widget.id)
                    {
                        if widget.task.is_some() {
                            ctx.summary.reinserted_widgets += 1;
                        }
                        idx += 1;
                        r += 1;
                        continue;
                    }
                    if let (Some(old), Some(new)) = (old, new)
                        && detached.contains_key(&new)
                    {
                        let applied = {
                            let block = detached.get(&new).cloned().unwrap_or_else(|| unreachable!());
                            edit_in_place(tx, old, &block)? || merge_container(tx, old, block, ctx)?
                        };
                        if applied {
                            detached.remove(&new);
                            // Adopt the new bytes only when the edit really
                            // produced the new content.
                            if top && ctx.new_keys.get(&new) == Some(&hash_markdown(tx.doc, old)) {
                                ctx.adopted.push((old, new));
                            }
                            ctx.summary.edited += 1;
                            idx += 1;
                            r += 1;
                            n += 1;
                            continue;
                        }
                    }
                    if old.is_some() {
                        // A container being removed may hold a widget the
                        // new text dropped: keep that widget in its place.
                        let kept = dropped_widgets(tx.doc, old.unwrap_or_else(|| unreachable!()), &ctx.widget_ids);
                        tx.remove(parent, idx..idx + 1)?;
                        ctx.summary.removed += 1;
                        for widget in kept {
                            let bound = matches!(
                                &widget.content,
                                super::step::DetachedContent::Leaf(BlockContent::Atom(super::document::AtomData::Custom(node)))
                                    if super::notefig::PromptWidget::of(node).is_some_and(|w| w.task.is_some())
                            );
                            tx.insert(parent, idx, vec![widget])?;
                            if bound {
                                ctx.summary.reinserted_widgets += 1;
                            }
                            idx += 1;
                        }
                        r += 1;
                        continue;
                    }
                    if let Some(new) = new {
                        if let Some(block) = detached.remove(&new) {
                            tx.insert(parent, idx, vec![block])?;
                            if top {
                                ctx.inserted.push(new);
                            }
                            ctx.summary.inserted += 1;
                            idx += 1;
                        }
                        n += 1;
                    }
                }
                ix = end;
            }
        }
    }
    Ok(())
}

/// Bound or unbound prompt widgets inside `id` (not `id` itself) that the
/// new text does not contain, as fresh detached copies keeping their ids
/// (the originals are removed with their container).
fn dropped_widgets(
    doc: &EditorDocument,
    id: BlockId,
    keep: &std::collections::HashSet<SharedString>,
) -> Vec<DetachedBlock> {
    let mut out = Vec::new();
    let mut stack = doc.children(id).to_vec();
    stack.reverse();
    while let Some(child) = stack.pop() {
        if let Some(widget) = doc.prompt_widget(child)
            && !keep.contains(&widget.id)
            && let Some(entry) = doc.get(child)
        {
            out.push(DetachedBlock {
                id: child,
                kind: entry.kind.clone(),
                content: super::step::DetachedContent::Leaf(entry.content.clone()),
            });
        }
        let mut kids = doc.children(child).to_vec();
        kids.reverse();
        stack.extend(kids);
    }
    out
}

/// Merge a same-kind container in place: diff its children recursively and
/// update its kind payload (list start, task state, alignments).
fn merge_container(
    tx: &mut TransactionBuilder<'_>,
    old: BlockId,
    new: DetachedBlock,
    ctx: &mut MergeCtx<'_>,
) -> Result<bool, CommandError> {
    let Some(old_kind) = tx.doc.kind(old).cloned() else {
        return Ok(false);
    };
    let compatible = match (&old_kind, &new.kind) {
        (BlockKindData::List { ordered: a, .. }, BlockKindData::List { ordered: b, .. }) => a == b,
        (BlockKindData::ListItem { .. }, BlockKindData::ListItem { .. })
        | (BlockKindData::Blockquote, BlockKindData::Blockquote)
        | (BlockKindData::Table { .. }, BlockKindData::Table { .. })
        | (BlockKindData::TableRow, BlockKindData::TableRow) => true,
        _ => false,
    };
    let super::step::DetachedContent::Children(children) = new.content else {
        return Ok(false);
    };
    if !compatible || !old_kind.is_container() {
        return Ok(false);
    }
    let old_children = tx.doc.children(old).to_vec();
    let old_keys: Vec<u64> = old_children.iter().map(|id| hash_markdown(tx.doc, *id)).collect();
    let new_keys: Vec<u64> = children
        .iter()
        .map(|c| ctx.new_keys.get(&c.id).copied().unwrap_or(0))
        .collect();
    let ops: Vec<Op> = diff(&old_keys, &new_keys)
        .into_iter()
        .map(|pair| match pair {
            (Some(o), Some(n)) => Op::Keep(old_children[o], children[n].id),
            (Some(o), None) => Op::Remove(old_children[o]),
            (None, Some(n)) => Op::Insert(children[n].id),
            (None, None) => unreachable!(),
        })
        .collect();
    let mut detached: HashMap<BlockId, DetachedBlock> =
        children.into_iter().map(|c| (c.id, c)).collect();
    merge_level(tx, old, &ops, &mut detached, ctx, false)?;
    if old_kind != new.kind {
        tx.set_kind(old, new.kind.clone())?;
    }
    Ok(true)
}

/// Edit `old` in place to hold `new`'s content when both are the same kind
/// of text leaf. Returns whether it applied.
fn edit_in_place(
    tx: &mut TransactionBuilder<'_>,
    old: BlockId,
    new: &DetachedBlock,
) -> Result<bool, CommandError> {
    let super::step::DetachedContent::Leaf(new_content) = &new.content else {
        return Ok(false);
    };
    let Some(old_kind) = tx.doc.kind(old).cloned() else {
        return Ok(false);
    };
    let compatible = matches!(
        (&old_kind, &new.kind),
        (BlockKindData::Paragraph | BlockKindData::Heading { .. }, BlockKindData::Paragraph | BlockKindData::Heading { .. })
            | (BlockKindData::CodeBlock { .. }, BlockKindData::CodeBlock { .. })
            | (BlockKindData::TableCell, BlockKindData::TableCell)
    );
    if !compatible {
        return Ok(false);
    }
    match (tx.doc.get(old).map(|e| e.content.clone()), new_content) {
        (Some(BlockContent::Inline(old_inline)), BlockContent::Inline(new_inline)) => {
            let (o, n) = text_diff(old_inline.text(), new_inline.text());
            // Marks must match outside the replaced range too.
            let o = if old_inline.slice(0..o.start) == new_inline.slice(0..n.start)
                && old_inline.slice(o.end..old_inline.len())
                    == new_inline.slice(n.end..new_inline.len())
            {
                (o, n)
            } else {
                (0..old_inline.len(), 0..new_inline.len())
            };
            let (o, n) = o;
            if !o.is_empty() || !n.is_empty() {
                tx.replace_text(old, o, new_inline.slice(n))?;
            }
        }
        (Some(BlockContent::Plain(old_code)), BlockContent::Plain(new_code)) => {
            let (o, n) = text_diff(&old_code, new_code);
            if !o.is_empty() || !n.is_empty() {
                tx.replace_plain(old, o, &new_code[n])?;
            }
        }
        _ => return Ok(false),
    }
    if old_kind != new.kind {
        tx.set_kind(old, new.kind.clone())?;
    }
    let _ = BlockPosition::new(old, 0);
    Ok(true)
}
