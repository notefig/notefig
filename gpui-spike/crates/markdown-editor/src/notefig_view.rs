//! Notefig on the entity: node views for prompt widgets, the `/` trigger,
//! external merges with events, change gutter, diff-line and search
//! backgrounds, placeholder, image base directory, and the extra shortcuts
//! from spec §1.3/§1.4.

use std::{cell::RefCell, collections::HashMap, ops::Range, path::PathBuf, rc::Rc};

use gpui::{
    AnyElement, App, Bounds, Context, Hsla, KeyBinding, Pixels, SharedString, WeakEntity, Window,
    actions,
};

use super::{
    command::{CommandError, EditorCommand},
    id::BlockId,
    kind::{BlockKind, BlockKindData},
    marks::MarkKind,
    merge::MergeSummary,
    notefig::{PromptWidget, WidgetPlacement},
    position::BlockPosition,
    selection::BlockSelection,
    state::{BlockEditorEvent, BlockEditorState},
    tracking::{RoundId, TrackedChange},
    transaction::EditOrigin,
};

actions!(
    block_editor,
    [
        ToggleUnderline,
        ToggleStrikethrough,
        ToggleHighlight,
        ToggleSubscript,
        ToggleSuperscript,
        ToggleHeading1,
        ToggleHeading2,
        ToggleHeading3,
        ToggleHeading4,
        ToggleHeading5,
        ToggleHeading6,
        ToggleBulletList,
        ToggleOrderedList,
        ToggleTaskList,
        ToggleBlockquote,
        ToggleCodeBlock,
    ]
);

pub(crate) fn init(cx: &mut App) {
    let ctx = Some(super::state::CONTEXT);
    #[cfg(target_os = "macos")]
    let m = "cmd";
    #[cfg(not(target_os = "macos"))]
    let m = "ctrl";
    cx.bind_keys(vec![
        KeyBinding::new(&format!("{m}-u"), ToggleUnderline, ctx),
        KeyBinding::new(&format!("{m}-shift-s"), ToggleStrikethrough, ctx),
        KeyBinding::new(&format!("{m}-shift-x"), ToggleStrikethrough, ctx),
        KeyBinding::new(&format!("{m}-shift-h"), ToggleHighlight, ctx),
        KeyBinding::new(&format!("{m}-,"), ToggleSubscript, ctx),
        KeyBinding::new(&format!("{m}-."), ToggleSuperscript, ctx),
        KeyBinding::new(&format!("{m}-alt-1"), ToggleHeading1, ctx),
        KeyBinding::new(&format!("{m}-alt-2"), ToggleHeading2, ctx),
        KeyBinding::new(&format!("{m}-alt-3"), ToggleHeading3, ctx),
        KeyBinding::new(&format!("{m}-alt-4"), ToggleHeading4, ctx),
        KeyBinding::new(&format!("{m}-alt-5"), ToggleHeading5, ctx),
        KeyBinding::new(&format!("{m}-alt-6"), ToggleHeading6, ctx),
        KeyBinding::new(&format!("{m}-shift-8"), ToggleBulletList, ctx),
        KeyBinding::new(&format!("{m}-shift-7"), ToggleOrderedList, ctx),
        KeyBinding::new(&format!("{m}-shift-9"), ToggleTaskList, ctx),
        KeyBinding::new(&format!("{m}-shift-b"), ToggleBlockquote, ctx),
        KeyBinding::new(&format!("{m}-alt-c"), ToggleCodeBlock, ctx),
    ]);
}

/// What the app's node view gets to render a prompt widget block.
#[derive(Clone)]
pub struct NodeViewCtx {
    /// The widget's block (stable across edits and merges).
    pub block: BlockId,
    pub widget: PromptWidget,
    /// The editor's caret or selection is on the widget block.
    pub selected: bool,
    /// The editor itself has focus (not an input inside the widget).
    pub editor_focused: bool,
    pub editor: WeakEntity<BlockEditorState>,
}

/// Renders a prompt widget block. The returned element is laid out as the
/// block (its height is measured like any block) and may contain focusable
/// entities of the app (the prompt draft input); the editor does not handle
/// mouse or key events that land inside it.
pub type NodeViewRenderer = Rc<dyn Fn(&NodeViewCtx, &mut Window, &mut App) -> AnyElement>;

/// Per-editor Notefig view state.
pub(crate) struct NotefigView {
    pub(crate) node_view: Option<NodeViewRenderer>,
    /// Laid-out node views of the last frame (window coordinates).
    pub(crate) node_view_bounds: Rc<RefCell<Vec<(BlockId, Bounds<Pixels>)>>>,
    pub(crate) slash_trigger: bool,
    pub(crate) search: Vec<(BlockId, Range<usize>)>,
    pub(crate) search_active: Option<usize>,
    /// Change navigator position per round, and the bar pulsing now.
    pub(crate) nav: HashMap<RoundId, usize>,
    pub(crate) pulse: Option<(BlockId, std::time::Instant)>,
    pub(crate) diff_cards: bool,
    pub(crate) asset_target: Option<Rc<dyn Fn() -> Option<ImageAssetTarget>>>,
    pub(crate) properties: Option<super::notefig_ui::PropertiesPanel>,
    pub(crate) properties_chip: bool,
    pub(crate) language_picker: Option<super::notefig_ui::LanguagePicker>,
    pub(crate) language_picker_enabled: bool,
    /// Editor-owned overlays of the last frame (picker): clicks there are
    /// theirs.
    pub(crate) overlay_bounds: Rc<RefCell<Vec<Bounds<Pixels>>>>,
    pub(crate) loading: bool,
    /// While an async load parses: the full text being loaded (what
    /// `source()` reports) and the load's generation, so a superseded parse
    /// is discarded instead of swapped in.
    pub(crate) loading_source: Option<String>,
    pub(crate) loading_readonly: bool,
    pub(crate) load_generation: u64,
    /// Tests: skip the test-only accessible value (an O(document) string
    /// per revision) when measuring what the app pays.
    pub(crate) perf_no_a11y: bool,
    pub(crate) gutter: Option<(RoundId, Hsla)>,
    pub(crate) image_base: Option<PathBuf>,
    pub(crate) placeholder: Option<SharedString>,
    /// Muted text drawn at the caret, not part of the document (dictation's
    /// words so far, TS's ghost decoration).
    pub(crate) ghost: Option<SharedString>,
    /// A block `reveal_block` asked to bring into view, centred, once laid out.
    pub(crate) reveal_block: std::cell::Cell<Option<BlockId>>,
    /// The host's document typography (`set_prose_style`).
    pub(crate) prose: Option<ProseStyle>,
    /// Minimap entries per revision.
    pub(crate) minimap_cache: RefCell<Option<(u64, Rc<Vec<super::minimap::MinimapEntry>>)>>,
    /// Diff-line backgrounds per revision.
    pub(crate) diff_cache: RefCell<Option<(u64, Rc<HashMap<u64, Vec<(Range<usize>, Hsla)>>>)>>,
}

