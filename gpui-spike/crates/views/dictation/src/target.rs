//! A markdown editor as a dictation target — the GPUI form of
//! `packages/widgets/src/dictation/extension.ts`'s `createTarget`.
//!
//! The dictation's spot is captured at key down (`capture_selection`) and
//! the final text replaces it in one edit, so one undo removes the whole
//! dictation. The text is fitted against what's before the caret
//! (`caret_prefix`).
//!
//! The words so far draw as the editor's ghost text at the caret
//! (`set_ghost_text`, TS's ghost decoration) and also go to a
//! [`DictationPreview`] (the [`crate::DictationIndicator`] shows the wave).
//! The final text is fitted between `caret_prefix` and `caret_suffix`.
//!
//! DIVERGENCE: the TS mapped the ghost's spot through edits made meanwhile.
//! A captured range goes stale on any edit instead; then the text lands at
//! the caret (what the TS did when the spot itself went away).

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{AnyWindowHandle, App, AsyncApp, Focusable, WeakEntity};
use markdown_editor::{BlockEditorState, CapturedRange};
use notefig_core::{Listeners, Subscription};
use notefig_dictation::{DictationInsertion, DictationTarget, fit_dictation};

/// The words heard so far in the dictation in progress, observable.
#[derive(Clone, Default)]
pub struct DictationPreview {
    text: Rc<RefCell<Option<String>>>,
    changed: Listeners<()>,
}

impl DictationPreview {
    pub fn new() -> Self {
        Self::default()
    }
    /// `None` while nobody dictates.
    pub fn text(&self) -> Option<String> {
        self.text.borrow().clone()
    }
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }
    fn set(&self, text: Option<String>) {
        *self.text.borrow_mut() = text;
        self.changed.emit();
    }
}

/// Attach with `core.dictation.attach(Rc::new(EditorDictationTarget::new(…)))`
/// from the view hosting the editor, and keep the subscription with it.
pub struct EditorDictationTarget {
    editor: WeakEntity<BlockEditorState>,
    window: AnyWindowHandle,
    cx: AsyncApp,
    preview: DictationPreview,
}

impl EditorDictationTarget {
    pub fn new(editor: WeakEntity<BlockEditorState>, window: AnyWindowHandle, preview: DictationPreview, cx: &App) -> Self {
        Self { editor, window, cx: cx.to_async(), preview }
    }
}

impl DictationTarget for EditorDictationTarget {
    fn has_focus(&self) -> bool {
        let Some(editor) = self.editor.upgrade() else { return false };
        self.cx.update(|cx| {
            self.window
                .update(cx, |_, window, cx| editor.read(cx).focus_handle(cx).contains_focused(window, cx))
                .unwrap_or(false)
        })
    }

    fn begin(&self) -> Option<Rc<dyn DictationInsertion>> {
        let editor = self.editor.upgrade()?;
        let range = self.cx.update(|cx| {
            let state = editor.read(cx);
            if state.is_readonly() { None } else { state.capture_selection().ok() }
        })?;
        self.preview.set(Some(String::new()));
        Some(Rc::new(EditorInsertion {
            editor: self.editor.clone(),
            cx: self.cx.clone(),
            range: RefCell::new(range),
            preview: self.preview.clone(),
        }))
    }
}

struct EditorInsertion {
    editor: WeakEntity<BlockEditorState>,
    cx: AsyncApp,
    range: RefCell<CapturedRange>,
    preview: DictationPreview,
}

impl EditorInsertion {
    /// Show (or clear) the ghost on the next turn: insertions are called
    /// from inside keystroke handlers, where the editor may be borrowed.
    fn ghost(&self, text: Option<String>) {
        let editor = self.editor.clone();
        self.cx
            .spawn(async move |cx| {
                let _ = editor.update(cx, |state, cx| state.set_ghost_text(text.map(Into::into), cx));
            })
            .detach();
    }
}

impl DictationInsertion for EditorInsertion {
    fn preview(&self, text: &str) {
        self.preview.set(Some(text.to_string()));
        self.ghost(Some(text.to_string()).filter(|t| !t.is_empty()));
    }

    fn commit(&self, text: &str) {
        self.preview.set(None);
        self.ghost(None);
        let Some(editor) = self.editor.upgrade() else { return };
        let mut range = self.range.borrow_mut();
        self.cx.update(|cx| {
            editor.update(cx, |state, cx| {
                // Edited meanwhile: land at the caret instead.
                if !state.is_capture_current(&range) {
                    match state.capture_selection() {
                        Ok(fresh) => *range = fresh,
                        Err(_) => return,
                    }
                }
                let before = state.caret_prefix().unwrap_or("").to_string();
                let after = state.caret_suffix().unwrap_or("").to_string();
                let fitted = fit_dictation(&before, &after, text);
                if fitted.is_empty() {
                    return;
                }
                if let Err(err) = state.replace_captured(&mut range, &fitted, cx) {
                    log::warn!("dictation: inserting failed: {err:?}");
                }
                state.reveal_caret(cx);
            })
        });
    }

    /// Drops the words so far; never touches the document (and so is safe
    /// to call from inside a keystroke handler).
    fn cancel(&self) {
        self.preview.set(None);
        self.ghost(None);
    }
}
