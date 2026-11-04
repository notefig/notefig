//! `markdown::parse` output (`BlockNode`) into the editor model.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::SharedString;

use super::{
    document::{AtomData, BlockContent, EditorDocument},
    inline::{InlineAtom, InlineText},
    kind::BlockKindData,
    step::{DetachedBlock, DetachedContent},
    transaction::TransactionBuilder,
};
use gpui_kit::base::text::{
    MarkdownExtensions,
    editor_host::{BlockNode, InlineNode, LinkMark, Paragraph, TextMark, parse_markdown},
};

pub(crate) fn parse_document(
    source: &str,
    extensions: Arc<MarkdownExtensions>,
) -> Result<EditorDocument, SharedString> {
    let (frontmatter, body_start) = match super::source_map::split_frontmatter(source) {
        Some((frontmatter, len)) => (Some(frontmatter), len),
        None => (None, 0),
    };
    let mut doc = parse_body(&source[body_start..], extensions)?;
    doc.frontmatter = frontmatter;
    Ok(doc)
}

pub(crate) fn parse_body(
    source: &str,
    extensions: Arc<MarkdownExtensions>,
) -> Result<EditorDocument, SharedString> {
    use super::source_map::{Origin, Trailer, next_generation};
    let parsed = parse_markdown(source, extensions.clone())?;
    let mut doc = EditorDocument::empty(extensions);
    let root = doc.root;
    // Drop the placeholder paragraph of the empty document.
    doc.detach(root, 0);
    let mut defs = Defs::new();
    collect_definitions(&parsed, &mut defs);
    let shared: Arc<str> = Arc::from(source);
    let generation = next_generation();
    let mut blocks = Vec::new();
    // (block id, parse index, span, gap before)
    let mut origins = Vec::new();
    let mut prev_end = 0;
    for (index, node) in parsed.iter().enumerate() {
        let before = blocks.len();
        import_block(node, &defs, &mut blocks);
        let span = node.span().filter(|span| {
            span.start <= span.end && span.end <= source.len() && span.start >= prev_end
        });
        if let Some(mut span) = span {
            // Line endings after a block belong to the separator.
            // (An unclosed code fence owns its final line endings.)
            if !matches!(node, BlockNode::CodeBlock(_)) {
                let trimmed = source[span.start..span.end].trim_end_matches(['\r', '\n']);
                span.end = span.start + trimmed.len();
            }
            if blocks.len() == before + 1 {
                origins.push((blocks[before].id, index, span.start..span.end, prev_end..span.start));
            }
            prev_end = span.end;
        }
    }
    // A repeated prompt-widget id is dropped (spec §1.3).
    let mut seen_widgets = std::collections::HashSet::new();
    let mut dropped = std::collections::HashSet::new();
    for block in &blocks {
        if let DetachedContent::Leaf(BlockContent::Atom(AtomData::Custom(node))) = &block.content
            && let Some(widget) = super::notefig::PromptWidget::of(node)
            && !seen_widgets.insert(widget.id.clone())
        {
            dropped.insert(block.id);
        }
    }
    blocks.retain(|block| !dropped.contains(&block.id));
    let last_index = parsed.len().checked_sub(1);
    for (ix, block) in blocks.into_iter().enumerate() {
        doc.attach(root, ix, block);
    }
    // Same structural rules as after every transaction (empty list items
    // get a paragraph, an empty document gets one leaf). The steps of this
    // pass are not history.
    let mut tx = TransactionBuilder::new(&mut doc);
    tx.normalize()
        .map_err(|e| SharedString::from(format!("{e:?}")))?;
    drop(tx);
    doc.structure_dirty = true;
    doc.refresh_order();
    // Blocks normalization touched (merged lists, …) are not their source.
    // Normalization may merge a block into the one before it (adjacent
    // lists of different markers): the survivor then owns both sources. A
    // block it touched otherwise still has its source as the truth, so the
    // revision after normalization is the recorded one.
    let mut i = 0;
    while i < origins.len() {
        let (id, index, span, gap_before) = origins[i].clone();
        let mut j = i + 1;
        let (mut end, mut last) = (span.end, index);
        if doc.parent(id) == Some(root) {
            while j < origins.len()
                && doc.get(origins[j].0).is_none()
                && !dropped.contains(&origins[j].0)
                && origins[j].1 == last + 1
            {
                end = origins[j].2.end;
                last = origins[j].1;
                j += 1;
            }
            doc.source_map.origins.insert(
                id,
                Origin {
                    generation,
                    index,
                    last_index: last,
                    source: shared.clone(),
                    span: span.start..end,
                    gap_before,
                    revision: doc.block_revision(id),
                    canonical: None,
                },
            );
        }
        i = j;
    }
    // The file's list style: the first bullet and ordered lists decide.
    let (mut bullet, mut delimiter) = (None, None);
    for id in doc.children(root) {
        if let (Some(BlockKindData::List { .. }), Some(origin)) =
            (doc.kind(*id), doc.source_map.origins.get(id))
        {
            let (b, d) = super::source_map::list_style_of(origin.text());
            bullet = bullet.or(b);
            delimiter = delimiter.or(d);
        }
    }
    let (underscore_em, underscore_strong) = super::source_map::learn_emphasis(source);
    doc.list_style = super::source_map::ListStyle {
        bullet: bullet.unwrap_or('-'),
        delimiter: delimiter.unwrap_or('.'),
        underscore_em,
        underscore_strong,
    };
    let exterior_start = prev_end.min(source.len());
    doc.source_map.trailer = Some(Trailer {
        generation,
        last_index: last_index.unwrap_or(0),
        text: source[exterior_start..].to_string(),
    });
    // A file's single final line ending is kept when the end is rewritten;
    // more are editing boundaries (empty paragraphs) of their own.
    doc.source_map.final_newline =
        source.ends_with('\n') && !source.ends_with("\n\n") && !source.ends_with("\n\r\n");
    if parsed.is_empty() {
        // A blank body: the one empty paragraph writes the original bytes.
        for id in doc.children(root).to_vec() {
            doc.source_map.synthetic.insert(id);
        }
    }
    doc.refresh_order();
    // Markdown parsers omit final blank paragraphs. Reconstruct that editable
    // boundary (two or more final line endings) as empty paragraphs; they are
    // synthetic, so they write nothing while untouched and the original
    // trailing bytes are kept.
    let trimmed_spaces = source[exterior_start..].trim_end_matches([' ', '\t']);
    let stripped = trimmed_spaces.trim_end_matches(['\r', '\n']);
    let line_ends = &trimmed_spaces[stripped.len()..];
    let ending_count = if line_ends.contains('\n') {
        line_ends.bytes().filter(|b| *b == b'\n').count()
    } else {
        line_ends.len()
    };
    let landing = if ending_count <= 1 { 0 } else { ending_count.div_ceil(2) };
    for _ in 0..landing {
        let index = doc.children(root).len();
        let block = DetachedBlock::leaf(
            BlockKindData::Paragraph,
            BlockContent::Inline(InlineText::default()),
        );
        doc.source_map.synthetic.insert(block.id);
        doc.attach(root, index, block);
    }
    doc.refresh_order();

    // CommonMark ignores terminal paragraph spaces, but in a live editing
    // buffer they separate the next typed/dictated word. Restore that trivia
    // into the document, not a second mutable source buffer. Code retains its
    // exact own body and must not inherit trivia after its closing fence.
    let trimmed = source.trim_end_matches([' ', '\t']);
    let mut tail = &source[trimmed.len()..];
    let last = *doc.leaves().last().unwrap();
    if (matches!(doc.kind(last), Some(BlockKindData::Heading { .. }))
        || doc.index_in_parent(last).is_some_and(|(parent, _)| {
            matches!(doc.kind(parent), Some(BlockKindData::ListItem { .. }))
        }))
        && doc.inline(last).is_some_and(|inline| inline.is_empty())
    {
        // One space is the empty heading's structural marker separator.
        tail = tail.strip_prefix(' ').unwrap_or(tail);
    }
    if !tail.is_empty()
        && let Some(entry) = doc.get_mut(last)
        && let BlockContent::Inline(inline) = &mut entry.content
    {
        inline.push(InlineText::plain(tail, TextMark::default()));
    }
    doc.revision = 0;
    Ok(doc)
}