impl Default for NotefigView {
    fn default() -> Self {
        Self {
            node_view: None,
            node_view_bounds: Rc::default(),
            slash_trigger: true,
            search: Vec::new(),
            search_active: None,
            nav: HashMap::new(),
            pulse: None,
            diff_cards: true,
            asset_target: None,
            properties: None,
            properties_chip: true,
            language_picker: None,
            language_picker_enabled: true,
            overlay_bounds: Rc::default(),
            loading: false,
            loading_source: None,
            loading_readonly: false,
            load_generation: 0,
            perf_no_a11y: false,
            gutter: None,
            image_base: None,
            placeholder: Some("Type something, or press / for AI…".into()),
            ghost: None,
            reveal_block: Default::default(),
            prose: None,
            minimap_cache: RefCell::new(None),
            diff_cache: RefCell::default(),
        }
    }
}

/// A blockquote as the host draws it (the renderer's own is a 2px muted bar).
#[derive(Clone, Debug, PartialEq)]
pub struct QuoteStyle {
    pub bar_width: Pixels,
    pub bar_color: Hsla,
    /// Between the bar and the text.
    pub padding: Pixels,
    pub text_color: Hsla,
    pub italic: bool,
    pub font_weight: gpui::FontWeight,
    /// Wrap the quote in “ ” (CSS `quotes`), drawn outside the text.
    pub curly_quotes: bool,
    /// Added above and below the quote, beyond the block gap the
    /// renderer's blocks already leave.
    pub margin: Pixels,
}

/// A task item's checkbox (the TS app's native `<input type=checkbox>`).
#[derive(Clone, Debug, PartialEq)]
pub struct CheckboxStyle {
    pub size: Pixels,
    pub radius: Pixels,
    /// Between the checkbox and the item's text.
    pub gap: Pixels,
    pub fill: Hsla,
    pub border: Hsla,
    pub checked_fill: Hsla,
    pub check: Hsla,
}

/// Lists as the host draws them (the renderer's own hang a muted marker in a
/// 1.4em column, always on the left). Each item takes its direction from its
/// text (CSS `dir="auto"`), so a right-to-left item keeps its marker on the
/// right.
#[derive(Clone, Debug, PartialEq)]
pub struct ListStyle {
    /// From a list's start edge to its items' text (CSS `ul` plus `li`
    /// `padding-inline-start`). A nested list starts at its item's text.
    pub indent: Pixels,
    /// The item's own start padding: an outside marker ends this far (plus
    /// its gap) before the text.
    pub item_padding: Pixels,
    pub bullet_color: Hsla,
    /// The disc's diameter.
    pub bullet_size: Pixels,
    /// From the disc's end to the item's edge.
    pub bullet_gap: Pixels,
    /// An ordered item's number (`--tw-prose-counters`).
    pub number_color: Hsla,
    /// From the number's end to the item's edge (the marker's trailing space).
    pub number_gap: Pixels,
    /// From a task list's start edge to its checkboxes (no marker column).
    pub task_indent: Pixels,
    pub checkbox: CheckboxStyle,
}

/// Document typography a host sets over the renderer's defaults: the
/// renderer's own style (sizes, gaps, headings, code blocks), how lists and
/// blockquotes look.
#[derive(Clone)]
pub struct ProseStyle {
    pub text: Option<gpui_kit::base::text::TextViewStyle>,
    /// How lists are drawn.
    pub list: ListStyle,
    /// Space list items a full block gap apart, as paragraphs are (CSS
    /// prose: each item's `<p>` carries the paragraph margins). The
    /// renderer's own items sit a quarter line apart, as task items stay
    /// (`taskList` items drop their paragraphs' margins).
    pub list_items_spaced: bool,
    /// A top-level rule's room below (the room above is the previous
    /// block's own gap); `None` keeps the renderer's.
    pub rule_below: Option<Pixels>,
    /// Extra room above a top-level list that follows an h3 or smaller.
    pub list_top_after_heading: Pixels,
    pub quote: Option<QuoteStyle>,
    /// Right-to-left document (`dir="rtl"`): quotes keep their bar on the
    /// right.
    pub rtl: bool,
}

/// How long a revealed change's bar pulses.
pub(crate) const PULSE: std::time::Duration = std::time::Duration::from_millis(900);

pub(crate) fn diff_added() -> Hsla {
    gpui::hsla(130. / 360., 0.55, 0.45, 0.18)
}
pub(crate) fn diff_removed() -> Hsla {
    gpui::hsla(0., 0.7, 0.55, 0.18)
}
pub(crate) fn search_color(active: bool) -> Hsla {
    if active {
        gpui::hsla(35. / 360., 0.95, 0.55, 0.55)
    } else {
        gpui::hsla(50. / 360., 0.95, 0.6, 0.35)
    }
}

impl BlockEditorState {
    // ---- node views ---------------------------------------------------------

    /// Render prompt-widget blocks with the app's element.
    pub fn set_node_view_renderer(
        &mut self,
        renderer: impl Fn(&NodeViewCtx, &mut Window, &mut App) -> AnyElement + 'static,
        cx: &mut Context<Self>,
    ) {
        self.notefig.node_view = Some(Rc::new(renderer));
        cx.notify();
    }

    /// Where each prompt widget was laid out in the last frame (window
    /// coordinates): for scrolling to a widget and anchoring popovers.
    pub fn node_view_bounds(&self) -> Vec<(BlockId, Bounds<Pixels>)> {
        self.notefig.node_view_bounds.borrow().clone()
    }

    pub(crate) fn node_view_at(&self, at: gpui::Point<Pixels>) -> bool {
        self.notefig.overlay_bounds.borrow().iter().any(|b| b.contains(&at))
            || self.notefig
            .node_view_bounds
            .borrow()
            .iter()
            .any(|(_, b)| b.contains(&at))
    }

    /// Turn the `/` trigger on or off (on by default).
    pub fn set_slash_trigger(&mut self, on: bool) {
        self.notefig.slash_trigger = on;
    }

