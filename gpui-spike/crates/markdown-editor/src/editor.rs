use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

static NEXT_EDITOR_OWNER: AtomicU64 = AtomicU64::new(1);

use gpui::SharedString;

use super::{
    command::CommandError,
    document::{DocumentRef, EditorDocument},
    import::parse_document,
    kind::BlockKind,
    marks::{MarkKind, MarkSet, MarkState},
    position::BlockPosition,
    selection::{BlockSelection, SelectionError},
    transaction::{EditOrigin, Transaction, TransactionBuilder},
    undo::BlockUndoManager,
};
use gpui_kit::base::text::{MarkdownExtensions, editor_host::TextMark};

/// A guarded widget and where it sat (see `guarded_widgets`).
struct GuardedWidget {
    block: super::id::BlockId,
    widget: super::notefig::PromptWidget,
    parent: super::id::BlockId,
    index: usize,
    prev: Option<super::id::BlockId>,
    top_index: usize,
}

/// Headless editor facade (spike name). Phase 3 wraps this in the
/// `BlockEditorState` entity.
pub struct BlockEditorModel {
    pub(crate) doc: EditorDocument,
    pub(super) owner: u64,
    pub(super) selection_epoch: u64,
    pub(super) source_cache: RefCell<Option<super::SourceSnapshot>>,
    pub(super) prefix_cache: RefCell<Option<super::host::PrefixSnapshot>>,
    pub(crate) selection: BlockSelection,
    /// Toolbar marks at a collapsed caret; cleared when the caret moves.
    pub(crate) stored_marks: Option<TextMark>,
    pub(crate) history: BlockUndoManager,
    /// Every transaction committed while set takes this origin (agent
    /// writes run ordinary commands under an `Agent` origin).
    pub(crate) origin_override: Option<EditOrigin>,
    /// Spans touched by tracked agent rounds (Notefig change tracking).
    pub(crate) tracker: super::tracking::ChangeTracker,
    /// Step maps of the transactions committed since the last `take`
    /// (used to map a saved selection through an API edit).
    pub(crate) recent_maps: Vec<super::step::StepMap>,
    /// Keep an empty paragraph after a final code block, table, rule or
    /// atom (TipTap's TrailingNode). UI-only: it writes nothing while empty.
    pub(crate) trailing_paragraph: bool,
    /// Widgets that must stay (a running agent's): an edit that removes one
    /// puts it back. See `set_widget_removal_guard`.
    pub(crate) widget_guard: Option<super::notefig::WidgetRemovalGuard>,
    /// Widgets an edit tried to remove and the guard put back, since the
    /// last `take_refused_removals`.
    pub(crate) refused_removals: Vec<(super::id::BlockId, super::notefig::PromptWidget)>,
    /// What selection-summoned widgets refer to, by widget block.
    pub(crate) widget_references:
        std::collections::HashMap<super::id::BlockId, super::notefig::PromptReference>,
}

impl BlockEditorModel {
    /// Parse Markdown into a model.
    pub fn from_markdown(
        source: &str,
        extensions: MarkdownExtensions,
    ) -> Result<Self, SharedString> {
        let extensions = super::import::preserve_source_extensions(extensions);
        let doc = parse_document(source, Arc::new(extensions))?;
        let selection = BlockSelection::caret(doc.first_caret());
        Ok(Self {
            doc,
            owner: NEXT_EDITOR_OWNER.fetch_add(1, Ordering::Relaxed),
            selection_epoch: 0,
            source_cache: RefCell::default(),
            prefix_cache: RefCell::default(),
            selection,
            stored_marks: None,
            history: BlockUndoManager::default(),
            origin_override: None,
            tracker: Default::default(),
            recent_maps: Vec::new(),
            trailing_paragraph: false,
            widget_guard: None,
            refused_removals: Vec::new(),
            widget_references: Default::default(),
        })
    }

    /// Replace the content. Fresh ids (old positions fail with
    /// `UnknownBlock`), history cleared.
    pub fn set_source(&mut self, source: &str) -> Result<(), SharedString> {
        let doc = parse_document(source, self.doc.extensions.clone())?;
        self.replace_document(doc);
        Ok(())
    }

