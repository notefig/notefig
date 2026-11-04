//! ProseMirror-compatible integer positions (spec §2.8), computed over the
//! block tree so the agent tools (`document_read_range`, the widget-context
//! resource) keep their contract.
//!
//! The mapping follows the TipTap schema:
//! - every container (blockquote, list, list item, table, row) counts 2 plus
//!   its content;
//! - a paragraph, heading or code block counts 2 plus its text;
//! - a table cell counts 4 plus its text (PM's cell holds a paragraph);
//! - a prompt widget counts 4 (`aiPrompt` holding an empty `promptDraft`;
//!   the draft is not document content here);
//! - any other atom (rule, raw HTML, definition) counts 1;
//! - text counts UTF-16 code units; an inline atom (image, mention, sub/sup)
//!   is U+FFFC, one unit, like PM's inline leaf; a hard break is `\n`, one
//!   unit, like PM's `hardBreak`;
//! - frontmatter, when present, is a 1-size leaf at position 0.
//!
//! Known differences from the TS app: images are inline atoms here (block
//! nodes in TipTap), so a paragraph holding an image is one textblock; raw
//! HTML blocks exist here (TipTap drops them).

use super::{
    document::{AtomData, BlockContent, EditorDocument},
    editor::BlockEditorModel,
    id::BlockId,
    inline::ATOM_CHAR,
    kind::BlockKindData,
    position::BlockPosition,
    selection::BlockSelection,
    transaction::EditOrigin,
    command::CommandError,
};

/// A heading in the outline, at its PM position (before the node).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocHeading {
    pub level: u8,
    pub text: String,
    pub pos: usize,
}

/// The result of [`BlockEditorModel::document_read_range`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentRange {
    pub content: String,
    pub from: usize,
    pub to: usize,
    pub doc_size: usize,
}

/// How (part of) a leaf maps to PM positions. A paragraph holding images
/// maps to several spans, because TipTap's image is a block node that splits
/// the paragraph: `p(text) image p(text)`.
#[derive(Clone, Debug)]
struct LeafSpan {
    id: BlockId,
    /// The leaf's bytes this span covers.
    bytes: std::ops::Range<usize>,
    /// An image split out of its paragraph (a block-level leaf in PM).
    image: bool,
    /// PM position of the leaf's first content position (inside it).
    content_start: usize,
    /// Content size (UTF-16 units of text, or 0 for an atom).
    content_len: usize,
    /// Whether this is a text leaf (has a caret inside) or an atom.
    text: bool,
    /// PM position before the node.
    before: usize,
    /// PM position after the node.
    after: usize,
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

impl EditorDocument {
    fn pm_leaves(&self) -> Vec<LeafSpan> {
        let mut out = Vec::new();
        let mut pos = usize::from(self.frontmatter.is_some());
        for child in self.children(self.root) {
            self.pm_walk(*child, &mut pos, &mut out);
        }
        out
    }

    fn pm_walk(&self, id: BlockId, pos: &mut usize, out: &mut Vec<LeafSpan>) {
        let Some(entry) = self.get(id) else { return };
        match &entry.content {
            BlockContent::Children(children) => {
                *pos += 1;
                for child in children {
                    self.pm_walk(*child, pos, out);
                }
                *pos += 1;
            }
            BlockContent::Inline(inline)
                if matches!(entry.kind, BlockKindData::Paragraph)
                    && inline
                        .pieces()
                        .any(|(_, _, a)| matches!(a, Some(super::inline::InlineAtom::Image(_)))) =>
            {
                let text = inline.text();
                let mut segment = 0;
                let mut flush = |from: usize, to: usize, pos: &mut usize, out: &mut Vec<LeafSpan>| {
                    // PM's DOM parser drops whitespace at block edges.
                    let raw = &text[from..to];
                    let lead = raw.len() - raw.trim_start_matches([' ', '\t', '\n']).len();
                    let trimmed = raw.trim_matches([' ', '\t', '\n']);
                    if trimmed.is_empty() {
                        return;
                    }
                    let (start, len) = (from + lead, utf16_len(trimmed));
                    out.push(LeafSpan {
                        id,
                        bytes: start..start + trimmed.len(),
                        image: false,
                        content_start: *pos + 1,
                        content_len: len,
                        text: true,
                        before: *pos,
                        after: *pos + 2 + len,
                    });
                    *pos += 2 + len;
                };
                for (range, _, atom) in inline.pieces() {
                    if matches!(atom, Some(super::inline::InlineAtom::Image(_))) {
                        flush(segment, range.start, pos, out);
                        out.push(LeafSpan {
                            id,
                            bytes: range.clone(),
                            image: true,
                            content_start: *pos,
                            content_len: 0,
                            text: false,
                            before: *pos,
                            after: *pos + 1,
                        });
                        *pos += 1;
                        segment = range.end;
                    }
                }
                flush(segment, text.len(), pos, out);
            }
            BlockContent::Inline(inline) => {
                let cell = matches!(entry.kind, BlockKindData::TableCell);
                let before = *pos;
                let open = if cell { 2 } else { 1 };
                let len = utf16_len(inline.text());
                out.push(LeafSpan {
                    id,
                    bytes: 0..inline.len(),
                    image: false,
                    content_start: before + open,
                    content_len: len,
                    text: true,
                    before,
                    after: before + 2 * open + len,
                });
                *pos = before + 2 * open + len;
            }
            BlockContent::Plain(code) => {
                let before = *pos;
                let len = utf16_len(code);
                out.push(LeafSpan {
                    id,
                    bytes: 0..code.len(),
                    image: false,
                    content_start: before + 1,
                    content_len: len,
                    text: true,
                    before,
                    after: before + 2 + len,
                });
                *pos = before + 2 + len;
            }
            BlockContent::Atom(atom) => {
                let widget = matches!(atom, AtomData::Custom(node) if super::notefig::PromptWidget::of(node).is_some());
                let size = if widget { 4 } else { 1 };
                let before = *pos;
                out.push(LeafSpan {
                    id,
                    bytes: 0..1,
                    image: false,
                    content_start: before,
                    content_len: 0,
                    text: false,
                    before,
                    after: before + size,
                });
                *pos = before + size;
            }
        }
    }