    /// After text input: `/` typed into an otherwise empty paragraph at the
    /// top level or in a list emits [`BlockEditorEvent::SlashTrigger`].
    pub(crate) fn check_slash_trigger(&mut self, text: &str, cx: &mut Context<Self>) {
        if !self.notefig.slash_trigger || text != "/" {
            return;
        }
        let Some(caret) = self.model.caret() else {
            return;
        };
        let doc = &self.model.doc;
        if !matches!(doc.kind(caret.block), Some(BlockKindData::Paragraph))
            || doc.inline(caret.block).map(|i| i.text()) != Some("/")
        {
            return;
        }
        let path = doc.path(caret.block);
        let allowed = path[1..path.len() - 1].iter().all(|id| {
            matches!(
                doc.kind(*id),
                Some(BlockKindData::List { .. } | BlockKindData::ListItem { .. })
            )
        });
        if allowed {
            cx.emit(BlockEditorEvent::SlashTrigger {
                block: caret.block,
                position: caret,
            });
        }
    }

    /// Insert a prompt widget (the app's answer to `SlashTrigger`). One undo
    /// step; emits `Changed`.
    pub fn insert_prompt_widget(
        &mut self,
        widget: PromptWidget,
        placement: WidgetPlacement,
        cx: &mut Context<Self>,
    ) -> Result<BlockId, CommandError> {
        self.end_composition_pub();
        let block = self.model.insert_prompt_widget(widget, placement)?;
        self.after_edit_pub(EditOrigin::Command("insert-prompt"), cx);
        Ok(block)
    }

    /// Rebind a widget (its marker on disk follows).
    pub fn set_prompt_widget(
        &mut self,
        block: BlockId,
        widget: PromptWidget,
        cx: &mut Context<Self>,
    ) -> Result<bool, CommandError> {
        let changed = self.model.set_prompt_widget(block, widget)?;
        if changed {
            self.after_edit_pub(EditOrigin::Command("set-prompt"), cx);
        }
        Ok(changed)
    }

