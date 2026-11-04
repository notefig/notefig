//! A document tab's content: one per open file, shared by every pane that
//! shows it. Markdown files host the block editor; other text files open in
//! gpui-kit's code editor; images preview. Autosave: 500 ms after the last
//! edit, one write in flight, a dirty flag until the write lands.

use std::path::PathBuf;
use std::time::Duration;

use gpui::{
    AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ObjectFit, ParentElement, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled, StyledImage as _, Subscription, Task, Window, div,
    img,
};
use gpui_kit::component::input::{Editor, EditorState, InputEvent};
use gpui_kit::component::{ActiveTheme as _, v_flex};
use markdown_editor::{BlockEditor, BlockEditorEvent, BlockEditorState};
use notefig_workspace::{Workspace, content_hash};

pub const AUTOSAVE_DEBOUNCE: Duration = Duration::from_millis(500);
const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];

pub fn extension(rel: &str) -> String {
    notefig_workspace::file_name(rel)
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_markdown(rel: &str) -> bool {
    MARKDOWN_EXTENSIONS.contains(&extension(rel).as_str())
}

pub fn is_image(rel: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&extension(rel).as_str())
}

pub enum DocKind {
    Markdown {
        editor: Entity<BlockEditorState>,
        scroll: ScrollHandle,
    },
    Code {
        editor: Entity<EditorState>,
    },
    Image {
        abs: PathBuf,
    },
    Unsupported {
        reason: SharedString,
    },
}

#[derive(Clone, Debug)]
pub enum DocumentEvent {
    /// The user edited the document (the workspace pins its preview tab).
    Edited,
    /// A write landed (or failed); the tab's dirty mark may have changed.
    SaveStateChanged,
    /// Non-image files dropped on the editor (the workspace opens or
    /// mentions them).
    FilesDropped(Vec<PathBuf>),
    /// `/` in an empty paragraph: insert a prompt widget there.
    SlashTrigger(markdown_editor::BlockId),
    LinkClicked(String),
    /// Content adopted from an agent round (change tracking started).
    RoundAdopted(markdown_editor::RoundId),
}