    /// PM's `doc.content.size`.
    pub(crate) fn pm_size(&self) -> usize {
        let mut out = Vec::new();
        let mut pos = usize::from(self.frontmatter.is_some());
        for child in self.children(self.root) {
            self.pm_walk(*child, &mut pos, &mut out);
        }
        pos
    }
}

fn byte_to_utf16(text: &str, byte: usize) -> usize {
    utf16_len(&text[..byte.min(text.len())])
}

fn utf16_to_byte(text: &str, units: usize) -> usize {
    let mut count = 0;
    for (ix, ch) in text.char_indices() {
        if count >= units {
            return ix;
        }
        count += ch.len_utf16();
    }
    text.len()
}

impl BlockEditorModel {
    /// The document's size in PM units (`doc.content.size`).
    pub fn pm_size(&self) -> usize {
        self.doc.pm_size()
    }

    /// The PM position of a caret position.
    pub fn pm_from_position(&self, pos: BlockPosition) -> Option<usize> {
        let spans: Vec<LeafSpan> = self
            .doc
            .pm_leaves()
            .into_iter()
            .filter(|l| l.id == pos.block)
            .collect();
        let first = spans.first()?;
        if !first.text && !first.image && spans.len() == 1 {
            return Some(if pos.offset == 0 { first.before } else { first.after });
        }
        let text = self.doc.leaf_text(pos.block)?;
        let off = pos.offset;
        for span in &spans {
            if span.image {
                if off == span.bytes.start {
                    return Some(span.before);
                }
                if off == span.bytes.end {
                    return Some(span.after);
                }
            } else if span.bytes.start <= off && off <= span.bytes.end {
                return Some(span.content_start + utf16_len(&text[span.bytes.start..off]));
            }
        }
        // In whitespace PM dropped: the next span's start, else the end.
        spans
            .iter()
            .find(|s| s.bytes.start >= off)
            .map(|s| if s.image { s.before } else { s.content_start })
            .or_else(|| spans.last().map(|s| if s.image { s.after } else { s.content_start + s.content_len }))
    }

    /// The caret position for a PM position: inside the text leaf that holds
    /// it, else the nearest leaf boundary at or after it (or the end).
    pub fn position_from_pm(&self, pm: usize) -> Option<BlockPosition> {
        let leaves = self.doc.pm_leaves();
        for leaf in &leaves {
            if leaf.text && pm >= leaf.content_start && pm <= leaf.content_start + leaf.content_len {
                let text = self.doc.leaf_text(leaf.id)?;
                let local = &text[leaf.bytes.clone()];
                let byte = leaf.bytes.start + utf16_to_byte(local, pm - leaf.content_start);
                return Some(self.doc.clamp(BlockPosition::new(leaf.id, byte)));
            }
            if leaf.image && pm >= leaf.before && pm <= leaf.after {
                let byte = if pm > leaf.before { leaf.bytes.end } else { leaf.bytes.start };
                return Some(BlockPosition::new(leaf.id, byte));
            }
            if !leaf.text && pm >= leaf.before && pm <= leaf.after {
                return Some(BlockPosition::new(leaf.id, usize::from(pm > leaf.before)));
            }
            if pm < leaf.before {
                let byte = if leaf.text || leaf.image { leaf.bytes.start } else { 0 };
                return Some(BlockPosition::new(leaf.id, byte));
            }
        }
        Some(self.doc.last_caret())
    }

    /// The selection as PM `(from, to)`, if it is a text selection.
    pub fn pm_selection(&self) -> Option<(usize, usize)> {
        let range = self.doc.resolve_selection(&self.selection).ok()?;
        let a = self.pm_from_position(range.start)?;
        let b = self.pm_from_position(range.end)?;
        Some((a.min(b), a.max(b)))
    }

