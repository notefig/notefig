//! `EditorDocument` to canonical Markdown. Blocks are written here; inline
//! content goes through main's `MarkdownSource` with the editor's options
//! (`<mark>`, whitespace hoisting, escaping). Table cells use the same inline
//! path rather than `Paragraph::to_markdown`, which is lossy on main.

use super::{
    document::{AtomData, BlockContent, EditorDocument},
    id::BlockId,
    inline::{InlineAtom, InlineText},
    kind::BlockKindData,
};
use crate::markdown_source::{
    MarkdownSource, MarkdownSourceOptions, markdown_destination, markdown_title,
};
use gpui_kit::base::text::editor_host::ColumnAlign;

pub(crate) fn editor_source_options() -> MarkdownSourceOptions {
    let (underscore_em, underscore_strong) = super::source_map::emphasis_style();
    MarkdownSourceOptions {
        highlight_as_html: true,
        hoist_whitespace: true,
        escape_literals: true,
        underscore_em,
        underscore_strong,
    }
}

/// A GFM table in `style` (learned from the table's own source, if any).
fn write_table(rows: &[Vec<String>], aligns: &[ColumnAlign], style: &super::source_map::TableStyle) -> String {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let width = |c: usize| -> usize {
        if !style.aligned {
            return 3;
        }
        rows.iter()
            .filter_map(|r| r.get(c))
            .map(|cell| cell.chars().count())
            .max()
            .unwrap_or(0)
            .max(3)
    };
    let widths: Vec<usize> = (0..cols).map(width).collect();
    let line = |cells: Vec<String>| -> String {
        let (open, sep, close) = match (style.outer_pipes, style.spaced) {
            (true, true) => ("| ", " | ", " |"),
            (true, false) => ("|", "|", "|"),
            (false, true) => ("", " | ", ""),
            (false, false) => ("", "|", ""),
        };
        format!("{open}{}{close}", cells.join(sep))
    };
    let mut lines = Vec::new();
    for (row_ix, row) in rows.iter().enumerate() {
        let cells = (0..cols)
            .map(|c| {
                let cell = row.get(c).cloned().unwrap_or_default();
                if style.aligned {
                    let pad = widths[c].saturating_sub(cell.chars().count());
                    format!("{cell}{}", " ".repeat(pad))
                } else {
                    cell
                }
            })
            .collect();
        lines.push(line(cells));
        if row_ix == 0 {
            if let Some(delimiter) = style
                .delimiter
                .as_ref()
                .filter(|d| !style.aligned && d.0 == aligns.to_vec() && d.0.len() == cols)
            {
                lines.push(delimiter.1.clone());
                continue;
            }
            let delimiters = (0..cols)
                .map(|c| {
                    let w = widths[c];
                    if !style.aligned {
                        return match aligns.get(c).copied().unwrap_or_default() {
                            ColumnAlign::None => "---",
                            ColumnAlign::Left => ":---",
                            ColumnAlign::Center => ":---:",
                            ColumnAlign::Right => "---:",
                        }
                        .to_string();
                    }
                    match aligns.get(c).copied().unwrap_or_default() {
                        ColumnAlign::None => "-".repeat(w),
                        ColumnAlign::Left => format!(":{}", "-".repeat(w - 1)),
                        ColumnAlign::Center => format!(":{}:", "-".repeat(w.saturating_sub(2).max(1))),
                        ColumnAlign::Right => format!("{}:", "-".repeat(w - 1)),
                    }
                })
                .collect();
            lines.push(line(delimiters));
        }
    }
    lines.join("\n")
}

pub(crate) fn serialize(doc: &EditorDocument) -> String {
    block(doc, doc.root)
}

