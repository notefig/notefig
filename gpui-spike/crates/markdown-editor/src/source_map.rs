//! Source-preserving serialization (Notefig).
//!
//! Every top-level block imported from Markdown remembers the exact bytes it
//! came from, plus the bytes between it and the block before it. When the
//! document is written back, a block whose content revision has not changed
//! since import re-emits those bytes verbatim; only edited (or new) blocks go
//! through the canonical serializer. Two untouched blocks that were adjacent
//! in the same source keep their original separator, so opening and saving a
//! file never rewrites it.
//!
//! The YAML frontmatter is split off before parsing (Notefig's
//! `splitFrontmatter` rule) and kept as a document-level atom; untouched, it
//! re-emits its raw bytes.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

use super::{document::EditorDocument, id::BlockId};

/// YAML frontmatter: the text between the fences and, while untouched, the
/// exact source bytes (fences and the eaten blank line included).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Frontmatter {
    pub(crate) yaml: String,
    pub(crate) raw: Option<String>,
}

impl Frontmatter {
    pub(crate) fn markdown(&self, body_follows: bool) -> String {
        if let Some(raw) = &self.raw {
            return raw.clone();
        }
        if self.yaml.is_empty() {
            return String::new();
        }
        let mut out = format!("---\n{}\n---\n", self.yaml.trim_end_matches(['\n', '\r']));
        if body_follows {
            out.push('\n');
        }
        out
    }
}

/// Split Notefig frontmatter off the start of `source`: line 0 is `---`
/// (after trimming the end) and a later line is `---`. One blank line after
/// the closing fence belongs to the frontmatter. Returns the frontmatter and
/// the byte length it covers.
pub(crate) fn split_frontmatter(source: &str) -> Option<(Frontmatter, usize)> {
    let first_end = source.find('\n')?;
    if source[..first_end].trim_end() != "---" {
        return None;
    }
    let body_start = first_end + 1;
    let mut line_start = body_start;
    loop {
        let line_end = source[line_start..]
            .find('\n')
            .map_or(source.len(), |ix| line_start + ix);
        let line = &source[line_start..line_end];
        if line.trim_end() == "---" {
            let yaml = source[body_start..line_start]
                .strip_suffix('\n')
                .map(|s| s.strip_suffix('\r').unwrap_or(s))
                .unwrap_or("");
            let mut end = (line_end + 1).min(source.len());
            // Eat one blank line after the closing fence.
            if end < source.len() {
                let next_end = source[end..].find('\n').map(|ix| end + ix);
                if let Some(next_end) = next_end
                    && source[end..next_end].trim().is_empty()
                {
                    end = next_end + 1;
                }
            }
            return Some((
                Frontmatter {
                    yaml: yaml.to_string(),
                    raw: Some(source[..end].to_string()),
                },
                end,
            ));
        }
        if line_end >= source.len() {
            return None;
        }
        line_start = line_end + 1;
    }
}

/// Where an untouched top-level block came from.
#[derive(Clone, Debug)]
pub(crate) struct Origin {
    /// The source generation (one per parse) and the block's index in it.
    pub(crate) generation: u64,
    pub(crate) index: usize,
    /// The last parse index the block covers (more than `index` when
    /// normalization merged following blocks into it).
    pub(crate) last_index: usize,
    pub(crate) source: Arc<str>,
    pub(crate) span: Range<usize>,
    /// The bytes between the previous block of the same parse and this one.
    pub(crate) gap_before: Range<usize>,
    /// The block's content revision when it was recorded.
    pub(crate) revision: u64,
    /// The block's canonical Markdown as recorded, computed lazily just
    /// before the block's first edit (`EditorDocument::prime_canonical`).
    pub(crate) canonical: Option<Arc<str>>,
}