fn leaf(kind: BlockKindData, content: BlockContent) -> DetachedBlock {
    DetachedBlock::leaf(kind, content)
}

fn import_children(nodes: &[BlockNode], defs: &Defs) -> Vec<DetachedBlock> {
    let mut out = Vec::new();
    for node in nodes {
        import_block(node, defs, &mut out);
    }
    out
}

pub(crate) fn import_block(node: &BlockNode, defs: &Defs, out: &mut Vec<DetachedBlock>) {
    let block = match node {
        // An HTML container: splice its children in place.
        BlockNode::Root { children, .. } => {
            for child in children {
                import_block(child, defs, out);
            }
            return;
        }
        BlockNode::Paragraph(paragraph) => leaf(
            BlockKindData::Paragraph,
            BlockContent::Inline(import_inline(paragraph, defs)),
        ),
        BlockNode::Heading {
            level, children, ..
        } => leaf(
            BlockKindData::Heading { level: *level },
            BlockContent::Inline(import_inline(children, defs)),
        ),
        BlockNode::Blockquote { children, .. } => {
            DetachedBlock::container(BlockKindData::Blockquote, import_children(children, defs))
        }
        BlockNode::List {
            children,
            ordered,
            start,
            ..
        } => DetachedBlock::container(
            BlockKindData::List {
                ordered: *ordered,
                start: *start,
            },
            import_children(children, defs),
        ),
        BlockNode::ListItem {
            children,
            spread,
            checked,
            ..
        } => {
            let mut children = import_children(children, defs);
            let mut checked = *checked;
            // Notefig: an item whose text is exactly `[ ]` / `[x]` is an
            // empty task item (markdown-it-task-lists fallback).
            if checked.is_none()
                && children.len() == 1
                && let DetachedContent::Leaf(BlockContent::Inline(inline)) = &children[0].content
                && matches!(children[0].kind, BlockKindData::Paragraph)
                && matches!(inline.text(), "[ ]" | "[x]" | "[X]")
            {
                checked = Some(inline.text() != "[ ]");
                children[0] = DetachedBlock::paragraph(InlineText::new());
            }
            // A parsed bare marker is an editable empty item, not an empty
            // container to prune during normalization.
            if children.is_empty() {
                children.push(DetachedBlock::paragraph(InlineText::new()));
            }
            DetachedBlock::container(
                BlockKindData::ListItem {
                    checked,
                    spread: *spread,
                },
                children,
            )
        }
        BlockNode::CodeBlock(code) => {
            let text = code.code().to_string();
            leaf(
                BlockKindData::CodeBlock {
                    lang: code.lang(),
                    meta: code.meta(),
                },
                BlockContent::Plain(text),
            )
        }
        BlockNode::Custom { node, .. } => leaf(
            BlockKindData::Custom,
            BlockContent::Atom(AtomData::Custom(node.clone())),
        ),
        BlockNode::Table(table) => {
            let rows = table
                .rows()
                .map(|row| {
                    DetachedBlock::container(
                        BlockKindData::TableRow,
                        row.map(|cell| {
                            leaf(
                                BlockKindData::TableCell,
                                BlockContent::Inline(import_inline(cell, defs)),
                            )
                        })
                        .collect(),
                    )
                })
                .collect();
            DetachedBlock::container(
                BlockKindData::Table {
                    aligns: table.column_aligns().to_vec(),
                },
                rows,
            )
        }
        BlockNode::Break { html, .. } => leaf(
            BlockKindData::Break { html: *html },
            BlockContent::Atom(AtomData::None),
        ),
        BlockNode::HorizontalRule { .. } => leaf(
            BlockKindData::HorizontalRule,
            BlockContent::Atom(AtomData::None),
        ),
        BlockNode::Definition {
            identifier,
            url,
            title,
            ..
        } => leaf(
            BlockKindData::Definition {
                identifier: identifier.clone(),
                url: url.clone(),
                title: title.clone(),
            },
            BlockContent::Atom(AtomData::None),
        ),
        BlockNode::Unknown | _ => leaf(BlockKindData::Unknown, BlockContent::Atom(AtomData::None)),
    };
    out.push(block);
}