    /// Remove a widget, optionally turning it into a paragraph holding
    /// `text` (Esc on a summoned widget: `Some("/")`).
    pub fn remove_prompt_widget(
        &mut self,
        block: BlockId,
        text: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Result<bool, CommandError> {
        let changed = self.model.remove_prompt_widget(block, text)?;
        if changed {
            self.after_edit_pub(EditOrigin::Command("remove-prompt"), cx);
        }
        Ok(changed)
    }

    /// The selection summon (TS `selectionSummonTr`): with the `/` trigger
    /// on and a non-blank text selection, insert a fresh widget carrying the
    /// selection as its reference and emit `SelectionSummoned`. Returns
    /// whether it did (otherwise the `/` types as usual).
    pub(crate) fn summon_on_selection(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.notefig.slash_trigger || self.model.selection_reference().is_none() {
            return false;
        }
        self.end_composition_pub();
        let id = super::notefig::new_prompt_widget_id();
        let Ok(Some(block)) = self.model.summon_on_selection(id) else {
            return false;
        };
        self.after_edit_pub(EditOrigin::Command("insert-prompt"), cx);
        if let (Some(widget), Some(reference)) =
            (self.model.prompt_widget(block), self.model.widget_reference(block).cloned())
        {
            cx.emit(BlockEditorEvent::SelectionSummoned { block, widget, reference });
        }
        true
    }

    /// What a selection summon would refer to now (the toolbar's "Ask AI"
    /// on a selection can call `summon_selection` with it).
    pub fn selection_reference(&self) -> Option<super::notefig::PromptReference> {
        self.model.selection_reference()
    }

    /// Summon a widget on the selection without typing `/` (a menu or
    /// shortcut). Emits `SelectionSummoned`; `None` when nothing is selected.
    pub fn summon_selection(&mut self, cx: &mut Context<Self>) -> Option<BlockId> {
        if self.is_readonly() {
            return None;
        }
        let id = super::notefig::new_prompt_widget_id();
        let block = self.model.summon_on_selection(id).ok().flatten()?;
        self.after_edit_pub(EditOrigin::Command("insert-prompt"), cx);
        if let (Some(widget), Some(reference)) =
            (self.model.prompt_widget(block), self.model.widget_reference(block).cloned())
        {
            cx.emit(BlockEditorEvent::SelectionSummoned { block, widget, reference });
        }
        Some(block)
    }

    /// The deletion veto: `keep(widget)` true means the widget can't be
    /// removed now (its agent is working). An edit that removes one still
    /// applies, the widget is put back where it was, and
    /// `WidgetRemovalRefused` is emitted. `remove_prompt_widget` is never
    /// vetoed. Re-evaluated on every edit, so `keep` reads live state.
    pub fn set_widget_removal_guard(
        &mut self,
        keep: Option<super::notefig::WidgetRemovalGuard>,
    ) {
        self.model.set_widget_removal_guard(keep);
    }

    /// Put the caret on the paragraph after a widget and focus the editor
    /// (the widget's input hands focus back, e.g. on Escape or ArrowDown).
    pub fn focus_after_widget(&mut self, block: BlockId, window: &mut Window, cx: &mut Context<Self>) {
        let doc = &self.model.doc;
        if let Some((parent, index)) = doc.index_in_parent(block)
            && let Some(next) = doc.children(parent).get(index + 1).copied()
        {
            let pos = doc.first_leaf_in(next);
            let _ = self.set_selection(BlockSelection::caret(pos), cx);
        }
        self.focus(window, cx);
    }

    /// Insert an `@path` mention chip at the selection (written as `@path`).
    pub fn insert_mention(&mut self, path: &str, cx: &mut Context<Self>) -> Result<(), CommandError> {
        if self.is_readonly() {
            return Ok(());
        }
        self.end_composition_pub();
        self.model.insert_mention(path)?;
        self.after_edit_pub(EditOrigin::Command("mention"), cx);
        Ok(())
    }

    /// Keep an empty landing paragraph after a final code block, table,
    /// rule or widget (on by default; TipTap's TrailingNode). It writes
    /// nothing to the file while empty.
    pub fn set_trailing_paragraph(&mut self, on: bool, cx: &mut Context<Self>) {
        self.model.set_trailing_paragraph(on);
        cx.notify();
    }

    // ---- frontmatter --------------------------------------------------------

    pub fn frontmatter(&self) -> Option<&str> {
        self.model.frontmatter()
    }

    /// Replace the frontmatter YAML (`None` removes it); one undo step.
    pub fn set_frontmatter(
        &mut self,
        yaml: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Result<bool, CommandError> {
        let changed = self.model.set_frontmatter(yaml)?;
        if changed {
            self.after_edit_pub(EditOrigin::Command("frontmatter"), cx);
        }
        Ok(changed)
    }

    // ---- external content -------------------------------------------------------

    /// Merge new file content (a disk change or an agent write) as one
    /// undoable transaction. Emits `Changed { origin }` with the given
    /// (external) origin, which autosave should skip. Ends an IME
    /// composition first.
    pub fn apply_external_source(
        &mut self,
        source: &str,
        origin: EditOrigin,
        cx: &mut Context<Self>,
    ) -> Result<MergeSummary, SharedString> {
        // Mid-load there is nothing to merge into yet: load the new text
        // instead (the pending parse is superseded).
        if self.notefig.loading {
            self.set_source_async(source.to_string(), cx).detach();
            return Ok(MergeSummary::default());
        }
        self.end_composition_pub();
        self.model.break_coalescing();
        let summary = self.model.apply_external_source(source, origin)?;
        self.model.break_coalescing();
        if summary.changed {
            self.after_edit_pub(origin, cx);
        }
        Ok(summary)
    }

    /// Insert text (Markdown blocks when multi-line) at a PM position as an
    /// agent or API edit. Emits `Changed { origin }`.
    pub fn insert_at(
        &mut self,
        pos: usize,
        text: &str,
        origin: EditOrigin,
        cx: &mut Context<Self>,
    ) -> Result<(), CommandError> {
        self.replace_range(pos, pos, text, origin, cx)
    }

    /// Replace a PM range with text. Emits `Changed { origin }`.
    pub fn replace_range(
        &mut self,
        from: usize,
        to: usize,
        text: &str,
        origin: EditOrigin,
        cx: &mut Context<Self>,
    ) -> Result<(), CommandError> {
        self.end_composition_pub();
        let revision = self.model.revision();
        self.model.replace_range(from, to, text, origin)?;
        if self.model.revision() != revision {
            self.after_edit_pub(origin, cx);
        }
        Ok(())
    }

    // ---- change tracking ----------------------------------------------------------

    pub fn track_changes(&mut self, round: RoundId) {
        self.model.track_changes(round);
    }

    pub fn untrack_changes(&mut self, round: RoundId, cx: &mut Context<Self>) {
        self.model.untrack_changes(round);
        cx.notify();
    }

    pub fn tracked_changes(&self, round: RoundId) -> Vec<TrackedChange> {
        self.model.tracked_changes(round)
    }

    /// Draw gutter bars (in `color`) beside the blocks `round` changed;
    /// `None` hides them. Only one round is shown at a time (the widget under
    /// review).
    pub fn set_change_gutter(&mut self, gutter: Option<(RoundId, Hsla)>, cx: &mut Context<Self>) {
        self.notefig.gutter = gutter;
        cx.notify();
    }

    /// Gutter bars of the last frame: `(block, bar bounds)` in window
    /// coordinates.
    pub fn change_gutter_bars(&self) -> Vec<(BlockId, Bounds<Pixels>)> {
        let Some((round, _)) = self.notefig.gutter else {
            return Vec::new();
        };
        let changed = self.model.changed_blocks(round);
        if changed.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<(BlockId, Bounds<Pixels>)> = self
            .top_level_bounds()
            .into_iter()
            .filter(|(_, id, _)| changed.contains(id))
            .map(|(_, id, b)| (id, b))
            .collect();
        for (id, b) in self.notefig.node_view_bounds.borrow().iter() {
            if changed.contains(id) && !out.iter().any(|(o, _)| o == id) {
                out.push((*id, *b));
            }
        }
        let pulsing = self
            .notefig
            .pulse
            .filter(|(_, at)| at.elapsed() < PULSE)
            .map(|(id, _)| id);
        let mut bars: Vec<(BlockId, Bounds<Pixels>)> = out
            .into_iter()
            .map(|(id, b)| {
                let width = if pulsing == Some(id) { gpui::px(5.) } else { gpui::px(3.) };
                (
                    id,
                    Bounds::new(
                        gpui::point(b.left() - gpui::px(7.), b.top()),
                        gpui::size(width, b.size.height),
                    ),
                )
            })
            .collect();
        // Pure deletions: a short tick at the line where text was removed.
        let frame = self.frame.borrow();
        for change in self.model.tracked_changes(round) {
            if !change.range.is_empty() {
                continue;
            }
            let pos = BlockPosition::new(change.block, change.range.start);
            if let Some(caret) = frame.caret_bounds(pos, gpui::px(1.))
                && let Some(top) = self.model.doc.path(change.block).get(1).copied()
                && let Some((_, bar)) = bars.iter().find(|(id, _)| *id == top).cloned()
            {
                bars.push((
                    top,
                    Bounds::new(
                        gpui::point(bar.left() - gpui::px(3.), caret.top()),
                        gpui::size(gpui::px(9.), gpui::px(2.)),
                    ),
                ));
            }
        }
        bars
    }

    /// Number of change stops (changed blocks) of `round`.
    pub fn change_count(&self, round: RoundId) -> usize {
        self.model.change_stops(round).len()
    }

    /// The navigator's position for `round` (0-based), `None` before the
    /// first step.
    pub fn change_index(&self, round: RoundId) -> Option<usize> {
        let count = self.change_count(round);
        self.notefig
            .nav
            .get(&round)
            .copied()
            .filter(|_| count > 0)
            .map(|i| i.min(count - 1))
    }

    /// Step to the next (`forward`) or previous change of `round`, wrapping
    /// (the TS change navigator's `step`): the caret moves to the change,
    /// which scrolls it into view, the gutter shows `round`, and the bar
    /// pulses. Returns the new index.
    pub fn step_change(&mut self, round: RoundId, forward: bool, cx: &mut Context<Self>) -> Option<usize> {
        let stops = self.model.change_stops(round);
        if stops.is_empty() {
            return None;
        }
        let n = stops.len();
        let next = match self.change_index(round) {
            None => if forward { 0 } else { n - 1 },
            Some(i) => if forward { (i + 1) % n } else { (i + n - 1) % n },
        };
        self.notefig.nav.insert(round, next);
        if self.notefig.gutter.map(|(r, _)| r) != Some(round) {
            let color = self.notefig.gutter.map(|(_, c)| c).unwrap_or_else(|| gpui::hsla(0.75, 0.6, 0.6, 0.9));
            self.notefig.gutter = Some((round, color));
        }
        let (block, pos) = stops[next];
        let _ = self.set_selection(BlockSelection::caret(pos), cx);
        self.notefig.pulse = Some((block, std::time::Instant::now()));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PULSE).await;
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
        cx.notify();
        Some(next)
    }

    // ---- search --------------------------------------------------------------------

    /// Highlight every match of `query` (case-insensitive unless
    /// `case_sensitive`) and return how many there are. An empty query
    /// clears the highlights.
    pub fn set_search(&mut self, query: &str, case_sensitive: bool, cx: &mut Context<Self>) -> usize {
        self.notefig.search = self.model.find_all(query, case_sensitive);
        self.notefig.search_active = None;
        cx.notify();
        self.notefig.search.len()
    }

    /// Select match `index` (painted as the active one) and scroll to it.
    pub fn select_search_match(&mut self, index: usize, cx: &mut Context<Self>) -> bool {
        let Some((block, range)) = self.notefig.search.get(index).cloned() else {
            return false;
        };
        self.notefig.search_active = Some(index);
        let selection = BlockSelection::Text {
            anchor: BlockPosition::new(block, range.start),
            head: BlockPosition::new(block, range.end),
        };
        self.set_selection(selection, cx).is_ok()
    }

    pub fn search_matches(&self) -> &[(BlockId, Range<usize>)] {
        &self.notefig.search
    }

    // ---- presentation --------------------------------------------------------------

    /// Resolve relative image paths against this directory (the document's
    /// folder). Absolute paths and URLs are used as they are.
    pub fn set_image_base_dir(&mut self, dir: Option<PathBuf>, cx: &mut Context<Self>) {
        self.notefig.image_base = dir;
        cx.notify();
    }

    /// The text shown in an empty document and in the empty paragraph
    /// holding the caret; `None` hides it.
    pub fn set_placeholder(&mut self, text: Option<SharedString>, cx: &mut Context<Self>) {
        self.notefig.placeholder = text;
        cx.notify();
    }

    /// Select `block` and scroll it to the middle of the view once it is
    /// laid out (TS: a jump to a widget, `scrollIntoView({ block: "center" })`).
    /// Selecting pins the block, so a culled one is laid out next frame.
    pub fn reveal_block(&mut self, block: BlockId, cx: &mut Context<Self>) -> bool {
        if self.model.doc.get(block).is_none() {
            return false;
        }
        let _ = self.set_selection(BlockSelection::Blocks { anchor: block, head: block }, cx);
        self.notefig.reveal_block.set(Some(block));
        cx.notify();
        true
    }

    /// Where `block` was laid out in the last frame (window coordinates):
    /// a node view's bounds, or its first text leaf's line.
    pub(crate) fn laid_out_bounds(&self, block: BlockId) -> Option<Bounds<Pixels>> {
        if let Some((_, b)) = self.notefig.node_view_bounds.borrow().iter().find(|(id, _)| *id == block) {
            return Some(*b);
        }
        let leaf = self.model.doc.first_leaf_in(block).block;
        let frame = self.frame.borrow();
        let leaf = frame.leaf(leaf)?;
        let top = leaf.caret_point(0);
        Some(Bounds::new(top, gpui::size(gpui::px(1.), leaf.line_height())))
    }

    /// The host's typography over the renderer's defaults; `None` restores
    /// them.
    pub fn set_prose_style(&mut self, prose: Option<ProseStyle>, cx: &mut Context<Self>) {
        self.notefig.prose = prose;
        self.projection_dirty_for_style();
        cx.notify();
    }

    /// Block heights measured under the old style no longer hold.
    fn projection_dirty_for_style(&mut self) {
        let mut cull = self.cull.borrow_mut();
        cull.heights.clear();
        cull.index.revision = None;
        cull.visible = None;
        cull.measured.clear();
    }

    /// Where each top-level blockquote's text ends, from the last frame (its
    /// closing quote mark goes there), relative to the content origin.
    pub(crate) fn quote_ends(&self) -> Vec<gpui::Point<Pixels>> {
        let doc = &self.model.doc;
        let frame = self.frame.borrow();
        let Some(content) = frame.content else { return Vec::new() };
        doc.children(doc.root)
            .iter()
            .filter(|id| matches!(doc.kind(**id), Some(BlockKindData::Blockquote)))
            .filter_map(|quote| {
                let mut at = *quote;
                while let Some(last) = doc.children(at).last() {
                    at = *last;
                }
                let len = doc.leaf_len(at)?;
                let leaf = frame.leaf(at)?;
                Some(leaf.caret_point(len) - content.origin)
            })
            .collect()
    }

    /// Draw `text` muted at the caret without touching the document (the
    /// dictation's words so far); `None` removes it.
    pub fn set_ghost_text(&mut self, text: Option<SharedString>, cx: &mut Context<Self>) {
        if self.notefig.ghost != text {
            self.notefig.ghost = text;
            cx.notify();
        }
    }

    pub fn ghost_text(&self) -> Option<&SharedString> {
        self.notefig.ghost.as_ref()
    }

    /// The caret's top-left in the editor's own coordinates (relative to
    /// its content origin), from the last frame: where a host anchors a
    /// popover at the caret (the link bubble).
    pub fn caret_origin(&self) -> Option<gpui::Point<Pixels>> {
        let caret = self.model.caret()?;
        let frame = self.frame.borrow();
        let content = frame.content?;
        let leaf = frame.leaf(caret.block)?;
        Some(leaf.caret_point(caret.offset) - content.origin)
    }

    /// The text of the caret's leaf after the caret (dictation fits its
    /// text against what follows, as against `caret_prefix`).
    pub fn caret_suffix(&self) -> Option<&str> {
        self.model.caret_suffix()
    }

    /// The backgrounds the view paints besides the selection: diff lines in
    /// diff fences and search matches.
    pub(crate) fn notefig_backgrounds(&self) -> Vec<(BlockId, Range<usize>, Hsla)> {
        let mut out = Vec::new();
        let revision = self.model.revision();
        let cached = self.notefig.diff_cache.borrow().clone();
        let diff = match cached {
            Some((rev, map)) if rev == revision => map,
            _ => {
                let mut map: HashMap<u64, Vec<(Range<usize>, Hsla)>> = HashMap::new();
                let doc = &self.model.doc;
                for id in doc.leaves() {
                    let Some(BlockKindData::CodeBlock { lang, meta }) = doc.kind(*id) else {
                        continue;
                    };
                    if !super::notefig::is_diff_fence(lang.as_deref(), meta.as_deref()) {
                        continue;
                    }
                    let Some(code) = doc.plain(*id) else { continue };
                    let mut start = 0;
                    for line in code.split_inclusive('\n') {
                        let end = start + line.trim_end_matches('\n').len();
                        let color = if line.starts_with('+') && !line.starts_with("+++") {
                            Some(diff_added())
                        } else if line.starts_with('-') && !line.starts_with("---") {
                            Some(diff_removed())
                        } else {
                            None
                        };
                        if let Some(color) = color
                            && end > start
                        {
                            map.entry(id.as_u64()).or_default().push((start..end, color));
                        }
                        start += line.len();
                    }
                }
                let map = Rc::new(map);
                *self.notefig.diff_cache.borrow_mut() = Some((revision, map.clone()));
                map
            }
        };
        for (leaf, ranges) in diff.iter() {
            if let Some(id) = self.model.doc.leaves().iter().find(|b| b.as_u64() == *leaf) {
                for (range, color) in ranges {
                    out.push((*id, range.clone(), *color));
                }
            }
        }
        for (ix, (block, range)) in self.notefig.search.iter().enumerate() {
            if self.model.doc.leaf_len(*block).is_some_and(|len| range.end <= len) {
                out.push((
                    *block,
                    range.clone(),
                    search_color(self.notefig.search_active == Some(ix)),
                ));
            }
        }
        out
    }

    /// Where the placeholder goes, relative to the editor content: the
    /// caret's empty paragraph, or the first leaf of an empty document.
    pub(crate) fn placeholder_origin(&self, focused: bool) -> Option<(gpui::Point<Pixels>, SharedString)> {
        let text = self.notefig.placeholder.clone()?;
        let doc = &self.model.doc;
        let leaves = doc.leaves();
        let empty_doc = leaves.len() == 1
            && doc.inline(leaves[0]).is_some_and(|i| i.is_empty())
            && doc.frontmatter.is_none();
        let target = if empty_doc {
            leaves[0]
        } else if focused {
            let caret = self.model.caret()?;
            let is_empty_para = matches!(doc.kind(caret.block), Some(BlockKindData::Paragraph))
                && doc.inline(caret.block).is_some_and(|i| i.is_empty())
                && self.model.selection().is_collapsed();
            if !is_empty_para {
                return None;
            }
            caret.block
        } else {
            return None;
        };
        let frame = self.frame.borrow();
        let content = frame.content?;
        let leaf = frame.leaf(target)?;
        let point = leaf.caret_point(0);
        Some((point - content.origin, text))
    }

    // ---- shortcuts ------------------------------------------------------------------

    fn toggle_heading(&mut self, level: u8, cx: &mut Context<Self>) {
        let kind = if self.model.block_kind_at_caret() == Some(BlockKind::Heading { level }) {
            BlockKind::Paragraph
        } else {
            BlockKind::Heading { level }
        };
        let _ = self.run(EditorCommand::SetBlockKind(kind), cx);
    }

    pub(crate) fn on_toggle_underline(&mut self, _: &ToggleUnderline, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::ToggleMark(MarkKind::Underline), cx);
    }
    pub(crate) fn on_toggle_strikethrough(&mut self, _: &ToggleStrikethrough, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::ToggleMark(MarkKind::Strikethrough), cx);
    }
    pub(crate) fn on_toggle_highlight(&mut self, _: &ToggleHighlight, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::ToggleMark(MarkKind::Highlight), cx);
    }
    pub(crate) fn on_toggle_subscript(&mut self, _: &ToggleSubscript, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_script(false, cx);
    }
    pub(crate) fn on_toggle_superscript(&mut self, _: &ToggleSuperscript, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_script(true, cx);
    }
    /// Wrap the selection in `<sub>`/`<sup>` (an atom), or unwrap the one
    /// selected.
    pub fn toggle_script(&mut self, sup: bool, cx: &mut Context<Self>) {
        if self.is_readonly() {
            return;
        }
        let revision = self.model.revision();
        if self.model.toggle_script(sup).is_ok() && self.model.revision() != revision {
            self.after_edit_pub(EditOrigin::Command(if sup { "superscript" } else { "subscript" }), cx);
        }
    }
    pub(crate) fn on_toggle_heading1(&mut self, _: &ToggleHeading1, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_heading(1, cx);
    }
    pub(crate) fn on_toggle_heading2(&mut self, _: &ToggleHeading2, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_heading(2, cx);
    }
    pub(crate) fn on_toggle_heading3(&mut self, _: &ToggleHeading3, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_heading(3, cx);
    }
    pub(crate) fn on_toggle_heading4(&mut self, _: &ToggleHeading4, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_heading(4, cx);
    }
    pub(crate) fn on_toggle_heading5(&mut self, _: &ToggleHeading5, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_heading(5, cx);
    }
    pub(crate) fn on_toggle_heading6(&mut self, _: &ToggleHeading6, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_heading(6, cx);
    }
    pub(crate) fn on_toggle_bullet_list(&mut self, _: &ToggleBulletList, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::ToggleList { ordered: false }, cx);
    }
    pub(crate) fn on_toggle_ordered_list(&mut self, _: &ToggleOrderedList, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::ToggleList { ordered: true }, cx);
    }
    pub(crate) fn on_toggle_task_list(&mut self, _: &ToggleTaskList, _: &mut Window, cx: &mut Context<Self>) {
        let _ = self.run(EditorCommand::ToggleTask, cx);
    }
    pub(crate) fn on_toggle_blockquote(&mut self, _: &ToggleBlockquote, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_readonly() {
            return;
        }
        let revision = self.model.revision();
        if self.model.toggle_blockquote().is_ok() && self.model.revision() != revision {
            self.after_edit_pub(EditOrigin::Command("blockquote"), cx);
        }
    }
    pub(crate) fn on_toggle_code_block(&mut self, _: &ToggleCodeBlock, _: &mut Window, cx: &mut Context<Self>) {
        if self.model.block_kind_at_caret() == Some(BlockKind::CodeBlock) {
            let _ = self.run(EditorCommand::SetBlockKind(BlockKind::Paragraph), cx);
        } else {
            let _ = self.run(EditorCommand::SetCodeBlock { lang: None }, cx);
        }
    }
}