    /// PM's `doc.textBetween(from, to, block_separator, leaf_text)`: the text
    /// of every text leaf overlapping the range, separated by
    /// `block_separator`; atoms (inline or block) contribute `leaf_text`.
    pub fn pm_text_between(
        &self,
        from: usize,
        to: usize,
        block_separator: &str,
        leaf_text: Option<&str>,
    ) -> String {
        let mut out = String::new();
        let mut first = true;
        for leaf in self.doc.pm_leaves() {
            if leaf.after <= from && !(leaf.before == from && leaf.after == from) {
                continue;
            }
            if leaf.before >= to {
                break;
            }
            if leaf.text {
                let Some(text) = self.doc.leaf_text(leaf.id) else { continue };
                let text = &text[leaf.bytes.clone()];
                let lo = from.saturating_sub(leaf.content_start).min(leaf.content_len);
                let hi = to.saturating_sub(leaf.content_start).min(leaf.content_len);
                if !first {
                    out.push_str(block_separator);
                }
                first = false;
                let slice = &text[utf16_to_byte(text, lo)..utf16_to_byte(text, hi)];
                for ch in slice.chars() {
                    if ch == ATOM_CHAR {
                        out.push_str(leaf_text.unwrap_or(""));
                    } else {
                        out.push(ch);
                    }
                }
            } else if let Some(leaf_text) = leaf_text {
                if !first {
                    out.push_str(block_separator);
                }
                first = false;
                out.push_str(leaf_text);
            }
        }
        out
    }

    /// Headings in document order with their PM position (`extractOutline`).
    pub fn outline(&self) -> Vec<DocHeading> {
        self.doc
            .pm_leaves()
            .into_iter()
            .filter_map(|leaf| match self.doc.kind(leaf.id) {
                Some(BlockKindData::Heading { level }) => Some(DocHeading {
                    level: *level,
                    text: self
                        .doc
                        .leaf_text(leaf.id)
                        .unwrap_or_default()
                        .replace(ATOM_CHAR, ""),
                    pos: leaf.before,
                }),
                _ => None,
            })
            .collect()
    }

    /// The nearest heading at or before PM position `pos`
    /// (`nearestPrecedingHeading`).
    pub fn nearest_preceding_heading(&self, pos: usize) -> Option<DocHeading> {
        self.outline().into_iter().take_while(|h| h.pos <= pos).last()
    }

    /// A text window of at most `max_chars` PM units centred on `pos`
    /// (`windowAroundPos`: `textBetween(from, to, "\n", "\n")`).
    pub fn window_around_pos(&self, pos: usize, max_chars: usize) -> String {
        let size = self.pm_size();
        let pos = pos.min(size);
        let half = max_chars / 2;
        let from = pos.saturating_sub(half);
        let to = (pos + half).min(size);
        self.pm_text_between(from, to, "\n", Some("\n"))
    }

    /// The `document_read_range` tool: clamps `from`/`to` to the document
    /// and returns `textBetween(from, to, "\n")` with the effective range.
    pub fn document_read_range(&self, from: usize, to: usize) -> DocumentRange {
        let doc_size = self.pm_size();
        let from = from.min(doc_size);
        let to = to.min(doc_size).max(from);
        DocumentRange {
            content: self.pm_text_between(from, to, "\n", None),
            from,
            to,
            doc_size,
        }
    }

    /// Insert `text` at PM position `pos` as one transaction tagged
    /// `origin`. Multi-line text is parsed as Markdown blocks.
    pub fn insert_at(&mut self, pos: usize, text: &str, origin: EditOrigin) -> Result<(), CommandError> {
        self.replace_range(pos, pos, text, origin)
    }

    /// Replace the PM range `from..to` with `text` (Markdown blocks when it
    /// has several lines, else plain text) as one transaction tagged
    /// `origin`. The previous selection is restored, mapped through the edit.
    pub fn replace_range(
        &mut self,
        from: usize,
        to: usize,
        text: &str,
        origin: EditOrigin,
    ) -> Result<(), CommandError> {
        let anchor = self
            .position_from_pm(from)
            .ok_or(CommandError::Unsupported("position out of range"))?;
        let head = self
            .position_from_pm(to.max(from))
            .ok_or(CommandError::Unsupported("position out of range"))?;
        let saved = self.selection.clone();
        self.set_selection(BlockSelection::Text { anchor, head })?;
        self.origin_override = Some(origin);
        self.history.break_coalescing();
        self.recent_maps.clear();
        let result = (|| {
            if text.trim_end_matches('\n').contains('\n') && self.paste_blocks(text)? {
                return Ok(());
            }
            if text.is_empty() {
                if anchor != head {
                    self.delete(false)?;
                }
                return Ok(());
            }
            self.insert_text(text, origin)
        })();
        self.origin_override = None;
        self.history.break_coalescing();
        // Put the user's selection back where it maps to, when it survived.
        let maps = std::mem::take(&mut self.recent_maps);
        let map = |mut p: BlockPosition| {
            for m in &maps {
                p = m.map(p)?;
            }
            Some(p)
        };
        if let BlockSelection::Text { anchor, head } = saved
            && let (Some(anchor), Some(head)) = (map(anchor), map(head))
        {
            let mapped = BlockSelection::Text { anchor, head };
            if self.doc.validate_selection(&mapped).is_ok() {
                self.selection = mapped;
            }
        }
        result
    }
}
