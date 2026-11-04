//! A file tab's content (`polymorphic-editor.tsx`): the markdown editor with
//! its toolbar and link menu (`text-editor.tsx`, `tiptap-toolbar*.tsx`,
//! `tiptap-link-menu.tsx`), the read-only code viewer (`code-viewer.tsx`) or
//! the image viewer (`image-viewer.tsx`), chosen by `editor_type`.
//!
//! The host is what TS's editor store builds per file: it registers an
//! [`EditorInstance`] with `core.editors` (so documents can adopt agent
//! writes into it as one undoable change) and a [`TabController`] with
//! `core.tabs` (focus, selection, find-in-tab, undo/redo, dispose), and it
//! feeds the document's save pipeline (`core.documents.sync(path)`).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, ready};
use gpui::{
    AnyWindowHandle, App, AppContext as _, AsyncApp, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ObjectFit, ParentElement, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled,
    StyledImage as _, WeakEntity, Window, div, img, prelude::FluentBuilder as _,
};
use gpui_kit::component::input::{Editor, EditorState};
use markdown_editor::{BlockEditor, BlockEditorEvent, BlockEditorState, EditOrigin};
use notefig_core::Subscription;
use notefig_documents::{DocumentsApi, DocumentsModule, ReadRange};
use notefig_editors::{Adoption, AdoptionSource, EditorInstance, EditorTarget, EditorType, EditorsModule, SearchTarget, editor_type};
use notefig_files::FilesChanged;
use notefig_tabs::{TabController, TabKind, TabSearchOptions, TabsModule};
use notefig_ui::{CoreExt as _, icon, rem, sp, tokens};

use crate::toolbar::Toolbar;

pub(crate) fn init(_cx: &mut App) {}

enum Kind {
    Loading,
    Markdown { editor: Entity<BlockEditorState>, toolbar: Entity<Toolbar>, scroll: ScrollHandle },
    Code { state: Entity<EditorState> },
    Image { path: String },
    Error(SharedString),
}

/// What the instance and the controller read without an `App`: refreshed
/// on every change.
#[derive(Default)]
struct Cache {
    /// The document as of the last save round or adoption (word count,
    /// `markdown()`): never computed on demand, which would need the app.
    markdown: Option<String>,
    selected: Option<String>,
    destroyed: bool,
    editor: Option<WeakEntity<BlockEditorState>>,
}

pub struct EditorHost {
    path: String,
    /// The appearance and direction the editor's prose style was built for.
    prose_dark: Option<(bool, bool)>,
    kind: Kind,
    focus: FocusHandle,
    cache: Rc<RefCell<Cache>>,
    _subs: Vec<gpui::Subscription>,
    _core_subs: Vec<Subscription>,
}

impl EditorHost {
    pub fn new(path: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let path = path.to_string();
        let cache: Rc<RefCell<Cache>> = Rc::default();
        let mut this = Self { path: path.clone(), prose_dark: None, kind: Kind::Loading, focus: cx.focus_handle(), cache: cache.clone(), _subs: Vec::new(), _core_subs: Vec::new() };

        let kind = editor_type(&path);
        // Register with editors and tabs: what TS's editor store does.
        let instance = Rc::new(HostInstance {
            path: path.clone(),
            kind,
            host: cx.entity().downgrade(),
            cx: cx.to_async(),
            window: window.window_handle(),
            cache: cache.clone(),
            editable: Cell::new(true),
            documents: core.use_::<DocumentsModule>(),
            editors: core.use_::<EditorsModule>(),
        });
        core.use_::<EditorsModule>().register(&path, instance.clone());
        core.use_::<TabsModule>().controllers().register(instance);

        if kind == EditorType::Image {
            this.kind = Kind::Image { path: path.clone() };
            core.use_::<EditorsModule>().mark_mounted(&path);
            return this;
        }

        // Load the text, then build the editor over it.
        let read = core.use_::<DocumentsModule>().read(&path, ReadRange::default());
        cx.spawn_in(window, async move |this, cx| {
            let result = read.await;
            let r = this.update_in(cx, |this, window, cx| match result {
                Ok(text) => this.loaded(text, window, cx),
                Err(err) => {
                    this.kind = Kind::Error(format!("{err}").into());
                    cx.notify();
                }
            });
            if let Err(e) = r {
                log::warn!("editor host: the view went away before its file loaded: {e:#}");
            }
        })
        .detach();

        // The file changed on disk: adopt it (`useEditorFileSync`).
        let p = path.clone();
        let weak = cx.entity().downgrade();
        let docs = core.use_::<DocumentsModule>();
        let async_cx = cx.to_async();
        this._core_subs.push(core.hooks().on::<FilesChanged, _>(move |event| {
            if !event.paths.iter().any(|x| *x == p) {
                return;
            }
            let (docs, p, weak, async_cx) = (docs.clone(), p.clone(), weak.clone(), async_cx.clone());
            async_cx.clone().spawn(async move |_| {
                if let Ok(text) = docs.read(&p, ReadRange::default()).await {
                    if docs.adopt_external(&p, &text).await {
                        let _ = weak.update(&mut async_cx.clone(), |_, cx| cx.notify());
                    } else if docs.sync(&p).last_markdown().is_none() {
                        // Code viewer: show what is on disk now.
                        let _ = async_cx.update(|cx| {
                            let _ = weak.update(cx, |h, cx| h.reload_code(text, cx));
                        });
                    }
                }
            })
            .detach();
        }));
        this
    }

