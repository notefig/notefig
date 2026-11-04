//! What the user sees while dictating: the TS drew a voice wave and the
//! muted words so far at the caret (`dictation-ghost`, `mountVoiceWave`),
//! and toasted a failure (`dictationFailed`). Until the editor has a
//! decoration API, both live in this small pill, which the shell places
//! over its status bar or editor.

use std::rc::Rc;

use gpui::{
    Context, IntoElement, ParentElement, Render, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use notefig_core::Subscription;
use notefig_dictation::{DictationApi, DictationStatus};
use notefig_ui::{icon, observe, sp, tokens};

use crate::DictationPreview;

const BARS: usize = 5;

pub struct DictationIndicator {
    dictation: Option<Rc<DictationApi>>,
    preview: Option<DictationPreview>,
    _subs: Vec<Subscription>,
    _activation: gpui::Subscription,
}

impl DictationIndicator {
    /// `preview` is the one the window's editor targets write to; `None`
    /// is the one every editor writes to ([`crate::shared_preview`]).
    pub fn new(preview: Option<DictationPreview>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let preview = Some(preview.unwrap_or_else(|| crate::shared_preview(cx)));
        let dictation = crate::dictation(cx);
        let mut subs = Vec::new();
        if let Some(d) = dictation.clone() {
            subs.push(observe(cx, move |notify| d.subscribe(move || notify())));
        }
        if let Some(p) = preview.clone() {
            subs.push(observe(cx, move |notify| p.subscribe(move || notify())));
        }
        // The window going out of focus lets go of the hold key and the warm
        // mic (the TS key tracker on blur, and `visibilitychange`).
        let activation = cx.observe_window_activation(window, |this, window, _| {
            if !window.is_window_active() {
                if let Some(d) = &this.dictation {
                    d.keys_released();
                    d.app_hidden();
                }
            }
        });
        Self { dictation, preview, _subs: subs, _activation: activation }
    }
}

impl Render for DictationIndicator {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(dictation) = &self.dictation else { return div() };
        let state = dictation.state();
        let t = tokens(cx).clone();
        let label = match state.status {
            DictationStatus::Idle => return div(),
            DictationStatus::Starting => "Starting…".to_string(),
            DictationStatus::Listening => "Listening…".to_string(),
            DictationStatus::Finishing => "Finishing…".to_string(),
            DictationStatus::Error => format!("Dictation failed: {}", state.error.clone().unwrap_or_default()),
        };
        let listening = matches!(state.status, DictationStatus::Listening | DictationStatus::Starting);
        if listening {
            // The wave follows the level, which changes with every batch of
            // audio rather than as state: redraw while listening.
            window.request_animation_frame();
        }
        let level = dictation.level();
        let hearing = dictation.hearing();
        let words = self.preview.as_ref().and_then(|p| p.text()).filter(|w| !w.is_empty());
        let error = state.status == DictationStatus::Error;
        div()
            .flex()
            .items_center()
            .gap(sp(2.))
            .px(sp(3.))
            .py(sp(1.5))
            .rounded(t.radius_lg)
            .border_1()
            .border_color(t.border)
            .bg(t.popover)
            .shadow_sm()
            .text_size(t.text_xs)
            .text_color(if error { t.destructive } else { t.muted_foreground })
            .child(icon(if error { "mic-off" } else { "mic" }).text_color(if error { t.destructive } else { t.foreground }))
            .when(listening, |el| {
                el.child(div().flex().items_center().gap(px(2.)).h(sp(4.)).children((0..BARS).map(|i| {
                    // A still, low wave until sound arrives; then bars by level,
                    // tallest in the middle.
                    let shape = 1.0 - ((i as f32 - 2.0).abs() / 3.0);
                    let height = if hearing { 3.0 + 13.0 * level * shape } else { 3.0 };
                    div().w(px(2.)).h(px(height)).rounded(px(1.)).bg(t.foreground)
                })))
            })
            .child(div().child(words.unwrap_or(label)).max_w(px(420.)).truncate())
    }
}
