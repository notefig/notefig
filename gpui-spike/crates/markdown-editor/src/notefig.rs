//! Notefig syntax on top of the fork: prompt-widget markers, `<sub>`/`<sup>`,
//! `@path` mentions, diff fences, frontmatter access, and the model-level
//! commands the app drives (widgets, agent inserts, search).

use gpui::SharedString;

use super::{
    command::CommandError,
    document::{AtomData, BlockContent, EditorDocument},
    editor::BlockEditorModel,
    id::BlockId,
    inline::{ATOM_CHAR, InlineAtom, InlineText},
    kind::BlockKindData,
    position::BlockPosition,
    selection::BlockSelection,
    source_map::Frontmatter,
    step::{DetachedBlock, Step},
    transaction::EditOrigin,
};
use gpui_kit::base::text::{MarkdownNode, editor_host::TextMark};

/// Custom node names the editor gives Notefig atoms.
pub const PROMPT_NODE: &str = "notefig-prompt";
pub const MENTION_NODE: &str = "notefig-mention";
pub const SUB_NODE: &str = "notefig-sub";
pub const SUP_NODE: &str = "notefig-sup";

/// An AI prompt widget block. `task` is the bound agent task; an unbound
/// widget (no task) is never written to the file (spec §1.3).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PromptWidget {
    pub id: SharedString,
    pub task: Option<SharedString>,
}

/// The longest reference a selection summon keeps (TS `MAX_REFERENCE_CHARS`).
pub const MAX_REFERENCE_CHARS: usize = 8000;

/// A selection a widget refers to (TS's `reference` attr on the widget
/// node; here kept per widget block, see `widget_reference`): its text (blocks joined by `\n`, at most
/// [`MAX_REFERENCE_CHARS`] characters) and where it was when summoned.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PromptReference {
    pub text: SharedString,
    pub from: BlockPosition,
    pub to: BlockPosition,
}

impl PromptWidget {
    /// A widget with no reference.
    pub fn new(id: impl Into<SharedString>, task: Option<SharedString>) -> Self {
        Self { id: id.into(), task }
    }

    /// The on-disk marker: `<!-- notefig:prompt id="…" task="…" -->`, or
    /// nothing while unbound.
    pub fn marker(&self) -> String {
        match &self.task {
            Some(task) => format!("<!-- notefig:prompt id=\"{}\" task=\"{}\" -->", self.id, task),
            None => String::new(),
        }
    }

    /// Parse a marker comment. Accepts the attribute form
    /// (`id="…" task="…"`) and a positional form (`<id> <task>`).
    pub fn parse_marker(html: &str) -> Option<Self> {
        let body = html
            .trim()
            .strip_prefix("<!--")?
            .strip_suffix("-->")?
            .trim()
            .strip_prefix("notefig:prompt")?;
        if !body.is_empty() && !body.starts_with(char::is_whitespace) {
            return None;
        }
        let valid = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        };
        let attr = |name: &str| -> Option<String> {
            let key = format!("{name}=\"");
            let start = body.find(&key)? + key.len();
            let end = body[start..].find('"')? + start;
            Some(body[start..end].to_string())
        };
        let (id, task) = if body.contains("id=\"") {
            (attr("id")?, attr("task"))
        } else {
            let mut words = body.split_whitespace();
            (
                words.next()?.to_string(),
                words.next().map(str::to_string),
            )
        };
        if !valid(&id) || task.as_deref().is_some_and(|t| !valid(t)) {
            return None;
        }
        Some(Self {
            id: id.into(),
            task: task.map(Into::into),
        })
    }

    pub(crate) fn node(&self) -> MarkdownNode {
        MarkdownNode::new(PROMPT_NODE, self.clone())
            .markdown(self.marker())
            .accessibility_label("AI prompt")
    }

    pub(crate) fn of(node: &MarkdownNode) -> Option<&Self> {
        (node.name() == PROMPT_NODE)
            .then(|| node.data::<Self>())
            .flatten()
    }
}