    fn loaded(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let core = cx.core();
        let docs = core.use_::<DocumentsModule>();
        let sync = docs.sync(&self.path);
        sync.ensure_baseline(&text, Some(&notefig_platform::content_hash(&text)));
        self.cache.borrow_mut().markdown = Some(text.clone());
        match editor_type(&self.path) {
            EditorType::Markdown | EditorType::ReleaseNotes => {
                let scroll = ScrollHandle::new();
                let base_dir = std::path::Path::new(&self.path).parent().map(|p| p.to_path_buf());
                let editor = cx.new(|cx| {
                    let mut state = BlockEditorState::new(window, cx);
                    state.set_scroll_handle(scroll.clone());
                    state.set_image_base_dir(base_dir.clone(), cx);
                    // Pasted/dropped images go to `assets/` next to the
                    // document (the TS rule).
                    let assets = base_dir.clone();
                    state.set_image_asset_target(Some(move || {
                        assets.as_ref().map(|dir| markdown_editor::ImageAssetTarget { dir: dir.join("assets"), src_prefix: "assets/".into() })
                    }));
                    state.set_diff_cards(true, cx);
                    state.set_properties_chip(true, cx);
                    state.set_language_picker(true, cx);
                    state.set_placeholder(Some("Type something, or press / for AI…".into()), cx);
                    state.set_source_async(text.clone(), cx).detach();
                    state
                });
                let panels = crate::panels(cx);
                if let Some(install) = panels.install_node_views {
                    install(&editor, &self.path, window, cx);
                }
                for attach in panels.editor_attachments {
                    if let Some(sub) = attach(&editor, &self.path, window, cx) {
                        self._core_subs.push(sub);
                    }
                }
                let path = self.path.clone();
                let cache = self.cache.clone();
                let sub = cx.subscribe_in(&editor, window, move |this, editor, event, window, cx| match event {
                    BlockEditorEvent::Changed { origin, .. } => {
                        if !origin.is_external() {
                            let snapshot = snapshot_of(editor, &cache, cx);
                            cx.core().use_::<DocumentsModule>().sync(&path).edited(snapshot);
                        }
                        cx.notify();
                    }
                    BlockEditorEvent::SelectionChanged => {
                        cache.borrow_mut().selected = None;
                        cx.notify();
                    }
                    BlockEditorEvent::EditLinkRequested { url } => this.edit_link(url.clone(), window, cx),
                    BlockEditorEvent::LinkClicked { url } => open_link(url, &path, cx),
                    _ => {}
                });
                self.cache.borrow_mut().editor = Some(editor.downgrade());
                let host = cx.entity().downgrade();
                let toolbar = cx.new(|cx| Toolbar::new(editor.clone(), host, window, cx));
                self._subs.push(sub);
                self.kind = Kind::Markdown { editor, toolbar, scroll };
            }
            _ => {
                let lang = notefig_editors::file_extension(&self.path);
                let state = cx.new(|cx| {
                    EditorState::new(window, cx)
                        .line_number(true)
                        .folding(false)
                        // The TS code view draws no indent guides.
                        .indent_guides(false)
                        .language(if lang.is_empty() { "text".to_string() } else { lang })
                        .default_value(text)
                });
                self.kind = Kind::Code { state };
            }
        }
        core.use_::<EditorsModule>().mark_mounted(&self.path);
        // The surface just came up: if this is the tab in front, take focus
        // (an earlier claim landed on the loading placeholder).
        if core.use_::<TabsModule>().active_tab_id().as_deref() == Some(self.path.as_str()) {
            self.focus_editor(window, cx);
        }
        cx.notify();
    }

