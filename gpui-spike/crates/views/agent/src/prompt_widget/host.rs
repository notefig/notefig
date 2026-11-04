//! The editor side of the prompt widget: a port of `prompt-widget-host.tsx`
//! and `prompt-widget-boundary.tsx` (the host the widget reaches the app
//! through) together with the node-view half of `prompt/node-view.tsx` (the
//! "/" summon, the empty-document keeper, the binding to the file marker)
//! and the review gutter of `change-gutter.ts` / `change-navigator.ts`.
//!
//! One [`PromptWidgetHost`] per markdown editor. [`PromptWidgetHost::attach`]
//! installs everything on the editor; the editor's node-view renderer then
//! calls [`super::prompt_widget_view`] for each widget block.
//!
//! Deviations (the Rust editor's API, not TS's ProseMirror plugins):
//! - The keeper's insertion is an ordinary editor step (no UI-only meta),
//!   so it joins the undo history; it never re-inserts after an undo/redo.
//! - A selection summon (a widget quoting the selected passage) is not
//!   ported: the editor's widget node carries no reference.
//! - Refusing to delete a live widget (`interactions.ts`'s transaction
//!   filter) is the editor's `WidgetRemovalGuard`: the editor puts the
//!   widget back and emits `WidgetRemovalRefused`, and the face shakes.

use std::collections::{HashMap, HashSet};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, Subscription, WeakEntity, Window,
};
use markdown_editor::{
    BlockEditorEvent, BlockEditorState, EditOrigin, NodeViewCtx, PromptWidget as WidgetNode, WidgetPlacement,
    new_prompt_widget_id, strip_prompt_markers,
};
use notefig_prompt_widgets::{PromptWidgetsModule, capabilities_of, prompt_change_hue};
use notefig_ui::{CoreExt as _, tokens};

use super::prompt_round_id;
use super::view::{PromptWidgetView, chart_color};

/// The widgets of one editor, and what they need from the app.
pub struct PromptWidgetHost {
    workspace_path: String,
    document_path: String,
    editor: WeakEntity<BlockEditorState>,
    views: HashMap<String, Entity<PromptWidgetView>>,
    /// Widgets made by "/" (Escape on an empty draft reverts to a slash).
    summoned: HashSet<String>,
    /// Focus this widget's draft when it next renders.
    focus_next: Option<String>,
    _subs: Vec<Subscription>,
    _review: notefig_core::Subscription,
    _dots: notefig_core::Subscription,
}

impl PromptWidgetHost {
    /// Install prompt widgets on `editor`: the node-view renderer, the "/"
    /// summon, the empty-document keeper, the review gutter and Escape for
    /// a running round. The host lives as long as the editor's renderer.
    pub fn attach(
        editor: &Entity<BlockEditorState>,
        workspace_path: String,
        document_path: String,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let host = cx.new(|cx| {
            let subs = vec![
                cx.subscribe_in(editor, window, Self::on_editor_event),
                cx.observe_keystrokes(|this: &mut Self, event, window, cx| {
                    if event.keystroke.key == "escape" {
                        this.escape_in_document(window, cx);
                    }
                }),
            ];
            let prompts = cx.core().use_::<PromptWidgetsModule>();
            // The gutter follows the review (which widget is under review).
            let review = on_change(cx, move |notify| prompts.review().subscribe(move || notify()), |this, cx| this.sync_gutter(cx));
            // The minimap rail reads widget phases: redraw the editor (and
            // its rail) when any widget changes.
            let prompts2 = cx.core().use_::<PromptWidgetsModule>();
            let dots = on_change(cx, move |notify| prompts2.subscribe_any(move || notify()), |this, cx| {
                if let Some(editor) = this.editor.upgrade() {
                    editor.update(cx, |_, cx| cx.notify());
                }
            });
            Self {
                workspace_path,
                document_path,
                editor: editor.downgrade(),
                views: HashMap::new(),
                summoned: HashSet::new(),
                focus_next: None,
                _subs: subs,
                _review: review,
                _dots: dots,
            }
        });
        let renderer = host.clone();
        // The deletion veto (TS `restoreKeptWidgetsTr`): a widget whose
        // agent is working can't be deleted by an edit; the editor puts it
        // back and says so (`WidgetRemovalRefused`). Read live on each edit.
        let prompts = cx.core().use_::<PromptWidgetsModule>();
        let guard: markdown_editor::WidgetRemovalGuard =
            std::rc::Rc::new(move |w: &markdown_editor::PromptWidget| !capabilities_of(prompts.get(&w.id).state, false).removable);
        editor.update(cx, |e, _| e.set_widget_removal_guard(Some(guard)));
        editor.update(cx, |e, cx| {
            e.set_node_view_renderer(move |ctx, window, cx| super::prompt_widget_view(&renderer, ctx, window, cx), cx)
        });
        host.update(cx, |h, cx| {
            h.keep(false, cx);
            h.sync_gutter(cx);
        });
        host
    }