/// Mint a fresh widget id (`blob_<base36 time><rand>`, as the TS app does).
pub fn new_prompt_widget_id() -> SharedString {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("blob_{}{}", base36(time), base36(n * 7919 % 46656 + 1296)).into()
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Remove prompt markers from Markdown (for emptiness checks).
pub fn strip_prompt_markers(markdown: &str) -> String {
    markdown
        .lines()
        .filter(|line| PromptWidget::parse_marker(line).is_none())
        .collect::<Vec<_>>()
        .join("\n")
}

/// An `@relative/path` mention chip: an inline atom written as `@path`.
pub(crate) fn mention_node(path: &str) -> MarkdownNode {
    let text = format!("@{path}");
    MarkdownNode::new(MENTION_NODE, SharedString::from(path.to_string()))
        .text(text.clone())
        .markdown(text)
}

/// Whether a fence's info string makes it a Notefig diff block: `diff`
/// among the words after the language (```` ```ts diff ````). A lone
/// ```` ```diff ```` is the diff *language*.
pub fn is_diff_fence(lang: Option<&str>, meta: Option<&str>) -> bool {
    lang.is_some() && meta.is_some_and(|meta| meta.split_whitespace().any(|w| w == "diff"))
}

/// Merge `<sub>…</sub>` and `<sup>…</sup>` (parsed as separate raw-HTML
/// atoms around the text) into one atom each, which renders its text and
/// writes back `<sub>…</sub>` (TextMark has no sub/sup, so they are atoms).
pub(crate) fn merge_script_tags(inline: InlineText) -> InlineText {
    let pieces: Vec<_> = inline
        .pieces()
        .map(|(range, mark, atom)| (range, mark.clone(), atom.cloned()))
        .collect();
    let tag_of = |atom: &Option<InlineAtom>| -> Option<String> {
        match atom {
            Some(InlineAtom::Custom(node)) if node.name().starts_with("editor-source") => {
                Some(node.as_markdown().trim().to_ascii_lowercase())
            }
            _ => None,
        }
    };
    if !pieces
        .iter()
        .any(|(_, _, atom)| matches!(tag_of(atom).as_deref(), Some("<sub>" | "<sup>")))
    {
        return inline;
    }
    let mut out = InlineText::new();
    let mut ix = 0;
    while ix < pieces.len() {
        let (range, mark, atom) = &pieces[ix];
        let open = tag_of(atom);
        if let Some(name) = match open.as_deref() {
            Some("<sub>") => Some("sub"),
            Some("<sup>") => Some("sup"),
            _ => None,
        } {
            let close = format!("</{name}>");
            if let Some(end) = (ix + 1..pieces.len())
                .find(|j| tag_of(&pieces[*j].2).as_deref() == Some(close.as_str()))
            {
                let mut inner = InlineText::new();
                for (r, m, a) in &pieces[ix + 1..end] {
                    match a {
                        Some(a) => inner.push(InlineText::atom(a.clone(), m.clone())),
                        None => inner.push(InlineText::plain(&inline.text()[r.clone()], m.clone())),
                    }
                }
                let text: String = inner.text().chars().filter(|c| *c != ATOM_CHAR).collect();
                let markdown = format!(
                    "<{name}>{}</{name}>",
                    super::serialize::inline_markdown(&inner)
                );
                let node = MarkdownNode::new(
                    if name == "sub" { SUB_NODE } else { SUP_NODE },
                    (),
                )
                .text(text)
                .markdown(markdown);
                out.push(InlineText::atom(InlineAtom::Custom(node), mark.clone()));
                ix = end + 1;
                continue;
            }
        }
        match atom {
            Some(a) => out.push(InlineText::atom(a.clone(), mark.clone())),
            None => out.push(InlineText::plain(&inline.text()[range.clone()], mark.clone())),
        }
        ix += 1;
    }
    out
}

/// Where [`BlockEditorModel::insert_prompt_widget`] puts a new widget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetPlacement {
    /// Replace this block (the paragraph holding `/`, or an empty one).
    Replace(BlockId),
    /// After this top-level-or-nested block, as its next sibling.
    After(BlockId),
    /// At the caret: replaces the caret's paragraph when it is empty or just
    /// `/`, otherwise goes after it.
    Caret,
}