    fn reload_code(&mut self, text: String, cx: &mut Context<Self>) {
        if let Kind::Code { state } = &self.kind {
            let state = state.clone();
            self.cache.borrow_mut().markdown = Some(text.clone());
            cx.defer_in_window_or_skip(move |window, cx| state.update(cx, |s, cx| s.set_value(text, window, cx)));
        }
    }

    pub(crate) fn editor(&self) -> Option<&Entity<BlockEditorState>> {
        match &self.kind {
            Kind::Markdown { editor, .. } => Some(editor),
            _ => None,
        }
    }

    /// `handleLinkToggle`: ask for the URL (prefilled with the link at the
    /// caret) and set it; an empty answer removes the link.
    pub(crate) fn edit_link(&mut self, current: Option<SharedString>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor().cloned() else { return };
        let rx = crate::dialogs::prompt_text_in(
            notefig_platform::TextPromptOptions {
                title: "Link".into(),
                message: None,
                default_value: current.map(|u| u.to_string()),
                placeholder: Some("https://… or a file path".into()),
                confirm_label: Some("Apply".into()),
            },
            window,
            cx,
        );
        cx.spawn_in(window, async move |_, cx| {
            if let Ok(Some(url)) = rx.await {
                let _ = cx.update(|window, cx| {
                    editor.update(cx, |s, cx| {
                        let url = url.trim();
                        s.set_link(if url.is_empty() { None } else { Some(url) }, cx);
                        s.focus(window, cx);
                    })
                });
            }
        })
        .detach();
    }

    fn focus_editor(&self, window: &mut Window, cx: &mut App) -> bool {
        match &self.kind {
            Kind::Markdown { editor, .. } => {
                editor.clone().update(cx, |s, cx| s.focus(window, cx));
                true
            }
            Kind::Code { state } => {
                let h = state.read(cx).focus_handle(cx);
                window.focus(&h, cx);
                true
            }
            _ => {
                window.focus(&self.focus, cx);
                true
            }
        }
    }
}

trait DeferExt {
    fn defer_in_window_or_skip(&mut self, f: impl FnOnce(&mut Window, &mut App) + 'static);
}

impl DeferExt for Context<'_, EditorHost> {
    fn defer_in_window_or_skip(&mut self, f: impl FnOnce(&mut Window, &mut App) + 'static) {
        let windows = self.windows();
        self.defer(move |cx| {
            if let Some(w) = windows.first() {
                let _ = w.update(cx, |_, window, cx| f(window, cx));
            }
        });
    }
}

/// The live document as markdown, read lazily once per save round.
fn snapshot_of(editor: &Entity<BlockEditorState>, cache: &Rc<RefCell<Cache>>, cx: &mut Context<EditorHost>) -> notefig_documents::Snapshot {
    let weak = editor.downgrade();
    let async_cx = cx.to_async();
    let cache = cache.clone();
    Rc::new(move || {
        let fresh = async_cx.update(|cx| weak.upgrade().map(|e| e.read(cx).source()));
        match fresh {
            Some(s) => {
                cache.borrow_mut().markdown = Some(s.clone());
                s
            }
            None => cache.borrow().markdown.clone().unwrap_or_default(),
        }
    })
}

/// A link was cmd-clicked: an external URL opens in the browser; anything
/// else resolves against the document's folder and opens as a tab.
fn open_link(url: &str, doc_path: &str, cx: &mut App) {
    let core = cx.core();
    if url.contains("://") || url.starts_with("mailto:") {
        core.service::<notefig_platform::PlatformService>().ui.open_external(url);
        return;
    }
    let dir = std::path::Path::new(doc_path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let target = dir.join(url.split('#').next().unwrap_or(url));
    let target = target.to_string_lossy().into_owned();
    core.use_::<TabsModule>().open(&target, notefig_tabs::OpenTabOptions { intent: notefig_layout::OpenFileIntent::NewTab, ..Default::default() });
}

impl Focusable for EditorHost {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        match &self.kind {
            Kind::Markdown { editor, .. } => editor.read(cx).focus_handle(cx),
            Kind::Code { state } => state.read(cx).focus_handle(cx),
            _ => self.focus.clone(),
        }
    }
}