pub struct Document {
    ws: Workspace,
    rel: String,
    pub kind: DocKind,
    focus: FocusHandle,
    /// Hash of what is on disk as far as this document knows.
    disk_hash: Option<String>,
    /// What this document last loaded or wrote (the adoption baseline).
    last_text: Option<String>,
    dirty: bool,
    saving: bool,
    /// Write even if the text matches `disk_hash` (an external change landed
    /// while our write was in flight and must be overwritten).
    force_next_save: bool,
    save_again: bool,
    debounce: Option<Task<()>>,
    pub last_error: Option<SharedString>,
    /// Prompt widgets' views (markdown documents with agents available).
    pub widgets: Option<crate::agents::widget::WidgetRegistry>,
    /// The agent round whose changes the navigator steps through.
    pub last_round: Option<markdown_editor::RoundId>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<DocumentEvent> for Document {}

impl Document {
    /// Load `rel` from disk (synchronously; workspace files are local).
    pub fn open(ws: Workspace, rel: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = Vec::new();
        let mut disk_hash = None;
        let mut last_text = None;
        let size = ws
            .abs(rel)
            .ok()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len());
        let kind = if is_image(rel) {
            DocKind::Image {
                abs: ws.abs(rel).unwrap_or_default(),
            }
        } else if size.is_some_and(|s| s > MAX_TEXT_BYTES) {
            DocKind::Unsupported {
                reason: "This file is too large to open.".into(),
            }
        } else {
            match ws.read(rel) {
                Err(err) => DocKind::Unsupported {
                    reason: format!("{err:#}").into(),
                },
                Ok((text, hash)) => {
                    disk_hash = Some(hash);
                    last_text = Some(text.clone());
                    if is_markdown(rel) {
                        let scroll = ScrollHandle::new();
                        let abs = ws.abs(rel).unwrap_or_default();
                        let base_dir = abs.parent().map(|p| p.to_path_buf());
                        let editor = cx.new(|cx| {
                            let mut state = BlockEditorState::new(window, cx);
                            state.set_scroll_handle(scroll.clone());
                            state.set_image_base_dir(base_dir.clone(), cx);
                            // Pasted/dropped images go to `assets/` next to
                            // the document (the TS rule).
                            let assets = base_dir.clone();
                            state.set_image_asset_target(Some(move || {
                                assets.as_ref().map(|dir| markdown_editor::ImageAssetTarget {
                                    dir: dir.join("assets"),
                                    src_prefix: "assets/".into(),
                                })
                            }));
                            state.set_diff_cards(true, cx);
                            state.set_properties_chip(true, cx);
                            state.set_language_picker(true, cx);
                            state.set_placeholder(Some("Type something, or press / for AI…".into()), cx);
                            // Large files show their head at once and finish
                            // parsing off the UI thread.
                            state.set_source_async(text.clone(), cx).detach();
                            state
                        });
                        subscriptions.push(cx.subscribe(&editor, |this, _, event, cx| match event {
                            BlockEditorEvent::Changed { origin, .. } => {
                                if !origin.is_external() {
                                    this.edited(cx);
                                }
                            }
                            BlockEditorEvent::FilesDropped { paths } => {
                                cx.emit(DocumentEvent::FilesDropped(paths.clone()));
                            }
                            BlockEditorEvent::SlashTrigger { block, .. } => {
                                cx.emit(DocumentEvent::SlashTrigger(*block));
                            }
                            BlockEditorEvent::LinkClicked { url } => {
                                cx.emit(DocumentEvent::LinkClicked(url.to_string()));
                            }
                            _ => {}
                        }));
                        DocKind::Markdown { editor, scroll }
                    } else {
                        let ext = extension(rel);
                        let editor = cx.new(|cx| {
                            EditorState::new(window, cx)
                                .line_number(true)
                                .language(if ext.is_empty() { "text".into() } else { ext })
                                .default_value(text)
                        });
                        subscriptions.push(cx.subscribe(&editor, |this, _, event, cx| {
                            if let InputEvent::Change = event {
                                this.edited(cx);
                            }
                        }));
                        DocKind::Code { editor }
                    }
                }
            }
        };
        Self {
            ws,
            rel: rel.to_string(),
            kind,
            focus: cx.focus_handle(),
            disk_hash,
            last_text,
            dirty: false,
            saving: false,
            force_next_save: false,
            save_again: false,
            debounce: None,
            last_error: None,
            widgets: None,
            last_round: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn rel(&self) -> &str {
        &self.rel
    }

    pub fn set_rel(&mut self, rel: String, cx: &mut Context<Self>) {
        if let DocKind::Image { abs } = &mut self.kind {
            *abs = self.ws.abs(&rel).unwrap_or_default();
        }
        if let Some(widgets) = &self.widgets {
            *widgets.host.rel.borrow_mut() = rel.clone();
        }
        self.rel = rel;
        cx.notify();
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty || self.saving
    }

    pub fn is_text(&self) -> bool {
        matches!(self.kind, DocKind::Markdown { .. } | DocKind::Code { .. })
    }

    /// The current text (markdown is the editor's canonical serialization).
    pub fn text(&self, cx: &gpui::App) -> Option<String> {
        match &self.kind {
            DocKind::Markdown { editor, .. } => Some(editor.read(cx).source()),
            DocKind::Code { editor } => Some(editor.read(cx).value().to_string()),
            _ => None,
        }
    }

    pub fn focus_editor(doc: &Entity<Document>, window: &mut Window, cx: &mut gpui::App) {
        let handle = doc.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    }

    fn edited(&mut self, cx: &mut Context<Self>) {
        self.dirty = true;
        cx.emit(DocumentEvent::Edited);
        self.debounce = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(AUTOSAVE_DEBOUNCE).await;
            let _ = this.update(cx, |this, cx| this.save(cx));
        }));
        cx.notify();
    }

    /// Write now (Cmd+S, or when the debounce fires). If a write is in
    /// flight, one more runs after it.
    pub fn save(&mut self, cx: &mut Context<Self>) {
        self.debounce = None;
        if self.saving {
            self.save_again = true;
            return;
        }
        let Some(text) = self.text(cx) else { return };
        if !self.dirty {
            return;
        }
        let hash = content_hash(&text);
        if Some(&hash) == self.disk_hash.as_ref() && !self.force_next_save {
            self.dirty = false;
            cx.emit(DocumentEvent::SaveStateChanged);
            cx.notify();
            return;
        }
        self.force_next_save = false;
        self.saving = true;
        self.dirty = false;
        let ws = self.ws.clone();
        let rel = self.rel.clone();
        let written = text.clone();
        let write = cx
            .background_executor()
            .spawn(async move { ws.write(&rel, &text) });
        cx.spawn(async move |this, cx| {
            let result = write.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(hash) => {
                        this.disk_hash = Some(hash);
                        this.last_text = Some(written);
                        this.last_error = None;
                    }
                    Err(err) => {
                        log::error!("save failed: {err:#}");
                        this.last_error = Some(format!("{err:#}").into());
                        this.dirty = true;
                    }
                }
                if std::mem::take(&mut this.save_again) {
                    this.save(cx);
                }
                cx.emit(DocumentEvent::SaveStateChanged);
                cx.notify();
            });
        })
        .detach();
        cx.emit(DocumentEvent::SaveStateChanged);
        cx.notify();
    }

    /// Synchronous write of unsaved edits (on quit / workspace close).
    pub fn save_blocking(&mut self, cx: &mut Context<Self>) {
        if !self.dirty && !self.save_again {
            return;
        }
        if let Some(text) = self.text(cx) {
            match self.ws.write(&self.rel, &text) {
                Ok(hash) => {
                    self.disk_hash = Some(hash);
                    self.last_text = Some(text);
                    self.dirty = false;
                }
                Err(err) => log::error!("save failed: {err:#}"),
            }
        }
    }

    /// Whether the user has edits not yet on disk (a pending debounce, a
    /// write in flight, or a dirty mark).
    pub fn has_unsaved_edits(&self) -> bool {
        self.dirty || self.saving || self.debounce.is_some()
    }

    /// The file changed on disk (watcher). Adoption follows the TS
    /// DocumentSync rules (spec 01 §2.4):
    /// - same hash, or same text up to trailing whitespace: record, no-op;
    /// - the user has unsaved edits (debounce pending, saving, dirty): the
    ///   user's edit wins and their save overwrites the external change;
    /// - otherwise the new content is adopted into the editor.
    /// Returns whether the editor content changed.
    pub fn reload_from_disk(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if let DocKind::Image { .. } = self.kind {
            cx.notify();
            return true;
        }
        let Ok((text, hash)) = self.ws.read(&self.rel) else {
            return false;
        };
        if Some(&hash) == self.disk_hash.as_ref() {
            return false;
        }
        if self
            .last_text
            .as_deref()
            .is_some_and(|last| last.trim_end() == text.trim_end())
        {
            self.disk_hash = Some(hash);
            return false;
        }
        if self.has_unsaved_edits() {
            log::info!("{}: external change skipped, unsaved edits win", self.rel);
            // Disk now holds the external text: make sure the user's
            // version is written over it.
            self.disk_hash = Some(hash);
            self.dirty = true;
            if self.saving {
                self.save_again = true;
                self.force_next_save = true;
            } else if self.debounce.is_none() {
                self.save(cx);
            }
            return false;
        }
        let (origin, round) = match (crate::agents::Agents::global(cx), self.ws.abs(&self.rel)) {
            (Some(agents), Ok(abs)) => crate::agents::origin_for_write(&agents, &abs, &text, cx),
            _ => (markdown_editor::EditOrigin::External, None),
        };
        self.adopt(&text, hash, origin, round, window, cx);
        true
    }

    /// Adopt `text` (already on disk with `hash`) into the editor as one
    /// undoable transaction tagged `origin`; a widget round's edits are
    /// tracked. Bound prompt widgets the text dropped are kept by the
    /// editor, and the file is rewritten with them.
    pub fn adopt(
        &mut self,
        text: &str,
        hash: String,
        origin: markdown_editor::EditOrigin,
        round: Option<markdown_editor::RoundId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.disk_hash = Some(hash);
        self.last_text = Some(text.to_string());
        match &self.kind {
            DocKind::Markdown { editor, .. } => {
                let editor = editor.clone();
                if let Some(round) = round {
                    let brand = crate::theme::BrandColors::get(cx).brand;
                    editor.update(cx, |state, cx| {
                        state.track_changes(round);
                        state.set_change_gutter(Some((round, brand)), cx);
                    });
                }
                let summary = apply_external_content(&editor, text, origin, cx);
                if summary.is_some_and(|s| s.reinserted_widgets > 0) {
                    let source = editor.read(cx).source();
                    match self.ws.write(&self.rel, &source) {
                        Ok(hash) => {
                            self.disk_hash = Some(hash);
                            self.last_text = Some(source);
                        }
                        Err(err) => log::error!("rewriting widgets failed: {err:#}"),
                    }
                }
                if let Some(round) = round {
                    cx.emit(DocumentEvent::RoundAdopted(round));
                }
            }
            DocKind::Code { editor } => {
                let text = text.to_string();
                editor.update(cx, |state, cx| state.set_value(text, window, cx));
            }
            _ => {}
        }
        cx.emit(DocumentEvent::SaveStateChanged);
        cx.notify();
    }

    pub fn markdown_editor(&self) -> Option<&Entity<BlockEditorState>> {
        match &self.kind {
            DocKind::Markdown { editor, .. } => Some(editor),
            _ => None,
        }
    }

    pub fn workspace(&self) -> &Workspace {
        &self.ws
    }

    /// Put the caret on a search match (1-based line, char columns) and
    /// focus the editor.
    pub fn go_to_match(
        this: &Entity<Document>,
        m: &notefig_workspace::SearchMatch,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        let (code, markdown, last_text) = {
            let doc = this.read(cx);
            match &doc.kind {
                DocKind::Code { editor } => (Some(editor.clone()), None, None),
                DocKind::Markdown { editor, .. } => (None, Some(editor.clone()), doc.last_text.clone()),
                _ => (None, None, None),
            }
        };
        match (code, markdown) {
            (Some(editor), _) => editor.update(cx, |state, cx| {
                let position = gpui_kit::component::input::Position {
                    line: m.line.saturating_sub(1) as u32,
                    character: m.start_column.saturating_sub(1) as u32,
                };
                state.set_cursor_position(position, window, cx);
            }),
            (None, Some(editor)) => {
                // The editor has no source mapping yet: count which
                // occurrence of the matched text this is in the file, and
                // select the same occurrence in the editor's leaves.
                let needle = m.match_text.as_str();
                if needle.is_empty() {
                    return;
                }
                let disk = last_text.unwrap_or_default();
                let mut nth = 0;
                for (ix, line) in disk.lines().enumerate() {
                    if ix + 1 == m.line {
                        let before: String = line.chars().take(m.start_column.saturating_sub(1)).collect();
                        nth += before.matches(needle).count();
                        break;
                    }
                    nth += line.matches(needle).count();
                }
                editor.update(cx, |state, cx| {
                    let mut seen = 0;
                    let mut target = None;
                    for leaf in state.model().document().leaves() {
                        let Some(text) = leaf.text() else { continue };
                        for (offset, _) in text.match_indices(needle) {
                            if seen == nth {
                                target = Some((leaf.id(), offset));
                                break;
                            }
                            seen += 1;
                        }
                        if target.is_some() {
                            break;
                        }
                    }
                    if let Some((block, offset)) = target {
                        let selection = markdown_editor::BlockSelection::Text {
                            anchor: markdown_editor::BlockPosition::new(block, offset),
                            head: markdown_editor::BlockPosition::new(block, offset + needle.len()),
                        };
                        if state.set_selection(selection, cx).is_ok() {
                            state.reveal_caret(cx);
                        }
                    }
                    state.focus(window, cx);
                });
            }
            _ => {}
        }
    }
}