impl EditorDocument {
    pub(crate) fn prompt_widget(&self, id: BlockId) -> Option<&PromptWidget> {
        match &self.get(id)?.content {
            BlockContent::Atom(AtomData::Custom(node)) => PromptWidget::of(node),
            _ => None,
        }
    }

    /// Every prompt widget, in document order.
    pub(crate) fn prompt_widgets(&self) -> Vec<(BlockId, PromptWidget)> {
        self.walk_leaves()
            .into_iter()
            .filter_map(|id| self.prompt_widget(id).map(|w| (id, w.clone())))
            .collect()
    }
}

/// Decides whether a widget must stay (TS: not `removable`, e.g. its agent
/// is working). Set with [`BlockEditorModel::set_widget_removal_guard`].
pub type WidgetRemovalGuard = std::rc::Rc<dyn Fn(&PromptWidget) -> bool>;

/// A guarded widget found in a removed subtree: its block, where it sat
/// (its parent and index there, which may be removed too), and which
/// removal took it.
struct Dropped {
    block: DetachedBlock,
    widget: PromptWidget,
    parent: BlockId,
    index: usize,
}

fn collect_dropped(
    blocks: &[DetachedBlock],
    parent: BlockId,
    first_index: usize,
    keep: &dyn Fn(&PromptWidget) -> bool,
    out: &mut Vec<Dropped>,
) {
    use super::step::DetachedContent;
    for (i, block) in blocks.iter().enumerate() {
        match &block.content {
            DetachedContent::Leaf(BlockContent::Atom(AtomData::Custom(node))) => {
                if let Some(widget) = PromptWidget::of(node).filter(|w| keep(w)) {
                    out.push(Dropped {
                        block: block.clone(),
                        widget: widget.clone(),
                        parent,
                        index: first_index + i,
                    });
                }
            }
            DetachedContent::Children(children) => {
                collect_dropped(children, block.id, 0, keep, out)
            }
            DetachedContent::Leaf(_) => {}
        }
    }
}

fn subtree_contains(blocks: &[DetachedBlock], id: BlockId) -> Option<usize> {
    use super::step::DetachedContent;
    blocks.iter().position(|block| {
        block.id == id
            || matches!(&block.content, DetachedContent::Children(c) if subtree_contains(c, id).is_some())
    })
}

/// Put back every widget the transaction removed that `keep` says must
/// stay, at its old place mapped through the edit; the rest of the edit
/// stands (TS `restoreKeptWidgetsTr`). Returns the widgets put back.
pub(crate) fn restore_guarded_widgets(
    tx: &mut super::transaction::TransactionBuilder<'_>,
    keep: &dyn Fn(&PromptWidget) -> bool,
) -> Result<Vec<(BlockId, PromptWidget)>, super::step::StepError> {
    let removals: Vec<(BlockId, usize, &[DetachedBlock])> = tx
        .inverse_steps()
        .iter()
        .filter_map(|step| match step {
            Step::InsertBlocks { parent, index, blocks } => Some((*parent, *index, blocks.as_slice())),
            _ => None,
        })
        .collect();
    let mut dropped = Vec::new();
    for (parent, index, blocks) in &removals {
        collect_dropped(blocks, *parent, *index, keep, &mut dropped);
    }
    if dropped.is_empty() {
        return Ok(Vec::new());
    }
    let attached = |doc: &EditorDocument, id: BlockId| id == doc.root || doc.index_in_parent(id).is_some();
    // Resolve every target before inserting: the removals borrow the builder.
    let mut targets = Vec::new();
    for d in dropped {
        if attached(tx.doc, d.block.id) {
            continue; // moved, not removed
        }
        let (mut parent, mut index) = (d.parent, d.index);
        while !attached(tx.doc, parent) {
            match removals
                .iter()
                .find_map(|(p, i, blocks)| subtree_contains(blocks, parent).map(|k| (*p, *i + k)))
            {
                Some(up) => (parent, index) = up,
                None => (parent, index) = (tx.doc.root, usize::MAX),
            }
        }
        targets.push((d, parent, index));
    }
    let mut out = Vec::new();
    let mut last: Option<(BlockId, usize)> = None;
    for (d, mut parent, mut index) in targets {
        // A list holds only items: the widget goes after the list instead.
        while matches!(tx.doc.kind(parent), Some(BlockKindData::List { .. })) {
            match tx.doc.index_in_parent(parent) {
                Some((up, at)) => (parent, index) = (up, at + 1),
                None => break,
            }
        }
        index = index.min(tx.doc.children(parent).len());
        if let Some((p, i)) = last
            && p == parent
            && i >= index
        {
            index = i + 1;
        }
        let id = d.block.id;
        tx.insert(parent, index, vec![d.block])?;
        last = Some((parent, index));
        out.push((id, d.widget));
    }
    Ok(out)
}