impl Render for EditorHost {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let rtl = cx
            .core()
            .use_::<notefig_workspaces::WorkspacesModule>()
            .workspace_of(&self.path)
            .is_some_and(|ws| crate::shell::is_rtl(&ws, cx));
        // The TS document typography, rebuilt when the appearance or the
        // direction changes.
        if let Kind::Markdown { editor, toolbar, .. } = &self.kind
            && self.prose_dark != Some((t.dark, rtl))
        {
            self.prose_dark = Some((t.dark, rtl));
            toolbar.update(cx, |tb, cx| tb.set_rtl(rtl, cx));
            let prose = crate::prose::prose_style(&t, rtl, cx);
            let body = crate::prose::body_color(&t);
            let caret = t.foreground;
            editor.update(cx, |s, cx| {
                s.set_prose_style(Some(prose), cx);
                let style = s.editor_style().clone().with_foreground(body).with_caret(caret);
                s.set_editor_style(style, cx);
            });
        }
        let (body_size, body_leading) = crate::prose::body(&t);
        let minimap = crate::panels(cx).minimap.and_then(|hook| hook(&self.path, cx));
        match &self.kind {
            Kind::Loading => div().size_full().into_any_element(),
            Kind::Error(msg) => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_size(t.text_sm)
                .text_color(t.muted_foreground)
                .child(msg.clone())
                .into_any_element(),
            Kind::Markdown { editor, toolbar, scroll } => div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(toolbar.clone())
                .child(
                    div()
                        .relative()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_h_0()
                        .child(
                    div()
                        .id("editor-scroll")
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .track_scroll(scroll)
                        .child(
                            div().w_full().flex().justify_center().child(
                                // `prose prose-sm max-w-2xl mx-auto p-4`
                                div()
                                    .w_full()
                                    .max_w(rem(42.))
                                    .min_h_full()
                                    .p(sp(4.))
                                    .text_size(body_size)
                                    .line_height(body_leading)
                                    .text_color(crate::prose::body_color(&t))
                                    // The file's workspace's direction (the TS
                                    // file tab's `dir`): blocks align to their start.
                                    .when(rtl, |d| d.text_right())
                                    .child(BlockEditor::new(editor).min_h_full()),
                            ),
                        ),
                        )
                        // The document minimap, pinned over the scroll viewport.
                        .when_some(minimap, |d, (source, jump)| {
                            let rail = markdown_editor::MinimapRail::new(editor, source);
                            d.child(match jump {
                                Some(jump) => rail.on_jump(jump),
                                None => rail,
                            })
                        }),
                )
                .child(link_bubble(editor, &self.path, cx))
                .into_any_element(),
            Kind::Code { state } => div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .bg(t.background)
                // The TS code view (`@pierre/diffs`): 13px mono on 20px lines,
                // on the page with no surface of its own.
                .pt(sp(1.))
                .child(
                    Editor::new(state)
                        .h_full()
                        .bordered(false)
                        .readonly(true)
                        .bg(gpui::transparent_black())
                        .text_size(gpui::px(13.))
                        .line_height(gpui::px(20.)),
                )
                .into_any_element(),
            Kind::Image { path } => div()
                .id("image-viewer")
                .track_focus(&self.focus)
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_y_scroll()
                .child(
                    div().flex_1().flex().items_center().justify_center().p(sp(4.)).size_full().child(
                        img(std::path::PathBuf::from(path))
                            .max_w_full()
                            .max_h_full()
                            .object_fit(ObjectFit::Contain)
                            .rounded(t.radius_sm),
                    ),
                )
                .into_any_element(),
        }
    }
}