/// Convert a paragraph's inline nodes into normalized runs. `InlineNode.marks`
/// may overlap (`**b*c*d**` gives bold 0..3 and italic 1..2), so split at
/// every boundary and merge the marks covering each piece.
///
/// Reference links (`[text][id]`) arrive with an empty url and an
/// identifier; they are resolved against the document's definitions so the
/// canonical output is an inline link. Unresolved references (and footnote
/// links) lose their link mark: documented lossiness.
pub(crate) fn import_inline(paragraph: &Paragraph, defs: &Defs) -> InlineText {
    let mut out = InlineText::new();
    for node in paragraph.children() {
        out.push(import_inline_node(node));
    }
    let mut out = super::notefig::merge_script_tags(out);
    let len = out.len();
    out.map_marks(0..len, |mark| match &mark.link {
        Some(link) if link.url.is_empty() => {
            let link = link
                .identifier
                .as_ref()
                .and_then(|id| defs.get(&SharedString::from(id.to_lowercase())))
                .map(|(url, title)| LinkMark {
                    url: url.clone(),
                    identifier: None,
                    title: title.clone(),
                });
            TextMark {
                link,
                ..mark.clone()
            }
        }
        _ => mark.clone(),
    });
    out
}

pub(crate) type Defs = HashMap<SharedString, (SharedString, Option<SharedString>)>;