/// THE path for external content (watcher reloads, agent writes) into a
/// live markdown editor: the editor's merge, one undoable transaction
/// (Cmd+Z reverts an agent write), tagged `External` or `Agent { round }`.
pub fn apply_external_content(
    editor: &Entity<BlockEditorState>,
    new_source: &str,
    origin: markdown_editor::EditOrigin,
    cx: &mut gpui::App,
) -> Option<markdown_editor::MergeSummary> {
    editor.update(cx, |state, cx| {
        match state.apply_external_source(new_source, origin, cx) {
            Ok(summary) => Some(summary),
            Err(err) => {
                log::error!("external content rejected by the editor: {err}");
                None
            }
        }
    })
}

impl Focusable for Document {
    fn focus_handle(&self, cx: &gpui::App) -> FocusHandle {
        match &self.kind {
            DocKind::Markdown { editor, .. } => editor.read(cx).focus_handle(cx),
            DocKind::Code { editor } => editor.read(cx).focus_handle(cx),
            _ => self.focus.clone(),
        }
    }
}

impl Render for Document {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        match &self.kind {
            DocKind::Markdown { editor, scroll } => div()
                .id(("doc-scroll", cx.entity_id()))
                .size_full()
                .overflow_y_scroll()
                .track_scroll(scroll)
                .bg(theme.background)
                .child(
                    div().w_full().flex().justify_center().child(
                        div()
                            .w_full()
                            .max_w(gpui::px(860.))
                            .min_h_full()
                            .child(BlockEditor::new(editor).min_h_full().px_8().py_6()),
                    ),
                )
                .into_any_element(),
            DocKind::Code { editor } => div()
                .size_full()
                .bg(theme.background)
                .child(Editor::new(editor).h_full().bordered(false))
                .into_any_element(),
            DocKind::Image { abs } => div()
                .id(("doc-image", cx.entity_id()))
                .track_focus(&self.focus)
                .size_full()
                .p_4()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.background)
                .child(
                    img(abs.clone())
                        .max_w_full()
                        .max_h_full()
                        .object_fit(ObjectFit::Contain),
                )
                .into_any_element(),
            DocKind::Unsupported { reason } => v_flex()
                .track_focus(&self.focus)
                .size_full()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child(reason.clone())
                .into_any_element(),
        }
    }
}