/// `LinkBubbleMenu`: with the caret in a link, its href (opens it), edit
/// and remove. TS floats it at the link; here it sits at the editor's
/// top-right corner (the editor does not expose caret coordinates).
fn link_bubble(editor: &Entity<BlockEditorState>, path: &str, cx: &mut Context<EditorHost>) -> impl IntoElement {
    let t = tokens(cx).clone();
    let Some(href) = editor.read(cx).link_at_caret() else { return div().into_any_element() };
    let external = href.contains("://") || href.starts_with("mailto:");
    let hover_bg = t.muted;
    let fg = t.foreground;
    let btn = move |id: &'static str| {
        div()
            .id(id)
            .flex()
            .items_center()
            .gap(sp(1.))
            .rounded(t.radius_sm)
            .px(sp(2.))
            .py(sp(1.))
            .text_size(t.text_xs)
            .text_color(t.muted_foreground)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg).text_color(fg))
    };
    let (open_href, doc) = (href.to_string(), path.to_string());
    let (e1, e2) = (editor.clone(), editor.clone());
    div()
        .absolute()
        .top(sp(14.))
        .right(sp(4.))
        .flex()
        .items_center()
        .gap(sp(0.5))
        .rounded(t.radius_md)
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .p(sp(1.))
        .shadow_md()
        .child(
            btn("link-open")
                .child(icon(if external { "external-link" } else { "file-text" }).text_color(t.muted_foreground))
                .child(div().max_w(rem(10.)).overflow_hidden().whitespace_nowrap().text_ellipsis().child(href.clone()))
                .on_click(move |_, _, cx| open_link(&open_href, &doc, cx)),
        )
        .child(btn("link-edit").child(icon("link").text_color(t.muted_foreground)).on_click(move |_, _, cx| e1.update(cx, |s, cx| s.request_link_edit(cx))))
        .child(btn("link-remove").child(icon("unlink").text_color(t.muted_foreground)).on_click(move |_, _, cx| e2.update(cx, |s, cx| s.set_link(None, cx))))
        .into_any_element()
}

// ---------------------------------------------------------------------------
// The registry's view of the host.
// ---------------------------------------------------------------------------

struct HostInstance {
    path: String,
    kind: EditorType,
    host: WeakEntity<EditorHost>,
    cx: AsyncApp,
    window: AnyWindowHandle,
    cache: Rc<RefCell<Cache>>,
    editable: Cell<bool>,
    documents: Rc<DocumentsApi>,
    editors: Rc<notefig_editors::EditorsApi>,
}

impl HostInstance {
    /// Run `f` with the host now if the app is free, else on the next turn.
    fn with_host(&self, f: impl FnOnce(&mut EditorHost, &mut Window, &mut Context<EditorHost>) + 'static) -> bool {
        let host = self.host.clone();
        let window = self.window;
        let run = move |cx: &mut App| {
            let _ = window.update(cx, |_, window, cx| {
                let _ = host.update(cx, |h, cx| f(h, window, cx));
            });
        };
        let cx = self.cx.clone();
        // An update from inside another update would panic: always hop.
        cx.clone().spawn(async move |_| {
            let _ = cx.update(run);
        })
        .detach();
        self.host.upgrade().is_some()
    }

    /// The markdown editor and an app handle for futures (polled outside
    /// any update, so they may update).
    fn editor(&self) -> Option<(Entity<BlockEditorState>, AsyncApp)> {
        let e = self.cache.borrow().editor.as_ref()?.upgrade()?;
        Some((e, self.cx.clone()))
    }
}

impl EditorInstance for HostInstance {
    fn editor_type(&self) -> EditorType {
        self.kind
    }

    fn focus(&self, _steal: bool) -> bool {
        self.with_host(|h, window, cx| {
            h.focus_editor(window, cx);
        })
    }

    fn dispose(&self) {
        self.cache.borrow_mut().destroyed = true;
    }

    fn is_focusable(&self) -> bool {
        !self.cache.borrow().destroyed
    }