/// A parsed diff fence: the file label and the lines with their sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffSummary {
    pub language: Option<SharedString>,
    /// From `+++ b/<path>` (or `--- a/<path>`), when present.
    pub file: Option<String>,
    pub added: usize,
    pub removed: usize,
}

/// Summarize a diff fence's body (`+N −M`, the file label).
pub fn diff_summary(lang: Option<&str>, code: &str) -> DiffSummary {
    let mut file = None;
    let (mut added, mut removed) = (0, 0);
    for line in code.lines() {
        if let Some(rest) = line.strip_prefix("+++ ") {
            let path = rest.trim();
            if path != "/dev/null" {
                file = Some(path.strip_prefix("b/").unwrap_or(path).to_string());
            }
        } else if let Some(rest) = line.strip_prefix("--- ") {
            let path = rest.trim();
            if file.is_none() && path != "/dev/null" {
                file = Some(path.strip_prefix("a/").unwrap_or(path).to_string());
            }
        } else if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    DiffSummary {
        language: lang.filter(|l| !l.is_empty()).map(|l| SharedString::from(l.to_string())),
        file,
        added,
        removed,
    }
}

impl BlockEditorState {
    /// Whether `block` is a diff fence shown as a card now: it is, unless
    /// the caret or selection is in it (edit mode shows the source).
    pub(crate) fn shows_diff_card(&self, block: BlockId) -> bool {
        let doc = &self.model.doc;
        let Some(BlockKindData::CodeBlock { lang, meta }) = doc.kind(block) else {
            return false;
        };
        if !self.notefig.diff_cards
            || !super::notefig::is_diff_fence(lang.as_deref(), meta.as_deref())
        {
            return false;
        }
        let editing = self.model.caret().is_some_and(|c| c.block == block)
            || self.selection_ranges().iter().any(|(b, _)| *b == block);
        !editing
    }

    /// Show diff fences as cards (on by default). Off, they are code blocks
    /// with added/removed line backgrounds.
    pub fn set_diff_cards(&mut self, on: bool, cx: &mut Context<Self>) {
        self.notefig.diff_cards = on;
        cx.notify();
    }

    /// The diff card for `block` (the editor's own node view).
    pub(crate) fn render_diff_card(
        &self,
        block: BlockId,
        entity: gpui::WeakEntity<Self>,
        cx: &App,
    ) -> AnyElement {
        use gpui::{InteractiveElement as _, IntoElement as _, ParentElement as _, Styled as _, div, px};
        let doc = &self.model.doc;
        let (lang, code) = match (doc.kind(block), doc.plain(block)) {
            (Some(BlockKindData::CodeBlock { lang, .. }), Some(code)) => (lang.clone(), code.to_string()),
            _ => (None, String::new()),
        };
        let summary = diff_summary(lang.as_deref(), &code);
        let theme = gpui_kit::base::Theme::global(cx);
        let colors = theme.tokens.colors;
        let mono = theme.tokens.typography.mono.clone();
        let green = gpui::hsla(130. / 360., 0.5, 0.4, 1.);
        let red = gpui::hsla(0., 0.65, 0.5, 1.);
        let header = div()
            .flex()
            .flex_row()
            .gap(px(8.))
            .px(px(10.))
            .py(px(6.))
            .border_b_1()
            .border_color(colors.border)
            .text_xs()
            .child(
                div()
                    .text_color(colors.foreground)
                    .child(summary.file.clone().unwrap_or_else(|| "diff".into())),
            )
            .children(
                summary
                    .language
                    .clone()
                    .map(|l| div().text_color(colors.muted_foreground).child(l)),
            )
            .child(div().flex_1())
            .child(div().text_color(green).child(format!("+{}", summary.added)))
            .child(div().text_color(red).child(format!("−{}", summary.removed)))
            .child(
                div()
                    .id(("diff-edit", block.as_u64() as usize))
                    .text_color(colors.muted_foreground)
                    .cursor_pointer()
                    .child("Edit"),
            );
        let rows = code.lines().filter(|l| !l.starts_with("+++ ") && !l.starts_with("--- ")).map(|line| {
            let (sign, bg, fg, text) = if line.starts_with("@@") {
                (" ", None, colors.muted_foreground, line)
            } else if let Some(rest) = line.strip_prefix('+') {
                ("+", Some(diff_added()), green, rest)
            } else if let Some(rest) = line.strip_prefix('-') {
                ("−", Some(diff_removed()), red, rest)
            } else {
                (" ", None, colors.foreground, line.strip_prefix(' ').unwrap_or(line))
            };
            div()
                .flex()
                .flex_row()
                .w_full()
                .when_some(bg, |d, bg| d.bg(bg))
                .child(div().w(px(18.)).flex_none().text_color(fg).child(sign))
                .child(
                    div()
                        .flex_1()
                        .text_color(if line.starts_with("@@") { fg } else { colors.foreground })
                        .child(text.to_string()),
                )
        });
        div()
            .id(("diff-card", block.as_u64() as usize))
            .w_full()
            .mb(px(12.))
            .rounded(px(6.))
            .border_1()
            .border_color(colors.border)
            .overflow_hidden()
            .cursor_pointer()
            // A click opens the source for editing (edit mode).
            .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
                if let Some(editor) = entity.upgrade() {
                    editor.update(cx, |e, cx| {
                        let _ = e.set_selection(BlockSelection::caret(BlockPosition::new(block, 0)), cx);
                        e.focus(window, cx);
                    });
                }
            })
            .child(header)
            .child(
                div()
                    .py(px(4.))
                    .font_family(mono)
                    .text_sm()
                    .children(rows),
            )
            .into_any_element()
    }
}