impl Origin {
    pub(crate) fn text(&self) -> &str {
        &self.source[self.span.clone()]
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SourceMap {
    pub(crate) origins: HashMap<BlockId, Origin>,
    /// Trailing empty paragraphs added only as a caret landing spot (the
    /// TipTap `TrailingNode`); they write nothing while untouched.
    pub(crate) synthetic: HashSet<BlockId>,
    /// The parse whose final block's trailing bytes are `trailer`.
    pub(crate) trailer: Option<Trailer>,
    /// The source ended with a line ending, so canonical output keeps one.
    pub(crate) final_newline: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Trailer {
    pub(crate) generation: u64,
    pub(crate) last_index: usize,
    pub(crate) text: String,
}

static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(crate) fn next_generation() -> u64 {
    NEXT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

impl SourceMap {
    pub(crate) fn is_synthetic_untouched(&self, doc: &EditorDocument, id: BlockId) -> bool {
        self.synthetic.contains(&id)
            && doc.inline(id).is_some_and(|inline| inline.is_empty())
    }

}

/// Write the document, re-emitting untouched blocks verbatim.
pub(crate) fn serialize_preserving(doc: &EditorDocument) -> String {
    serialize_layout(doc).text
}

/// The written document plus where each written top-level block landed.
pub(crate) struct Layout {
    pub(crate) text: String,
    /// Written top-level blocks and their byte ranges in `text`.
    pub(crate) ranges: Vec<(BlockId, Range<usize>)>,
    /// Bytes of the frontmatter at the start of `text`.
    pub(crate) frontmatter_len: usize,
}

pub(crate) fn serialize_layout(doc: &EditorDocument) -> Layout {
    with_doc_style(doc, || serialize_layout_inner(doc))
}

fn serialize_layout_inner(doc: &EditorDocument) -> Layout {
    let mut ranges: Vec<(BlockId, Range<usize>)> = Vec::new();
    let map = &doc.source_map;
    let top: Vec<BlockId> = doc
        .children(doc.root)
        .iter()
        .copied()
        .filter(|id| !map.is_synthetic_untouched(doc, *id))
        // An unbound prompt widget is not in the file at all.
        .filter(|id| !doc.prompt_widget(*id).is_some_and(|w| w.task.is_none()))
        .collect();
    let mut body = String::new();
    let mut prev: Option<(u64, usize)> = None;
    let mut all_pristine = true;
    for (ix, id) in top.iter().enumerate() {
        let mut canonical = None;
        let origin = match map.origins.get(id) {
            Some(origin) if doc.block_revision(*id) == origin.revision => Some(origin),
            Some(origin) => {
                let text = super::serialize::block_markdown(doc, *id);
                let same = origin.canonical.as_deref() == Some(text.as_str());
                canonical = Some(text);
                same.then_some(origin)
            }
            None => None,
        };
        let key = origin.map(|o| (o.generation, o.last_index));
        if ix == 0 {
            if let Some(origin) = origin
                && origin.index == 0
            {
                body.push_str(&origin.source[origin.gap_before.clone()]);
            }
        } else {
            match (prev, origin) {
                (Some((generation, index)), Some(origin))
                    if origin.generation == generation && origin.index == index + 1 =>
                {
                    body.push_str(&origin.source[origin.gap_before.clone()])
                }
                _ => body.push_str("\n\n"),
            }
        }
        let start = body.len();
        match origin {
            Some(origin) => body.push_str(origin.text()),
            None => {
                all_pristine = false;
                body.push_str(
                    &canonical.unwrap_or_else(|| super::serialize::block_markdown(doc, *id)),
                );
            }
        }
        ranges.push((*id, start..body.len()));
        prev = key;
    }
    // Trailing bytes: verbatim after the original last block, else one line
    // ending when the source had one.
    let trailer = match (&map.trailer, prev) {
        (Some(trailer), Some((generation, index)))
            if trailer.generation == generation && trailer.last_index == index =>
        {
            Some(trailer.text.as_str())
        }
        (Some(trailer), None) if top.is_empty() => Some(trailer.text.as_str()),
        _ => None,
    };
    match trailer {
        Some(text) => body.push_str(text),
        None => {
            if map.final_newline && !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
        }
    }
    let _ = all_pristine;
    let mut out = String::new();
    if let Some(frontmatter) = &doc.frontmatter {
        out.push_str(&frontmatter.markdown(!body.is_empty()));
    }
    let frontmatter_len = out.len();
    out.push_str(&body);
    for (_, range) in &mut ranges {
        *range = range.start + frontmatter_len..range.end + frontmatter_len;
    }
    Layout {
        text: out,
        ranges,
        frontmatter_len,
    }
}

/// The canonical serializer, ignoring recorded sources (used for copies and
/// by tests that check the canonical form).
#[allow(dead_code)]
pub(crate) fn serialize_canonical(doc: &EditorDocument) -> String {
    super::serialize::serialize(doc)
}

impl PartialEq for SourceMap {
    fn eq(&self, other: &Self) -> bool {
        self.synthetic == other.synthetic
            && self.final_newline == other.final_newline
            && self.trailer.as_ref().map(|t| (t.generation, t.last_index, &t.text))
                == other.trailer.as_ref().map(|t| (t.generation, t.last_index, &t.text))
            && self.origins.len() == other.origins.len()
            && self.origins.iter().all(|(id, origin)| {
                other.origins.get(id).is_some_and(|o| {
                    o.generation == origin.generation
                        && o.index == origin.index
                        && o.revision == origin.revision
                })
            })
    }
}

/// List markers learned from the file: the bullet character and the ordered
/// delimiter (`.` or `)`), so an edited list is written in the file's style.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ListStyle {
    pub(crate) bullet: char,
    pub(crate) delimiter: char,
    /// Emphasis delimiters learned from the file.
    pub(crate) underscore_em: bool,
    pub(crate) underscore_strong: bool,
}

impl Default for ListStyle {
    fn default() -> Self {
        Self {
            bullet: '-',
            delimiter: '.',
            underscore_em: false,
            underscore_strong: false,
        }
    }
}

/// The marker style of a list's source text, if it starts with one.
pub(crate) fn list_style_of(text: &str) -> (Option<char>, Option<char>) {
    let line = text.trim_start();
    match line.chars().next() {
        Some(c @ ('-' | '*' | '+')) => (Some(c), None),
        Some(c) if c.is_ascii_digit() => {
            let rest = line.trim_start_matches(|c: char| c.is_ascii_digit());
            (None, rest.chars().next().filter(|c| matches!(c, '.' | ')')))
        }
        _ => (None, None),
    }
}

impl EditorDocument {
    /// `(bullet, ordered delimiter)` for writing list `id`: its own source's
    /// markers when it has one, else the file's.
    pub(crate) fn list_style(&self, id: BlockId) -> (char, char) {
        if NEUTRAL_STYLE.with(|n| n.get()) {
            return ('-', '.');
        }
        let base = self.list_style;
        let own = self
            .source_map
            .origins
            .get(&id)
            .map(|o| list_style_of(o.text()))
            .unwrap_or((None, None));
        (own.0.unwrap_or(base.bullet), own.1.unwrap_or(base.delimiter))
    }
}

thread_local! {
    static NEUTRAL_STYLE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Emphasis delimiters of the document being written: (`_em_`, `__strong__`).
    static EMPHASIS: std::cell::Cell<(bool, bool)> = const { std::cell::Cell::new((false, false)) };
}

/// Run `f` with style-neutral markers (for content comparisons).
pub(crate) fn with_neutral_style<T>(f: impl FnOnce() -> T) -> T {
    let prev = NEUTRAL_STYLE.with(|n| n.replace(true));
    let emphasis = EMPHASIS.with(|e| e.replace((false, false)));
    let out = f();
    NEUTRAL_STYLE.with(|n| n.set(prev));
    EMPHASIS.with(|e| e.set(emphasis));
    out
}

/// Run `f` writing emphasis in `doc`'s learned style.
pub(crate) fn with_doc_style<T>(doc: &EditorDocument, f: impl FnOnce() -> T) -> T {
    if NEUTRAL_STYLE.with(|n| n.get()) {
        return f();
    }
    let prev = EMPHASIS.with(|e| e.replace((doc.list_style.underscore_em, doc.list_style.underscore_strong)));
    let out = f();
    EMPHASIS.with(|e| e.set(prev));
    out
}

/// The emphasis style in effect for the serializer.
pub(crate) fn emphasis_style() -> (bool, bool) {
    EMPHASIS.with(|e| e.get())
}

/// Learn the emphasis delimiters a file prefers: underscores when `_x_`
/// (or `__x__`) openers outnumber `*x*` (`**x**`) ones, outside code fences.
pub(crate) fn learn_emphasis(source: &str) -> (bool, bool) {
    let (mut em_us, mut em_star, mut st_us, mut st_star) = (0, 0, 0, 0);
    let mut fenced = false;
    for line in source.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || line.starts_with("    ") {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c != '_' && c != '*' {
                i += 1;
                continue;
            }
            let run = chars[i..].iter().take_while(|x| **x == c).count();
            let before = i.checked_sub(1).map(|j| chars[j]);
            let after = chars.get(i + run).copied();
            let opens = after.is_some_and(|a| !a.is_whitespace())
                && before.is_none_or(|b| !b.is_alphanumeric() && b != '\\');
            if opens {
                match (c, run) {
                    ('_', 1) => em_us += 1,
                    ('_', 2) => st_us += 1,
                    ('*', 1) => em_star += 1,
                    ('*', 2) => st_star += 1,
                    _ => {}
                }
            }
            i += run;
        }
    }
    (em_us > em_star, st_us > st_star)
}

/// How a table is written: learned from its own source when it has one.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TableStyle {
    pub(crate) outer_pipes: bool,
    pub(crate) spaced: bool,
    /// Cells padded to the column width.
    pub(crate) aligned: bool,
    /// The original delimiter row and the alignments it encodes.
    pub(crate) delimiter: Option<(Vec<gpui_kit::base::text::editor_host::ColumnAlign>, String)>,
}

impl Default for TableStyle {
    fn default() -> Self {
        Self {
            outer_pipes: true,
            spaced: true,
            aligned: false,
            delimiter: None,
        }
    }
}

pub(crate) fn table_style_of(doc: &EditorDocument, id: BlockId) -> TableStyle {
    if NEUTRAL_STYLE.with(|n| n.get()) {
        return TableStyle::default();
    }
    let Some(origin) = doc.source_map.origins.get(&id) else {
        return TableStyle::default();
    };
    let lines: Vec<&str> = origin.text().lines().collect();
    let (Some(header), Some(delimiter)) = (lines.first(), lines.get(1)) else {
        return TableStyle::default();
    };
    let header = header.trim();
    let outer_pipes = header.starts_with('|');
    let spaced = header.contains("| ") || header.contains(" |");
    let widths = |line: &str| -> Vec<usize> {
        line.trim()
            .trim_matches('|')
            .split('|')
            .map(|c| c.chars().count())
            .collect()
    };
    let first = widths(header);
    let aligned = lines.len() > 2 && lines.iter().all(|l| widths(l) == first);
    use gpui_kit::base::text::editor_host::ColumnAlign;
    // The alignments the original delimiter row encodes.
    let aligns = delimiter
        .trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| {
            let cell = cell.trim();
            match (cell.starts_with(':'), cell.ends_with(':')) {
                (true, true) => ColumnAlign::Center,
                (true, false) => ColumnAlign::Left,
                (false, true) => ColumnAlign::Right,
                (false, false) => ColumnAlign::None,
            }
        })
        .collect();
    TableStyle {
        outer_pipes,
        spaced,
        aligned,
        delimiter: Some((aligns, delimiter.trim_end().to_string())),
    }
}

impl EditorDocument {
    /// Before a step changes the content under `id`, record the canonical
    /// form of its top-level block while it still matches its source.
    pub(crate) fn prime_canonical(&mut self, id: BlockId) {
        let root = self.root;
        let mut top = id;
        while let Some(parent) = self.parent(top) {
            if parent == root {
                break;
            }
            top = parent;
        }
        if top == root {
            return;
        }
        let needs = self
            .source_map
            .origins
            .get(&top)
            .is_some_and(|o| o.canonical.is_none() && o.revision == self.block_revision(top));
        if needs {
            let text: Arc<str> =
                with_doc_style(self, || super::serialize::block_markdown(self, top)).into();
            if let Some(origin) = self.source_map.origins.get_mut(&top) {
                origin.canonical = Some(text);
            }
        }
    }
}