    fn go_to(&self, target: EditorTarget) -> LocalBoxFuture<'static, bool> {
        let Some((editor, cx)) = self.editor() else { return ready(false).boxed_local() };
        let target = match target {
            EditorTarget::Search(target) => target,
            // A widget block by its id (`data-blob-id`): select it and bring
            // it to the middle of the view.
            EditorTarget::Block { block_id } => {
                return async move {
                    cx.update(|cx| {
                        editor.update(cx, |s, cx| match s.model().find_prompt_widget(&block_id) {
                            Some(block) => s.reveal_block(block, cx),
                            None => false,
                        })
                    })
                }
                .boxed_local();
            }
        };
        async move {
            cx.update(|cx| {
                editor.update(cx, |s, cx| {
                    let n = s.set_search(&target.match_text, true, cx);
                    let ix = target.occurrence as usize;
                    n > ix && s.select_search_match(ix, cx)
                })
            })
        }
        .boxed_local()
    }

    fn selected_text(&self) -> Option<String> {
        self.cache.borrow().selected.clone()
    }

    fn markdown(&self) -> Option<String> {
        if self.kind != EditorType::Markdown {
            return None;
        }
        self.cache.borrow().markdown.clone()
    }

    fn text(&self) -> Option<String> {
        match self.kind {
            EditorType::Image => None,
            _ => self.cache.borrow().markdown.clone(),
        }
    }

    fn set_editable(&self, editable: bool) {
        self.editable.set(editable);
        self.with_host(move |h, _, cx| {
            if let Some(e) = h.editor().cloned() {
                e.update(cx, |s, cx| s.set_readonly(!editable, cx));
            }
        });
    }

    fn is_destroyed(&self) -> bool {
        self.cache.borrow().destroyed || self.host.upgrade().is_none()
    }

    fn adopt(&self, content: String, source: AdoptionSource) -> LocalBoxFuture<'static, Option<Adoption>> {
        let Some((editor, cx)) = self.editor() else { return ready(None).boxed_local() };
        let turn = source.attribute.as_ref().and_then(|a| a(&source.path, &source.content_hash));
        let cache = self.cache.clone();
        async move {
            // A round's write is that round's change (the widget's review
            // tracks it); anything else is an external change.
            let origin = match turn {
                Some(turn) => EditOrigin::Agent {
                    round: cx.update(|cx| crate::panels(cx).round_id_for_turn.map(|f| f(&turn))),
                },
                None => EditOrigin::External,
            };
            let summary = cx
                .update(|cx| editor.update(cx, |s, cx| s.apply_external_source(&content, origin, cx)))
                .map_err(|e| log::error!("external content rejected by the editor: {e}"))
                .ok()?;
            let source = cx.update(|cx| editor.read(cx).source());
            cache.borrow_mut().markdown = Some(source);
            Some(Adoption { reinserted_widgets: summary.reinserted_widgets })
        }
        .boxed_local()
    }
}

impl TabController for HostInstance {
    fn tab_id(&self) -> &str {
        &self.path
    }

    fn kind(&self) -> TabKind {
        TabKind::File
    }

    fn focus(&self, steal: bool) -> bool {
        EditorInstance::focus(self, steal)
    }

    fn is_focusable(&self) -> bool {
        EditorInstance::is_focusable(self)
    }

    fn selected_text(&self) -> Option<String> {
        EditorInstance::selected_text(self)
    }

    /// The tab left the layout: push pending edits, close the document's
    /// sync (a save in flight still lands), forget the instance.
    fn dispose(&self) {
        self.documents.flush(&self.path);
        self.documents.close(&self.path);
        self.editors.unregister(&self.path);
        EditorInstance::dispose(self);
    }

    fn search(&self, query: &str, options: TabSearchOptions) -> LocalBoxFuture<'static, Vec<SearchTarget>> {
        let text = self.markdown().or_else(|| self.cache.borrow().markdown.clone()).unwrap_or_default();
        ready(find_in_text(&text, query, options.case_sensitive)).boxed_local()
    }

    fn reveal_match(&self, target: SearchTarget) -> LocalBoxFuture<'static, bool> {
        self.go_to(EditorTarget::Search(target))
    }

    fn history(&self, redo: bool) -> bool {
        self.with_host(move |h, _, cx| {
            if let Some(e) = h.editor().cloned() {
                e.update(cx, |s, cx| if redo { s.redo(cx) } else { s.undo(cx) });
            }
        })
    }
}

/// Occurrences of `query` in `text`, as search targets (find-in-tab).
pub(crate) fn find_in_text(text: &str, query: &str, case_sensitive: bool) -> Vec<SearchTarget> {
    if query.is_empty() {
        return Vec::new();
    }
    let fold = |s: &str| if case_sensitive { s.to_string() } else { s.to_lowercase() };
    let q = fold(query);
    let mut seen = std::collections::HashMap::<String, u32>::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let l = fold(line);
        let mut from = 0;
        while let Some(i) = l[from..].find(&q) {
            let at = from + i;
            let matched = line.get(at..at + query.len()).unwrap_or(query).to_string();
            let n = seen.entry(fold(&matched)).or_default();
            out.push(SearchTarget { match_text: matched, line_text: line.to_string(), occurrence: *n });
            *n += 1;
            from = at + q.len().max(1);
        }
    }
    out
}

impl Drop for EditorHost {
    fn drop(&mut self) {
        self.cache.borrow_mut().destroyed = true;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_occurrences_per_text() {
        let found = super::find_in_text("Foo bar\nfoo", "foo", false);
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].occurrence, 1);
        assert!(super::find_in_text("Foo", "foo", true).is_empty());
    }
}