    pub fn editor(&self) -> Option<Entity<BlockEditorState>> {
        self.editor.upgrade()
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub fn document_path(&self) -> &str {
        &self.document_path
    }

    /// The document was renamed or moved.
    pub fn set_document_path(&mut self, path: String, cx: &mut Context<Self>) {
        let prompts = cx.core().use_::<PromptWidgetsModule>();
        for id in self.views.keys() {
            prompts.set_document(id, &path);
        }
        self.document_path = path;
    }

    /// Step the review to the next (`forward`) or previous change of the
    /// widget under review in this document (`usePromptChangeNavigation`'s
    /// `step`): the caret moves there and its bar pulses. Returns the index.
    pub fn step_change(&mut self, forward: bool, cx: &mut Context<Self>) -> Option<usize> {
        let prompts = cx.core().use_::<PromptWidgetsModule>();
        let blob = prompts.review().reviewing().filter(|b| self.views.contains_key(b))?;
        let turn = prompts.get(&blob).bound_turn_id.clone()?;
        let editor = self.editor.upgrade()?;
        editor.update(cx, |e, cx| e.step_change(prompt_round_id(&turn), forward, cx))
    }

    pub(crate) fn view_for(
        &mut self,
        widget: &WidgetNode,
        this: WeakEntity<Self>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<PromptWidgetView> {
        let id = widget.id.to_string();
        if let Some(view) = self.views.get(&id) {
            return view.clone();
        }
        let summoned = self.summoned.contains(&id);
        let (ws, doc) = (self.workspace_path.clone(), self.document_path.clone());
        let task = widget.task.as_ref().map(|t| t.to_string());
        let view = cx.new(|cx| PromptWidgetView::new(id.clone(), task, summoned, this, ws, doc, window, cx));
        self.views.insert(id, view.clone());
        view
    }

    pub(crate) fn take_focus_request(&mut self, id: &str) -> bool {
        if self.focus_next.as_deref() == Some(id) {
            self.focus_next = None;
            return true;
        }
        false
    }

    fn on_editor_event(&mut self, editor: &Entity<BlockEditorState>, event: &BlockEditorEvent, _: &mut Window, cx: &mut Context<Self>) {
        match event {
            // "/" in an empty paragraph: a widget in its place, its draft
            // focused.
            BlockEditorEvent::SlashTrigger { block, .. } => {
                let id = new_prompt_widget_id();
                self.summoned.insert(id.to_string());
                self.focus_next = Some(id.to_string());
                let block = *block;
                editor.update(cx, |e, cx| {
                    let _ = e.insert_prompt_widget(WidgetNode { id, task: None }, WidgetPlacement::Replace(block), cx);
                });
            }
            // "/" over a selection: the editor inserted an unbound widget
            // after the selection's block, carrying it as its reference
            // (`model().widget_reference`); focus its draft as for "/".
            BlockEditorEvent::SelectionSummoned { widget, .. } => {
                let id = widget.id.to_string();
                self.summoned.insert(id.clone());
                self.focus_next = Some(id);
                cx.notify();
            }
            // An edit tried to delete a working widget (`refuseRemoval`):
            // the face shakes and says "Stop the agent to remove this prompt".
            BlockEditorEvent::WidgetRemovalRefused { widget, .. } => {
                let prompts = cx.core().use_::<PromptWidgetsModule>();
                prompts.refuse_removal(&widget.id);
                if let Some(view) = self.views.get(widget.id.as_ref()).cloned() {
                    view.update(cx, |_, cx| cx.notify());
                    // The hint stands for its moment, then goes.
                    cx.spawn(async move |_, cx| {
                        cx.background_executor().timer(std::time::Duration::from_millis(1600)).await;
                        let _ = view.update(cx, |_, cx| cx.notify());
                    })
                    .detach();
                }
            }
            BlockEditorEvent::Changed { origin, .. } => {
                // Views of widgets that left the document go with them.
                let live: HashSet<String> = editor.read(cx).model().prompt_widgets().into_iter().map(|(_, w)| w.id.to_string()).collect();
                self.views.retain(|id, _| live.contains(id));
                self.summoned.retain(|id| live.contains(id));
                if !matches!(origin, EditOrigin::Undo | EditOrigin::Redo) {
                    self.keep(true, cx);
                }
            }
            _ => {}
        }
    }

    /// The keeper: a document with no real content always carries one
    /// widget at its start.
    fn keep(&mut self, focus: bool, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else { return };
        let (has_widget, empty, first) = {
            let state = editor.read(cx);
            let model = state.model();
            let empty = strip_prompt_markers(&state.source()).trim().is_empty();
            let first = model.caret().map(|c| c.block);
            (!model.prompt_widgets().is_empty(), empty, first)
        };
        if has_widget || !empty {
            return;
        }
        let id = new_prompt_widget_id();
        if focus {
            self.focus_next = Some(id.to_string());
        }
        editor.update(cx, |e, cx| {
            let placement = first.map(WidgetPlacement::Replace).unwrap_or(WidgetPlacement::Caret);
            let _ = e.insert_prompt_widget(WidgetNode { id, task: None }, placement, cx);
        });
    }

    /// Remove a widget's block, turning it into a paragraph holding `text`
    /// when given. `only_with_content`: leave it in a doc with no real
    /// content (the keeper would only put it back).
    pub(crate) fn remove_widget(&mut self, id: &str, text: Option<&str>, only_with_content: bool, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else { return };
        editor.update(cx, |e, cx| {
            if only_with_content && strip_prompt_markers(&e.source()).trim().is_empty() {
                return;
            }
            if let Some(block) = e.model().find_prompt_widget(id) {
                let _ = e.remove_prompt_widget(block, text, cx);
            }
        });
    }

    /// Escape in the document stops the newest running round among this
    /// document's widgets (`useInFlightEscape`).
    fn escape_in_document(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else { return };
        if !gpui::Focusable::focus_handle(editor.read(cx), cx).is_focused(window) {
            return;
        }
        let prompts = cx.core().use_::<PromptWidgetsModule>();
        let views: Vec<_> = self.views.iter().map(|(id, v)| (id.clone(), v.clone())).collect();
        for (id, view) in views {
            let state = prompts.get(&id).state;
            if capabilities_of(state, false).escape == notefig_prompt_widgets::Escape::Stop && prompts.is_newest_stoppable(&id) {
                view.update(cx, |v, cx| v.stop_from_document(cx));
                return;
            }
        }
    }

    /// The gutter shows the round of the widget under review, in its colour.
    fn sync_gutter(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else { return };
        let prompts = cx.core().use_::<PromptWidgetsModule>();
        let gutter = prompts.review().reviewing().filter(|b| self.views.contains_key(b)).and_then(|blob| {
            let turn = prompts.get(&blob).bound_turn_id.clone()?;
            Some((prompt_round_id(&turn), chart_color(prompt_change_hue(&blob), tokens(cx).dark)))
        });
        editor.update(cx, |e, cx| e.set_change_gutter(gutter, cx));
    }
}

/// Run `f` on the entity whenever `subscribe`'s listener fires (coalesced
/// per turn, as `notefig_ui::observe`), for state that isn't rendered.
fn on_change<V: 'static>(
    cx: &mut Context<V>,
    subscribe: impl FnOnce(std::rc::Rc<dyn Fn()>) -> notefig_core::Subscription,
    f: impl Fn(&mut V, &mut Context<V>) + 'static,
) -> notefig_core::Subscription {
    let (tx, rx) = async_channel::bounded::<()>(1);
    let sub = subscribe(std::rc::Rc::new(move || {
        let _ = tx.try_send(());
    }));
    let task = cx.spawn(async move |this, cx| {
        while rx.recv().await.is_ok() {
            if this.update(cx, |this, cx| f(this, cx)).is_err() {
                break;
            }
        }
    });
    notefig_core::Subscription::join(vec![sub, notefig_core::Subscription::new(move || drop(task))])
}

/// Render one widget block (the editor's node-view renderer).
pub(crate) fn render_widget(host: &Entity<PromptWidgetHost>, ctx: &NodeViewCtx, window: &mut Window, cx: &mut App) -> AnyElement {
    let weak = host.downgrade();
    let view = host.update(cx, |h, cx| h.view_for(&ctx.widget, weak, window, cx));
    let id = ctx.widget.id.to_string();
    let requested = host.update(cx, |h, _| h.take_focus_request(&id));
    // The caret arriving on the widget block from the document enters its
    // field when the field takes typing; otherwise the widget stays
    // selected (`arrowAcrossWidget` / `arrowOntoReadOnlyWidget`).
    let entering = ctx.selected && ctx.editor_focused && {
        let state = cx.core().use_::<PromptWidgetsModule>().get(&id).state;
        capabilities_of(state, false).field_editable
    };
    if requested || entering {
        let draft = view.read(cx).draft.clone();
        window.defer(cx, move |window, cx| draft.update(cx, |d, cx| d.focus(window, cx)));
    }
    view.into_any_element()
}