use gpui::prelude::FluentBuilder as _;

/// Where pasted or dropped images go: `dir` on disk (usually
/// `<docDir>/assets`) and the `src` prefix written into the document
/// (usually `assets/`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageAssetTarget {
    pub dir: PathBuf,
    pub src_prefix: String,
}

/// Normalize an asset file name like the TS app: spaces become `-`,
/// parentheses are removed.
pub fn normalize_asset_name(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '(' && *c != ')')
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect()
}

/// Write `bytes` into `target.dir` under a normalized, de-duplicated name
/// (`name`, `name-1`, …) and return the `src` to put in the document.
pub fn save_image_asset(target: &ImageAssetTarget, name: &str, bytes: &[u8]) -> std::io::Result<String> {
    std::fs::create_dir_all(&target.dir)?;
    let name = normalize_asset_name(name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.clone(), String::new()),
    };
    let mut candidate = format!("{stem}{ext}");
    let mut n = 1;
    while target.dir.join(&candidate).exists() {
        candidate = format!("{stem}-{n}{ext}");
        n += 1;
    }
    std::fs::write(target.dir.join(&candidate), bytes)?;
    Ok(format!("{}{candidate}", target.src_prefix))
}

pub(crate) fn is_image_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "tif" | "tiff"))
}