pub(crate) fn collect_definitions(nodes: &[BlockNode], defs: &mut Defs) {
    for node in nodes {
        match node {
            BlockNode::Definition {
                identifier,
                url,
                title,
                ..
            } => {
                defs.insert(
                    identifier.to_lowercase().into(),
                    (url.clone(), title.clone()),
                );
            }
            BlockNode::Root { children, .. }
            | BlockNode::Blockquote { children, .. }
            | BlockNode::List { children, .. }
            | BlockNode::ListItem { children, .. } => collect_definitions(children, defs),
            _ => {}
        }
    }
}

fn import_inline_node(node: &InlineNode) -> InlineText {
    let merged_marks = || {
        let mut mark = TextMark::default();
        for (_, layer) in node.mark_runs() {
            mark.merge(layer.clone());
        }
        mark
    };
    if let Some(custom) = node.as_custom() {
        return InlineText::atom(InlineAtom::Custom(custom.clone()), merged_marks());
    }
    if let Some(image) = node.as_image() {
        return InlineText::atom(InlineAtom::Image(image.clone()), merged_marks());
    }
    let text: &str = node.text();
    let mut cuts = vec![0, text.len()];
    for (range, _) in node.mark_runs() {
        cuts.push(range.start.min(text.len()));
        cuts.push(range.end.min(text.len()));
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = InlineText::new();
    for pair in cuts.windows(2) {
        let (lo, hi) = (pair[0], pair[1]);
        if lo >= hi || !text.is_char_boundary(lo) || !text.is_char_boundary(hi) {
            continue;
        }
        let mut mark = TextMark::default();
        for (range, layer) in node.mark_runs() {
            if range.start <= lo && hi <= range.end {
                mark.merge(layer.clone());
            }
        }
        out.push(InlineText::plain(&text[lo..hi], mark));
    }
    out
}

/// Footnotes and unsupported HTML are outside the editable block vocabulary. Keep their original
/// source in opaque, selectable atoms rather than accepting the display
/// parser's decorated-prose projection. Uses the same AST/parser pipeline as
/// every other editor node; no second parser or mutable source mirror.
pub(crate) fn preserve_source_extensions(extensions: MarkdownExtensions) -> MarkdownExtensions {
    use ::markdown::mdast::Node;
    use gpui_kit::base::text::{MarkdownNode, MarkdownParseContext, MarkdownPlugin};

    struct SourceAtom {
        block: bool,
    }
    impl MarkdownPlugin for SourceAtom {
        fn name(&self) -> &str {
            if self.block {
                "editor-source-block"
            } else {
                "editor-source-inline"
            }
        }
        fn is_block(&self) -> bool {
            self.block
        }
        fn parse(&self, node: &Node, cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
            let known_html = if let Node::Html(html) = node {
                let lower = html.value.to_ascii_lowercase();
                let tag = lower
                    .trim_start_matches('<')
                    .trim_start_matches('/')
                    .split(|ch: char| !ch.is_ascii_alphabetic())
                    .next()
                    .unwrap_or_default();
                matches!(tag, "u" | "mark" | "em" | "strong" | "s" | "del" | "br")
            } else {
                false
            };
            let accepts = if self.block {
                matches!(node, Node::FootnoteDefinition(_))
                    || (matches!(node, Node::Html(_)) && !known_html)
            } else {
                matches!(node, Node::FootnoteReference(_))
                    || (matches!(node, Node::Html(_)) && !known_html)
            };
            if !accepts {
                return None;
            }
            if self.block
                && let Node::Html(html) = node
                && let Some(widget) = super::notefig::PromptWidget::parse_marker(&html.value)
            {
                return Some(widget.node());
            }
            let source = cx.node_source(node)?;
            // Block spans may include separator line endings. The root owns
            // those boundaries; retaining them here adds a blank line on every
            // export/import cycle. Internal content remains verbatim.
            let source = if self.block {
                source.trim_end_matches(['\r', '\n'])
            } else {
                source
            };
            let source = if self.block {
                // The AST span starts after the first container marker, but
                // later source lines still include it. Strip only matching
                // continuation prefixes, preserving body indentation and lazy
                // lines. The root serializer will add the containers once.
                let start = node.position()?.start.offset;
                let line_start = cx.source()[..start].rfind('\n').map_or(0, |ix| ix + 1);
                let prefix = &cx.source()[line_start..start];
                let continuation = prefix
                    .chars()
                    .map(|ch| if ch == '>' { '>' } else { ' ' })
                    .collect::<String>();
                source
                    .split('\n')
                    .enumerate()
                    .map(|(ix, line)| {
                        if ix == 0 || continuation.is_empty() {
                            line
                        } else if line.trim_end() == continuation.trim_end() {
                            ""
                        } else {
                            line.strip_prefix(&continuation).unwrap_or(line)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                source.to_owned()
            };
            Some(
                MarkdownNode::new(self.name(), ())
                    .text(source.clone())
                    .markdown(source),
            )
        }
    }
    extensions
        .plugin(SourceAtom { block: true })
        .plugin(SourceAtom { block: false })
        // Without an app node view, a prompt widget shows a muted label.
        .block_renderer(super::notefig::PROMPT_NODE, |node, _, cx| {
            use gpui::{ParentElement, Styled, div, px};
            let theme = gpui_kit::base::Theme::global(cx);
            let id = super::notefig::PromptWidget::of(node)
                .map(|w| w.id.to_string())
                .unwrap_or_default();
            div()
                .px(px(10.))
                .py(px(6.))
                .rounded(px(6.))
                .border_1()
                .border_color(theme.tokens.colors.border)
                .text_color(theme.tokens.colors.muted_foreground)
                .child(format!("✦ AI prompt {id}"))
        })
}