pub(crate) fn widget_block_with_id(widget: &PromptWidget, id: BlockId) -> DetachedBlock {
    let mut block = widget_block(widget);
    block.id = id;
    block
}

fn widget_block(widget: &PromptWidget) -> DetachedBlock {
    DetachedBlock::leaf(
        BlockKindData::Custom,
        BlockContent::Atom(AtomData::Custom(widget.node())),
    )
}

impl BlockEditorModel {
    // ---- frontmatter -------------------------------------------------

    /// The YAML frontmatter (between the fences), if the document has one.
    pub fn frontmatter(&self) -> Option<&str> {
        self.doc.frontmatter.as_ref().map(|f| f.yaml.as_str())
    }

    /// Replace the frontmatter YAML (`None` or empty removes it). One undo
    /// step; writes `---\n{yaml}\n---` from now on.
    pub fn set_frontmatter(&mut self, yaml: Option<&str>) -> Result<bool, CommandError> {
        let value = yaml.filter(|y| !y.trim().is_empty()).map(|yaml| Frontmatter {
            yaml: yaml.trim_end_matches(['\n', '\r']).to_string(),
            raw: None,
        });
        if value.as_ref().map(|f| &f.yaml) == self.doc.frontmatter.as_ref().map(|f| &f.yaml) {
            return Ok(false);
        }
        self.transact(EditOrigin::Command("frontmatter"), |tx| {
            tx.step(Step::SetFrontmatter { value })?;
            Ok(None)
        })
    }

    // ---- prompt widgets ------------------------------------------------

    /// Every prompt widget block, in document order.
    pub fn prompt_widgets(&self) -> Vec<(BlockId, PromptWidget)> {
        self.doc.prompt_widgets()
    }

    /// The block holding the widget with `id`.
    pub fn find_prompt_widget(&self, id: &str) -> Option<BlockId> {
        self.doc
            .prompt_widgets()
            .into_iter()
            .find(|(_, w)| w.id == id)
            .map(|(block, _)| block)
    }

    /// The widget a block holds, if it is a prompt widget.
    pub fn prompt_widget(&self, block: BlockId) -> Option<PromptWidget> {
        self.doc.prompt_widget(block).cloned()
    }