fn image_extension(format: gpui::ImageFormat) -> &'static str {
    match format {
        gpui::ImageFormat::Png => "png",
        gpui::ImageFormat::Jpeg => "jpg",
        gpui::ImageFormat::Webp => "webp",
        gpui::ImageFormat::Gif => "gif",
        gpui::ImageFormat::Svg => "svg",
        gpui::ImageFormat::Bmp => "bmp",
        gpui::ImageFormat::Tiff => "tiff",
        _ => "png",
    }
}

impl BlockEditorState {
    /// Accept pasted and dropped images: `target` is asked for the folder
    /// at the time of the paste (the document may have moved). `None` turns
    /// image paste/drop off.
    pub fn set_image_asset_target(
        &mut self,
        target: Option<impl Fn() -> Option<ImageAssetTarget> + 'static>,
    ) {
        self.notefig.asset_target = target.map(|t| Rc::new(t) as Rc<dyn Fn() -> Option<ImageAssetTarget>>);
    }

    fn insert_image_src(&mut self, src: &str, cx: &mut Context<Self>) {
        let markdown = format!("![]({})", super::markdown_source::markdown_destination(src));
        let revision = self.model.revision();
        let _ = self.model.paste_inline_markdown(&markdown);
        if self.model.revision() != revision {
            self.after_edit_pub(EditOrigin::Paste, cx);
        }
    }