    /// Swap in a document parsed elsewhere (a background load).
    pub(crate) fn replace_document(&mut self, doc: EditorDocument) {
        let revision = self.doc.revision;
        self.doc = doc;
        self.doc.revision = revision + 1;
        self.selection = BlockSelection::caret(self.doc.first_caret());
        self.stored_marks = None;
        self.history.clear();
        self.tracker.changes.clear();
        self.widget_references.clear();
        *self.source_cache.borrow_mut() = None;
        self.ensure_trailing_paragraph();
    }

    /// The document as canonical Markdown.
    pub fn source(&self) -> String {
        self.source_snapshot().text().to_string()
    }

    /// Document revision; bumped by every committed transaction.
    pub fn revision(&self) -> u64 {
        self.doc.revision
    }

    /// Read-only view of the block tree.
    pub fn document(&self) -> DocumentRef<'_> {
        DocumentRef { doc: &self.doc }
    }

    /// The current selection.
    pub fn selection(&self) -> &BlockSelection {
        &self.selection
    }

    /// Set the selection after validating it against the document.
    pub fn set_selection(&mut self, selection: BlockSelection) -> Result<(), SelectionError> {
        self.doc.validate_selection(&selection)?;
        if selection != self.selection {
            self.selection_epoch += 1;
            self.stored_marks = None;
            self.history.break_coalescing();
        }
        self.selection = selection;
        Ok(())
    }

    /// Delete `anchor..head` in one leaf (D21 word / line deletes) without
    /// an undo boundary, so a run of word deletes coalesces like Backspace.
    pub(crate) fn delete_span(
        &mut self,
        anchor: BlockPosition,
        head: BlockPosition,
        forward: bool,
    ) -> Result<(), super::command::CommandError> {
        let selection = BlockSelection::Text { anchor, head };
        self.doc
            .validate_selection(&selection)
            .map_err(super::command::CommandError::Selection)?;
        self.selection_epoch += 1;
        self.stored_marks = None;
        self.selection = selection;
        self.delete_as(forward, true)
    }

    /// The caret (head of a text selection); `None` for a block selection.
    pub fn caret(&self) -> Option<BlockPosition> {
        match &self.selection {
            BlockSelection::Text { head, .. } => Some(*head),
            BlockSelection::Blocks { .. } | BlockSelection::Cells { .. } => None,
        }
    }

    /// Marks the next typed text gets (stored marks, else inherited at the caret).
    pub fn active_marks(&self) -> MarkSet {
        if let Some(stored) = &self.stored_marks {
            return MarkSet(stored.clone());
        }
        let Some(caret) = self.caret() else {
            return MarkSet::default();
        };
        MarkSet(self.inherited_marks(caret))
    }

    /// Whether `kind` is on, off or mixed over the selection.
    pub fn mark_state(&self, kind: MarkKind) -> MarkState {
        let Ok(range) = self.doc.resolve_selection(&self.selection) else {
            return MarkState::Off;
        };
        if range.is_collapsed() {
            return if self.active_marks().has(kind) {
                MarkState::On
            } else {
                MarkState::Off
            };
        }
        let (mut on, mut off) = (false, false);
        for (block, lo, hi) in self.text_ranges(range) {
            if let Some(inline) = self.doc.inline(block) {
                for (piece, marks, _) in inline.pieces() {
                    if piece.start < hi && piece.end > lo {
                        if kind.is_set(marks) {
                            on = true
                        } else {
                            off = true
                        }
                    }
                }
            }
        }
        match (on, off) {
            (true, false) => MarkState::On,
            (true, true) => MarkState::Mixed,
            _ => MarkState::Off,
        }
    }

    /// Kind of the text block holding the caret, if any.
    pub fn block_kind_at_caret(&self) -> Option<BlockKind> {
        let caret = self.caret()?;
        self.doc.kind(caret.block).map(|kind| kind.public())
    }

    /// The kinds of the blocks containing the caret, innermost first.
    pub fn caret_ancestor_kinds(&self) -> Vec<BlockKind> {
        let mut out = Vec::new();
        let Some(caret) = self.caret() else { return out };
        let mut at = caret.block;
        while let Some((parent, _)) = self.doc.index_in_parent(at) {
            if let Some(kind) = self.doc.kind(parent) {
                out.push(kind.public());
            }
            at = parent;
        }
        out
    }

    /// End the current typing group, so the next edit is its own undo step.
    pub fn break_coalescing(&mut self) {
        self.history.break_coalescing();
    }

    /// Whether there is something to undo.
    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    /// Whether there is something to redo.
    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Undo one group; returns whether anything changed.
    pub fn undo(&mut self) -> bool {
        let Some(entry) = self.history.pop_undo() else {
            return false;
        };
        let guarded = self.guarded_widgets();
        let Ok(maps) = Transaction::replay(&entry.inverse, &mut self.doc) else {
            return false;
        };
        self.tracker
            .apply(EditOrigin::Undo, &entry.inverse, &maps, &entry.steps, &self.doc);
        self.ensure_trailing_paragraph();
        self.selection = self.valid_or_start(entry.selection_before.clone());
        self.stored_marks = None;
        self.history.push_redo(entry);
        self.restore_missing_widgets(guarded);
        true
    }

    /// Redo one group; returns whether anything changed.
    pub fn redo(&mut self) -> bool {
        let Some(entry) = self.history.pop_redo() else {
            return false;
        };
        let guarded = self.guarded_widgets();
        let Ok(maps) = Transaction::replay(&entry.steps, &mut self.doc) else {
            return false;
        };
        self.tracker
            .apply(EditOrigin::Redo, &entry.steps, &maps, &entry.inverse, &self.doc);
        self.ensure_trailing_paragraph();
        self.selection = self.valid_or_start(entry.selection_after.clone());
        self.stored_marks = None;
        self.history.push_undo(entry);
        self.restore_missing_widgets(guarded);
        true
    }

    /// Set (or clear) the widget removal guard: `keep(widget)` true means
    /// the widget can't be removed now (TS: not `removable`, e.g. its agent
    /// is working). Any edit that removes such a widget (a range delete,
    /// select-all and type, cut, undo, an external rewrite) still applies,
    /// and the widget is put back where it was; `remove_prompt_widget` is
    /// never vetoed. Put-back widgets are reported by
    /// `take_refused_removals`.
    pub fn set_widget_removal_guard(&mut self, guard: Option<super::notefig::WidgetRemovalGuard>) {
        self.widget_guard = guard;
    }

    /// The widgets put back since the last call (block, widget).
    pub fn take_refused_removals(&mut self) -> Vec<(super::id::BlockId, super::notefig::PromptWidget)> {
        std::mem::take(&mut self.refused_removals)
    }

    /// Guarded widgets with where they sit, for an undo or redo to check.
    /// Empty without a guard (and then costs nothing).
    fn guarded_widgets(&self) -> Vec<GuardedWidget> {
        let Some(keep) = self.widget_guard.as_ref() else {
            return Vec::new();
        };
        self.doc
            .prompt_widgets()
            .into_iter()
            .filter(|(_, w)| keep(w))
            .filter_map(|(block, widget)| {
                let (parent, index) = self.doc.index_in_parent(block)?;
                let prev = index.checked_sub(1).map(|i| self.doc.children(parent)[i]);
                let top = self.doc.path(block).get(1).copied().unwrap_or(block);
                let top_index = self.doc.index_in_parent(top).map_or(0, |(_, i)| i);
                Some(GuardedWidget { block, widget, parent, index, prev, top_index })
            })
            .collect()
    }

    /// Put back guarded widgets an undo or redo removed, as their own step
    /// (after the previous sibling they had, else where their parent was).
    fn restore_missing_widgets(&mut self, before: Vec<GuardedWidget>) {
        let missing: Vec<_> = before
            .into_iter()
            .filter(|g| self.doc.index_in_parent(g.block).is_none())
            .collect();
        if missing.is_empty() {
            return;
        }
        let kept: Vec<_> = missing.iter().map(|g| (g.block, g.widget.clone())).collect();
        let restored = self.transact(EditOrigin::Command("keep-widget"), |tx| {
            for g in missing {
                let attached = |doc: &EditorDocument, id| id == doc.root || doc.index_in_parent(id).is_some();
                let (parent, index) = match g.prev.and_then(|prev| tx.doc.index_in_parent(prev)) {
                    Some((p, i)) => (p, i + 1),
                    None if attached(tx.doc, g.parent)
                        && !matches!(tx.doc.kind(g.parent), Some(super::kind::BlockKindData::List { .. })) =>
                    {
                        (g.parent, g.index)
                    }
                    None => (tx.doc.root, g.top_index),
                };
                let index = index.min(tx.doc.children(parent).len());
                tx.insert(parent, index, vec![super::notefig::widget_block_with_id(&g.widget, g.block)])?;
            }
            Ok(None)
        });
        if restored.is_ok() {
            self.refused_removals.extend(kept);
        }
    }

    fn valid_or_start(&self, selection: BlockSelection) -> BlockSelection {
        match self.doc.validate_selection(&selection) {
            Ok(()) => selection,
            Err(_) => match selection {
                BlockSelection::Text { head, .. } => BlockSelection::caret(self.doc.clamp(head)),
                BlockSelection::Cells { head, .. } if self.doc.get(head).is_some() => {
                    BlockSelection::caret(BlockPosition::new(head, 0))
                }
                BlockSelection::Blocks { .. } | BlockSelection::Cells { .. } => {
                    BlockSelection::caret(self.doc.first_caret())
                }
            },
        }
    }

    /// Run `build` as one transaction: normalize, commit, record history.
    /// `build` returns the caret to leave behind. On error nothing changes.
    pub(crate) fn transact(
        &mut self,
        origin: EditOrigin,
        build: impl FnOnce(&mut TransactionBuilder<'_>) -> Result<Option<BlockSelection>, CommandError>,
    ) -> Result<bool, CommandError> {
        let origin = self.origin_override.unwrap_or(origin);
        let before = self.selection.clone();
        let mut tx = TransactionBuilder::new(&mut self.doc);
        let after = match build(&mut tx) {
            Ok(after) => after,
            Err(err) => {
                tx.rollback();
                return Err(err);
            }
        };
        // The host's own removal of a widget is never vetoed.
        if let Some(keep) = self.widget_guard.clone()
            && !matches!(origin, EditOrigin::Command("remove-prompt"))
        {
            match super::notefig::restore_guarded_widgets(&mut tx, &*keep) {
                Ok(kept) => self.refused_removals.extend(kept),
                Err(err) => {
                    tx.rollback();
                    return Err(err.into());
                }
            }
        }
        let tx = tx
            .finish(origin, before.clone(), before.clone())
            .map_err(CommandError::from)?;
        let changed = !tx.is_empty();
        self.tracker
            .apply(origin, &tx.steps, &tx.maps, &tx.inverse, &self.doc);
        if self.recent_maps.len() < 4096 {
            self.recent_maps.extend(tx.maps.iter().cloned());
        }
        self.ensure_trailing_paragraph();
        // Without an explicit caret, map the old selection through the steps.
        let after = after
            .or_else(|| tx.map_selection(&before))
            .unwrap_or(before);
        let after = self.valid_or_start(after);
        let mut tx = tx;
        tx.selection_after = after.clone();
        self.selection = after;
        self.history.record(tx);
        Ok(changed)
    }

    /// Turn the trailing landing paragraph on or off.
    pub fn set_trailing_paragraph(&mut self, on: bool) {
        self.trailing_paragraph = on;
        self.ensure_trailing_paragraph();
    }

    /// Append the landing paragraph when the document ends in a block the
    /// caret cannot type after. Outside history (like PM's
    /// `addToHistory: false`); it only ever goes at the very end, so recorded
    /// steps stay valid.
    pub(crate) fn ensure_trailing_paragraph(&mut self) {
        use super::kind::BlockKindData;
        if !self.trailing_paragraph {
            return;
        }
        let root = self.doc.root;
        let needs = self.doc.children(root).last().is_some_and(|last| {
            !matches!(
                self.doc.kind(*last),
                Some(
                    BlockKindData::Paragraph
                        | BlockKindData::Heading { .. }
                        | BlockKindData::List { .. }
                        | BlockKindData::Blockquote
                )
            )
        });
        if needs {
            let index = self.doc.children(root).len();
            let landing = super::step::DetachedBlock::paragraph(super::inline::InlineText::new());
            self.doc.source_map.synthetic.insert(landing.id);
            self.doc.attach(root, index, landing);
            self.doc.touch(root);
            self.doc.refresh_order();
        }
    }

    #[cfg(test)]
    pub(crate) fn doc(&self) -> &EditorDocument {
        &self.doc
    }
}