    /// What a selection summon would refer to: the selected text (blocks
    /// joined by `\n`, clamped to [`MAX_REFERENCE_CHARS`]) and its ends.
    /// `None` for a caret, a block or cell selection, or blank text.
    pub fn selection_reference(&self) -> Option<PromptReference> {
        if !matches!(self.selection, BlockSelection::Text { .. }) {
            return None;
        }
        let range = self.doc.resolve_selection(&self.selection).ok()?;
        if range.is_collapsed() {
            return None;
        }
        let text = self
            .text_ranges(range)
            .into_iter()
            .map(|(block, lo, hi)| {
                self.doc
                    .leaf_text(block)
                    .and_then(|t| t.get(lo..hi))
                    .unwrap_or("")
                    .replace(ATOM_CHAR, "")
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            return None;
        }
        let text = match text.char_indices().nth(MAX_REFERENCE_CHARS) {
            Some((cut, _)) => text[..cut].to_string(),
            None => text,
        };
        Some(PromptReference {
            text: text.into(),
            from: range.start,
            to: range.end,
        })
    }

    /// Where a selection summon goes: right after the block the selection
    /// ends in, inside the innermost (non-task) list item, else after the
    /// top-level block (TS `selectionSummonPos`).
    fn selection_summon_after(&self, end: BlockId) -> Option<BlockId> {
        let path = self.doc.path(end);
        (0..path.len().saturating_sub(1)).rev().find_map(|d| {
            let item = matches!(
                self.doc.kind(path[d]),
                Some(BlockKindData::ListItem { checked: None, .. })
            );
            (d == 0 || item).then(|| path[d + 1])
        })
    }

    /// The selection summon: insert a widget `id` carrying the selection as
    /// its reference after the block the selection ends in. The referenced
    /// text stays; the caret lands on the widget. One undo step. `Ok(None)`
    /// when there is nothing to refer to.
    pub fn summon_on_selection(
        &mut self,
        id: impl Into<SharedString>,
    ) -> Result<Option<BlockId>, CommandError> {
        let Some(reference) = self.selection_reference() else {
            return Ok(None);
        };
        let Some(after) = self.selection_summon_after(reference.to.block) else {
            return Ok(None);
        };
        let block = self.insert_prompt_widget(PromptWidget::new(id, None), WidgetPlacement::After(after))?;
        self.widget_references.insert(block, reference);
        Ok(Some(block))
    }

    /// The selection a widget was summoned on (TS `reference`): the
    /// referenced text stays in the document; this is what the prompt is
    /// about. Kept with the widget's block through rebinding and undo;
    /// never written to the file.
    pub fn widget_reference(&self, block: BlockId) -> Option<&PromptReference> {
        self.widget_references.get(&block)
    }

    /// Insert a prompt widget block as one undo step and return its block.
    /// A paragraph follows it so the caret has somewhere to land; the caret
    /// is left on the widget (offset 0), where the app focuses its input.
    pub fn insert_prompt_widget(
        &mut self,
        widget: PromptWidget,
        placement: WidgetPlacement,
    ) -> Result<BlockId, CommandError> {
        let block = widget_block(&widget);
        let id = block.id;
        let placement = match placement {
            WidgetPlacement::Caret => {
                let caret = self.caret().ok_or(CommandError::Unsupported("no caret"))?;
                let text = self.doc.inline(caret.block).map(|i| i.text().to_string());
                match text.as_deref() {
                    Some("" | "/")
                        if matches!(self.doc.kind(caret.block), Some(BlockKindData::Paragraph)) =>
                    {
                        WidgetPlacement::Replace(caret.block)
                    }
                    _ => WidgetPlacement::After(self.top_or_item_child(caret.block)),
                }
            }
            other => other,
        };
        self.transact(EditOrigin::Command("insert-prompt"), move |tx| {
            let (target, replace) = match placement {
                WidgetPlacement::Replace(b) => (b, true),
                WidgetPlacement::After(b) => (b, false),
                WidgetPlacement::Caret => unreachable!(),
            };
            let (parent, index) = tx
                .doc
                .index_in_parent(target)
                .ok_or(CommandError::Unsupported("unknown block"))?;
            if replace {
                tx.remove(parent, index..index + 1)?;
                tx.insert(parent, index, vec![block])?;
            } else {
                tx.insert(parent, index + 1, vec![block])?;
            }
            let at = if replace { index } else { index + 1 };
            // A landing paragraph after the widget, unless one is there.
            let next_is_text = tx
                .doc
                .children(parent)
                .get(at + 1)
                .is_some_and(|next| tx.doc.inline(*next).is_some());
            if !next_is_text {
                let landing = DetachedBlock::paragraph(InlineText::new());
                // UI-only (TipTap's trailing node): writes nothing while empty.
                tx.doc.source_map.synthetic.insert(landing.id);
                tx.insert(parent, at + 1, vec![landing])?;
            }
            Ok(Some(BlockSelection::caret(BlockPosition::new(id, 0))))
        })?;
        Ok(id)
    }

    /// Rebind a widget (e.g. set its task once sent). The block keeps its id;
    /// the marker on disk follows. One undo step.
    pub fn set_prompt_widget(
        &mut self,
        block: BlockId,
        widget: PromptWidget,
    ) -> Result<bool, CommandError> {
        if self.doc.prompt_widget(block).is_none() {
            return Err(CommandError::Unsupported("not a prompt widget"));
        }
        if self.doc.prompt_widget(block) == Some(&widget) {
            return Ok(false);
        }
        self.transact(EditOrigin::Command("set-prompt"), move |tx| {
            let (parent, index) = tx.doc.index_in_parent(block).ok_or(CommandError::Unsupported("unknown block"))?;
            tx.remove(parent, index..index + 1)?;
            let mut replacement = widget_block(&widget);
            replacement.id = block;
            tx.insert(parent, index, vec![replacement])?;
            Ok(None)
        })
    }

    /// Remove a widget. With `text`, it becomes a paragraph holding that text
    /// (Esc on a summoned widget reverts it to `/`), with the caret at its
    /// end; otherwise it is deleted and the caret goes to the block above.
    pub fn remove_prompt_widget(
        &mut self,
        block: BlockId,
        text: Option<&str>,
    ) -> Result<bool, CommandError> {
        if self.doc.prompt_widget(block).is_none() {
            return Err(CommandError::Unsupported("not a prompt widget"));
        }
        let text = text.map(str::to_string);
        self.transact(EditOrigin::Command("remove-prompt"), move |tx| {
            let (parent, index) = tx.doc.index_in_parent(block).ok_or(CommandError::Unsupported("unknown block"))?;
            tx.remove(parent, index..index + 1)?;
            if let Some(text) = text {
                let paragraph = DetachedBlock::paragraph(InlineText::plain(&text, TextMark::default()));
                let id = paragraph.id;
                let len = text.len();
                tx.insert(parent, index, vec![paragraph])?;
                return Ok(Some(BlockSelection::caret(BlockPosition::new(id, len))));
            }
            let above = index
                .checked_sub(1)
                .and_then(|i| tx.doc.children(parent).get(i).copied());
            Ok(above.map(|b| BlockSelection::caret(tx.doc.last_leaf_in(b))))
        })
    }

    /// The block to insert after for a caret block: the caret leaf itself.
    fn top_or_item_child(&self, block: BlockId) -> BlockId {
        block
    }

    // ---- mentions ------------------------------------------------------

    /// Insert an `@path` mention chip at the selection (an inline atom
    /// written back as `@path`).
    pub fn insert_mention(&mut self, path: &str) -> Result<(), CommandError> {
        let caret = self.caret().ok_or(CommandError::Unsupported("no caret"))?;
        if self.doc.inline(caret.block).is_none() {
            return Err(CommandError::NotEditable(caret.block));
        }
        let range = self.doc.resolve_selection(&self.selection)?;
        if range.start.block != range.end.block {
            self.delete(false)?;
        }
        let caret = self.caret().ok_or(CommandError::Unsupported("no caret"))?;
        let (lo, hi) = match &self.selection {
            BlockSelection::Text { anchor, head } if anchor.block == head.block => {
                (anchor.offset.min(head.offset), anchor.offset.max(head.offset))
            }
            _ => (caret.offset, caret.offset),
        };
        let node = mention_node(path);
        self.transact(EditOrigin::Command("mention"), move |tx| {
            let mut insert = InlineText::atom(InlineAtom::Custom(node), TextMark::default());
            insert.push(InlineText::plain(" ", TextMark::default()));
            let len = insert.len();
            tx.replace_text(caret.block, lo..hi, insert)?;
            Ok(Some(BlockSelection::caret(BlockPosition::new(caret.block, lo + len))))
        })?;
        Ok(())
    }

    // ---- sub/sup and blockquote toggles ----------------------------------

    /// Wrap the selected text (in one text block) in a `<sub>`/`<sup>` atom,
    /// or unwrap the script atom the selection covers or the caret is after.
    pub fn toggle_script(&mut self, sup: bool) -> Result<bool, CommandError> {
        let BlockSelection::Text { anchor, head } = self.selection.clone() else {
            return Ok(false);
        };
        if anchor.block != head.block {
            return Ok(false);
        }
        let block = anchor.block;
        let Some(inline) = self.doc.inline(block).cloned() else {
            return Ok(false);
        };
        let (lo, hi) = (anchor.offset.min(head.offset), anchor.offset.max(head.offset));
        let name = if sup { SUP_NODE } else { SUB_NODE };
        // An existing script atom in or just before the selection: unwrap.
        let atom = inline.pieces().find_map(|(range, mark, atom)| match atom {
            Some(InlineAtom::Custom(node))
                if node.name() == name
                    && ((range.start >= lo && range.end <= hi && lo < hi)
                        || (lo == hi && range.end == lo)) =>
            {
                Some((range, mark.clone(), node.as_text().to_string()))
            }
            _ => None,
        });
        if let Some((range, mark, text)) = atom {
            return self.transact(EditOrigin::Command("script"), move |tx| {
                let len = text.len();
                tx.replace_text(block, range.clone(), InlineText::plain(&text, mark))?;
                Ok(Some(BlockSelection::Text {
                    anchor: BlockPosition::new(block, range.start),
                    head: BlockPosition::new(block, range.start + len),
                }))
            });
        }
        if lo == hi {
            return Ok(false);
        }
        let inner = inline.slice(lo..hi);
        let text: String = inner.text().chars().filter(|c| *c != ATOM_CHAR).collect();
        let tag = if sup { "sup" } else { "sub" };
        let markdown = format!("<{tag}>{}</{tag}>", super::serialize::inline_markdown(&inner));
        let node = MarkdownNode::new(name, ()).text(text).markdown(markdown);
        self.transact(EditOrigin::Command("script"), move |tx| {
            let atom = InlineText::atom(InlineAtom::Custom(node), TextMark::default());
            let len = atom.len();
            tx.replace_text(block, lo..hi, atom)?;
            Ok(Some(BlockSelection::caret(BlockPosition::new(block, lo + len))))
        })
    }

    /// Wrap the caret's block in a blockquote, or lift it out of the one it
    /// is in.
    pub fn toggle_blockquote(&mut self) -> Result<bool, CommandError> {
        let caret = self.caret().ok_or(CommandError::Unsupported("no caret"))?;
        let quote = self
            .doc
            .path(caret.block)
            .into_iter()
            .rev()
            .find(|id| matches!(self.doc.kind(*id), Some(BlockKindData::Blockquote)));
        let Some(quote) = quote else {
            return self.wrap_in_blockquote();
        };
        self.transact(EditOrigin::Command("blockquote"), move |tx| {
            let (parent, index) = tx
                .doc
                .index_in_parent(quote)
                .ok_or(CommandError::Unsupported("unknown block"))?;
            let removed = tx.remove(parent, index..index + 1)?;
            let children = match removed.into_iter().next().map(|b| b.content) {
                Some(super::step::DetachedContent::Children(children)) => children,
                _ => Vec::new(),
            };
            tx.insert(parent, index, children)?;
            Ok(None)
        })
    }

    // ---- search ----------------------------------------------------------

    /// Every match of `query` in the document's text leaves, as
    /// `(leaf, byte range)` in document order. Case-insensitive for ASCII
    /// when `case_sensitive` is false.
    pub fn find_all(&self, query: &str, case_sensitive: bool) -> Vec<(BlockId, std::ops::Range<usize>)> {
        let mut out = Vec::new();
        if query.is_empty() {
            return out;
        }
        let needle = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };
        for id in self.doc.leaves() {
            let Some(text) = self.doc.leaf_text(*id) else {
                continue;
            };
            let hay = if case_sensitive {
                text.to_string()
            } else {
                text.to_lowercase()
            };
            // Lowercasing can change byte lengths outside ASCII; only use the
            // offsets when it did not.
            if hay.len() != text.len() {
                continue;
            }
            let mut from = 0;
            while let Some(ix) = hay[from..].find(&needle) {
                let start = from + ix;
                out.push((*id, start..start + needle.len()));
                from = start + needle.len().max(1);
            }
        }
        out
    }
}