    /// Paste: a clipboard image is saved into the assets folder and inserted
    /// as `![](assets/<name>)`. Returns whether it handled the item.
    pub(crate) fn paste_image(&mut self, item: &gpui::ClipboardItem, cx: &mut Context<Self>) -> bool {
        let Some(target) = self.notefig.asset_target.as_ref().and_then(|t| t()) else {
            return false;
        };
        let Some(image) = item.entries().iter().find_map(|e| match e {
            gpui::ClipboardEntry::Image(image) => Some(image.clone()),
            _ => None,
        }) else {
            return false;
        };
        let name = format!("pasted-image.{}", image_extension(image.format));
        match save_image_asset(&target, &name, &image.bytes) {
            Ok(src) => {
                self.insert_image_src(&src, cx);
                true
            }
            Err(_) => false,
        }
    }

    /// Drop of OS files: images are copied into the assets folder and
    /// inserted at the drop point; other files are reported with
    /// [`BlockEditorEvent::FilesDropped`].
    pub fn drop_paths(&mut self, paths: &[PathBuf], at: Option<gpui::Point<Pixels>>, cx: &mut Context<Self>) {
        if self.is_readonly() {
            return;
        }
        if let Some(at) = at
            && let Some(pos) = self.frame.borrow().hit_test(at)
        {
            let _ = self.model.set_selection(BlockSelection::caret(pos));
        }
        let target = self.notefig.asset_target.as_ref().and_then(|t| t());
        let mut others = Vec::new();
        for path in paths {
            let saved = target.as_ref().filter(|_| is_image_path(path)).and_then(|target| {
                let bytes = std::fs::read(path).ok()?;
                let name = path.file_name()?.to_string_lossy().to_string();
                save_image_asset(target, &name, &bytes).ok()
            });
            match saved {
                Some(src) => self.insert_image_src(&src, cx),
                None => others.push(path.clone()),
            }
        }
        if !others.is_empty() {
            cx.emit(BlockEditorEvent::FilesDropped { paths: others });
        }
    }
}

/// Above this size `set_source_async` parses off the UI thread.
const ASYNC_LOAD_BYTES: usize = 64 * 1024;
/// The prefix shown while the rest parses.
const ASYNC_PREFIX_BYTES: usize = 24 * 1024;

/// A cut point at a blank line after `min` bytes where the text before it
/// stands on its own (balanced fences and comments, no definitions after).
fn prefix_cut(source: &str, min: usize) -> Option<usize> {
    let mut from = min.min(source.len());
    while !source.is_char_boundary(from) {
        from += 1;
    }
    let at = source[from..].find("\n\n")? + from;
    let head = &source[..at];
    let fences = head
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("```") || t.starts_with("~~~")
        })
        .count();
    let tail = &source[at..];
    let continues_list = tail.trim_start_matches('\n').starts_with([' ', '\t', '-', '*', '+'])
        || tail.trim_start_matches('\n').starts_with(|c: char| c.is_ascii_digit());
    (fences % 2 == 0 && head.matches("<!--").count() == head.matches("-->").count() && !continues_list)
        .then_some(at)
}

impl BlockEditorState {
    /// Load a document without blocking the UI on a large file: up to 64 KB
    /// it is `set_source`; beyond, the first ~24 KB is shown at once
    /// (read-only) and the whole document is parsed on a background thread,
    /// then swapped in (history cleared, caret at the start) and
    /// [`BlockEditorEvent::Loaded`] is emitted. Edits are not possible until
    /// then.
    pub fn set_source_async(&mut self, source: String, cx: &mut Context<Self>) -> gpui::Task<()> {
        if source.len() <= ASYNC_LOAD_BYTES {
            if self.notefig.loading {
                // Supersede the parse in flight.
                self.notefig.load_generation += 1;
                self.notefig.loading = false;
                self.notefig.loading_source = None;
                let readonly = self.notefig.loading_readonly;
                self.set_readonly(readonly, cx);
            }
            let _ = self.set_source(&source, cx);
            cx.emit(BlockEditorEvent::Loaded);
            return gpui::Task::ready(());
        }
        if let Some(cut) = prefix_cut(&source, ASYNC_PREFIX_BYTES) {
            let _ = self.set_source(&source[..cut], cx);
        }
        // A second load while one is parsing keeps the original read-only
        // flag.
        let was_readonly = if self.notefig.loading {
            self.notefig.loading_readonly
        } else {
            self.is_readonly()
        };
        self.notefig.loading_readonly = was_readonly;
        self.set_readonly(true, cx);
        self.notefig.loading = true;
        self.notefig.load_generation += 1;
        let generation = self.notefig.load_generation;
        self.notefig.loading_source = Some(source.clone());
        let extensions = self.model.doc.extensions.clone();
        let parse = gpui::AppContext::background_spawn(cx, async move {
            super::import::parse_document(&source, extensions)
        });
        cx.spawn(async move |this, cx| {
            let doc = parse.await;
            let _ = this.update(cx, |this, cx| {
                if this.notefig.load_generation != generation {
                    return;
                }
                this.notefig.loading_source = None;
                if let Ok(doc) = doc {
                    this.model.replace_document(doc);
                    this.projection.invalidate();
                }
                this.notefig.loading = false;
                this.set_readonly(was_readonly, cx);
                cx.emit(BlockEditorEvent::Loaded);
                cx.notify();
            });
        })
    }

    /// Whether a `set_source_async` load is still parsing.
    pub fn is_loading(&self) -> bool {
        self.notefig.loading
    }
}