pub(crate) fn join_blocks(doc: &EditorDocument, ids: &[BlockId]) -> String {
    render_children(doc, ids)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Empty paragraphs are editing boundaries, especially at the end of a draft.
/// Preserve their separators so restoring then typing cannot join words.
fn render_children(doc: &EditorDocument, ids: &[BlockId]) -> Vec<(BlockId, String)> {
    ids.iter().map(|id| (*id, block(doc, *id))).collect()
}

/// One block (and its subtree) as canonical Markdown.
pub(crate) fn block_markdown(doc: &EditorDocument, id: BlockId) -> String {
    block(doc, id)
}

fn block(doc: &EditorDocument, id: BlockId) -> String {
    let Some(entry) = doc.get(id) else {
        return String::new();
    };
    let children = doc.children(id);
    match (&entry.kind, &entry.content) {
        (BlockKindData::Root, _) => join_blocks(doc, children),
        (BlockKindData::Paragraph, BlockContent::Inline(inline)) => inline_markdown(inline),
        (BlockKindData::Heading { level }, BlockContent::Inline(inline)) => {
            let text = inline_markdown(inline);
            format!(
                "{} {}",
                "#".repeat(*level as usize),
                text.replace('\n', " ")
            )
        }
        (BlockKindData::Blockquote, _) => join_blocks(doc, children)
            .lines()
            .map(|line| {
                if line.is_empty() {
                    ">".to_string()
                } else {
                    format!("> {line}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        (BlockKindData::List { ordered, start }, _) => {
            let loose = children.iter().any(|item| {
                matches!(
                    doc.kind(*item),
                    Some(BlockKindData::ListItem { spread: true, .. })
                )
            });
            // An item with no content has no stable Markdown form (`-` under
            // a paragraph reads as a setext underline); skip it.
            children
                .iter()
                .map(|item| (*item, list_item(doc, *item, &format!("{} ", doc.list_style(id).0))))
                // Bare empty items also retain a caret/editing boundary.
                .enumerate()
                .map(|(ix, (item, text))| {
                    if *ordered {
                        let marker = format!(
                            "{}{} ",
                            start.unwrap_or(1) as usize + ix,
                            doc.list_style(id).1
                        );
                        // Render with the actual marker width so continuation
                        // indentation remains correct for multi-digit lists.
                        list_item(doc, item, &marker)
                    } else {
                        text
                    }
                })
                .collect::<Vec<_>>()
                .join(if loose { "\n\n" } else { "\n" })
        }
        (BlockKindData::ListItem { .. }, _) => list_item(doc, id, "- "),
        (BlockKindData::CodeBlock { lang, meta }, BlockContent::Plain(code)) => {
            // The final line ending below terminates the fence body. All
            // line endings already in `code` are semantic content.
            let mut info = lang.as_deref().unwrap_or_default().to_owned();
            if let Some(meta) = meta {
                info.push(' ');
                info.push_str(meta);
            }
            let delimiter = if info.contains('`') { '~' } else { '`' };
            let longest = code
                .split(|c| c != delimiter)
                .map(str::len)
                .max()
                .unwrap_or(0);
            let fence = delimiter.to_string().repeat(longest.max(2) + 1);
            format!("{fence}{info}\n{code}\n{fence}")
        }
        (BlockKindData::Table { aligns }, _) => {
            let rows: Vec<Vec<String>> = children
                .iter()
                .map(|row| {
                    doc.children(*row)
                        .iter()
                        .map(|cell| match doc.inline(*cell) {
                            // A soft line break in a cell is `<br>` (D13).
                            Some(inline) => inline_markdown(inline)
                                .replace("\\\n", "<br>")
                                .replace('\n', "<br>")
                                .trim()
                                .to_string(),
                            None => String::new(),
                        })
                        .collect()
                })
                .collect();
            let style = super::source_map::table_style_of(doc, id);
            write_table(&rows, aligns, &style)
        }
        (BlockKindData::HorizontalRule, _) => "---".to_string(),
        // Documented lossiness: a Markdown hard break is an inline concern on
        // main; only the HTML `<br>` block form survives.
        (BlockKindData::Break { html }, _) => {
            if *html {
                "<br>".to_string()
            } else {
                String::new()
            }
        }
        (
            BlockKindData::Definition {
                identifier,
                url,
                title,
            },
            _,
        ) => match title {
            Some(title) => format!(
                "[{identifier}]: {} {}",
                markdown_destination(url),
                markdown_title(title)
            ),
            None => format!("[{identifier}]: {}", markdown_destination(url)),
        },
        (BlockKindData::Custom, BlockContent::Atom(AtomData::Custom(node))) => {
            custom_markdown(node)
        }
        // Documented lossiness: `Unknown` has no source to write back.
        _ => String::new(),
    }
}

/// A list item with continuation lines indented by the marker width.
fn list_item(doc: &EditorDocument, item: BlockId, marker: &str) -> String {
    let (checked, spread) = match doc.kind(item) {
        Some(BlockKindData::ListItem { checked, spread }) => (*checked, *spread),
        _ => (None, false),
    };
    let children = doc.children(item);
    let mut body = String::new();
    // A leading empty subparagraph would terminate a bare list marker and
    // spill the actual body outside the item. Normalize only that prefix;
    // trailing edit boundaries and nonempty terminal spaces remain intact.
    let children = render_children(doc, children)
        .into_iter()
        .skip_while(|(_, text)| text.is_empty())
        .collect::<Vec<_>>();
    for (ix, (child, text)) in children.iter().enumerate() {
        if ix > 0 {
            let prev_is_list = matches!(
                doc.kind(children[ix - 1].0),
                Some(BlockKindData::List { .. })
            );
            let is_list = matches!(doc.kind(*child), Some(BlockKindData::List { .. }));
            // A bare nested marker cannot interrupt a paragraph; without a
            // blank line it becomes literal body text on restore.
            let bare_nested = is_list
                && doc.children(*child).first().is_some_and(|item| {
                    doc.children(*item).iter().all(|leaf| {
                        matches!(doc.kind(*leaf), Some(BlockKindData::Paragraph))
                            && doc
                                .inline(*leaf)
                                .is_some_and(|inline| inline.text().trim().is_empty())
                    })
                });
            // Two paragraphs in a row need a blank line, or they merge.
            body.push_str(
                if spread || bare_nested || (!is_list && !prev_is_list) || prev_is_list {
                    "\n\n"
                } else {
                    "\n"
                },
            );
        }
        body.push_str(text);
    }
    let checkbox = match (checked, body.is_empty()) {
        // An empty task item writes `[ ]` with no trailing space.
        (Some(true), true) => "[x]",
        (Some(false), true) => "[ ]",
        (Some(true), false) => "[x] ",
        (Some(false), false) => "[ ] ",
        (None, _) => "",
    };
    let indent = " ".repeat(marker.len());
    let mut out = String::new();
    for (ix, line) in format!("{checkbox}{body}").split('\n').enumerate() {
        if ix == 0 {
            out.push_str(marker);
            out.push_str(line);
        } else {
            out.push('\n');
            if !line.is_empty() {
                out.push_str(&indent);
                out.push_str(line);
            }
        }
    }
    out.trim_end_matches('\n').to_string()
}

// Inline content goes through `MarkdownSource`, then line starts that
// would read as block syntax are escaped.

pub(crate) fn inline_markdown(inline: &InlineText) -> String {
    let mut source = MarkdownSource::with_options(editor_source_options());
    for (range, marks, atom) in inline.pieces() {
        match atom {
            Some(InlineAtom::Custom(node)) => source.push_marked(&custom_markdown(node), marks),
            Some(InlineAtom::Image(image)) => {
                let alt = image.alt.as_deref().unwrap_or_default();
                let markdown = match &image.title {
                    Some(title) => format!(
                        "![{alt}]({} {})",
                        markdown_destination(&image.url.to_string()),
                        markdown_title(title)
                    ),
                    None => format!("![{alt}]({})", markdown_destination(&image.url.to_string())),
                };
                source.push_marked(&markdown, marks)
            }
            None => source.push_literal(&inline.text()[range], marks),
        }
    }
    // Markdown drops a paragraph's edge whitespace; leaving it in would shift
    // the content column of a list item.
    source
        .finish()
        .split('\n')
        .map(escape_line_start)
        .collect::<Vec<_>>()
        .join("\n")
}

fn escape_line_start(line: &str) -> String {
    let trimmed = line.trim_start();
    let lead = &line[..line.len() - trimmed.len()];
    let first = trimmed.chars().next();
    if matches!(first, Some('#' | '-' | '+' | '=')) {
        return format!("{lead}\\{trimmed}");
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && matches!(trimmed[digits..].chars().next(), Some('.' | ')')) {
        return format!("{lead}{}\\{}", &trimmed[..digits], &trimmed[digits..]);
    }
    line.to_string()
}

/// The Markdown a custom node round-trips as: its own Markdown when it has
/// one, else its text.
fn custom_markdown(node: &gpui_kit::base::text::MarkdownNode) -> String {
    if node.as_markdown().is_empty() {
        node.as_text().to_string()
    } else {
        node.as_markdown().to_string()
    }
}
