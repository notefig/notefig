//! A block-based WYSIWYG Markdown editor for GPUI, built on gpui-kit's
//! public editor host API (`gpui_kit::base::text::editor_host`).
//!
//! The design began as a spike in
//! [longbridge/gpui-kit#3049](https://github.com/longbridge/gpui-kit/pull/3049)
//! and [#3566](https://github.com/longbridge/gpui-kit/pull/3566); see
//! `docs/design.md`. Call [`init`] once, after `gpui_kit::init`.
//!
//! - [`BlockEditorModel`]: the headless model. It has stable [`BlockId`]s,
//!   validated [`BlockPosition`]s, normalized inline mark runs, invertible
//!   steps grouped into transactions, undo coalescing, commands on nested
//!   blocks ([`EditorCommand`]), and a Markdown serializer.
//! - [`BlockEditorState`]: the entity that owns a model, focus, IME and
//!   key bindings, and emits [`BlockEditorEvent`]s.
//! - [`BlockEditor`]: the view. It renders through gpui-kit's own text
//!   renderer (a direct model-to-node projection) and culls off-screen blocks.
//!
//! ```ignore
//! let scroll = ScrollHandle::new();
//! let editor = cx.new(|cx| {
//!     let mut state = BlockEditorState::new(window, cx).with_source("# Hello");
//!     // Optional: keep the caret in view inside your scroll container.
//!     state.set_scroll_handle(scroll.clone());
//!     state
//! });
//! cx.subscribe(&editor, |_, editor, event: &BlockEditorEvent, cx| {
//!     if let BlockEditorEvent::Changed { .. } = event {
//!         let markdown = editor.read(cx).source();
//!     }
//! });
//! // in render:
//! div().id("doc").overflow_y_scroll().track_scroll(&scroll)
//!     .child(BlockEditor::new(&editor))
//! ```
//!
//! Keys: Enter, Backspace/Delete, arrows/Home/End (+Shift), Cmd/Ctrl+A, B, I,
//! E, Z, Shift+Z, C, X, V, and Shift+V (plain paste); Tab/Shift+Tab indent
//! list items; Cmd/Ctrl+Alt+0 makes the block (or each selected block) a
//! paragraph. Input rules: `# `..`###### `, `- `, `* `, `+ `, `1. `.
//! The scroll handle is optional: without it, blocks outside the visible
//! area are still culled, but moving the caret never scrolls (a no-op).

mod command;
mod cull;
mod direct;
mod document;
mod editor;
mod element;
mod frame;
mod host;
mod id;
mod import;
mod inline;
mod input_rule;
mod kind;
mod list;
mod markdown_source;
mod merge;
mod minimap;
mod notefig;
mod notefig_view;
mod notefig_ui;
mod marks;
mod order;
mod pm;
mod position;
mod projection;
mod selection;
mod serialize;
mod slice;
mod source_map;
mod state;
mod step;
mod style;
mod support;
pub(crate) mod table;
mod table_ui;
mod tracking;
mod transaction;
mod undo;

#[cfg(test)]
mod tests;

pub mod component;

pub use command::{CommandError, EditorCommand};
pub use document::{BlockRef, DocumentRef};
pub use editor::BlockEditorModel;
pub use element::BlockEditor;
pub use gpui_kit::base::text::editor_host::ColumnAlign;
pub use input_rule::InputRule;
pub use merge::MergeSummary;
pub use minimap::{
    MinimapDot, MinimapDotCore, MinimapDotState, MinimapEntry, MinimapJump, MinimapRail,
    MinimapSource, dot_title, spread_ratios,
};
pub use notefig_ui::{CODE_LANGUAGES, Property, apply_properties, parse_properties};
pub use pm::{DocHeading, DocumentRange};
pub use notefig_view::{CheckboxStyle, ListStyle, ProseStyle, QuoteStyle, 
    ImageAssetTarget, normalize_asset_name, save_image_asset, DiffSummary, NodeViewCtx, NodeViewRenderer, diff_summary};
pub use notefig::{
    MAX_REFERENCE_CHARS, MENTION_NODE, PROMPT_NODE, PromptReference, PromptWidget,
    WidgetRemovalGuard, SUB_NODE, SUP_NODE, WidgetPlacement, is_diff_fence,
    new_prompt_widget_id, strip_prompt_markers,
};
pub use state::{BlockEditorEvent, BlockEditorState, ClipboardPolicy, PasteRequest, SubmitPolicy};
pub use style::BlockEditorStyle;
pub use table::{TableEdit, TableLine};

/// Registers the editor's key bindings. Call once at startup, after `gpui_kit::init`.
pub fn init(cx: &mut gpui::App) {
    state::init(cx);
    notefig_view::init(cx);
}
/// gpui-kit's own layers first (theme, global state), then the editor.
#[cfg(test)]
pub(crate) fn init_for_tests(cx: &mut gpui::App) {
    gpui_kit::init(cx);
    init(cx);
}

pub use id::BlockId;
pub use kind::BlockKind;
pub use marks::{MarkChange, MarkKind, MarkSet, MarkState};
pub use position::{Affinity, BlockPosition, PositionError};
pub use selection::{BlockSelection, SelectionError};
pub use transaction::{EditOrigin, Transaction};
pub use tracking::{RoundId, TrackedChange};

pub use host::{CapturedRange, CapturedRangeError, SourceSnapshot};

/// Whether image atoms may load resources while the editor presents them.
/// `Placeholder` keeps the atomic document, source and selection but never
/// resolves URLs, decodes data, reads paths or creates image elements.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ImagePolicy {
    #[default]
    Load,
    Placeholder,
}
