//! The feedback dialog (`modules/feedback/react.tsx`): one per window,
//! following `core.feedback`'s open state. Nothing in builds without a
//! support URL, which is every build of this port, so the hotkey and the
//! Settings row are inert. The form is ported and sends through the module
//! (which, unavailable, never sends).
//!
//! Differs from TS: the message editor is a plain multi-line input, not the
//! TipTap editor. A pasted screenshot goes into the draft as `![](blob:N)`
//! (the module's object URL) and shows in a strip of thumbnails under the
//! text, instead of inline.

use gpui::{
    AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled,
    Subscription, Window, div, prelude::FluentBuilder as _,
};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use notefig_feedback::{DraftImage, FeedbackApi, FeedbackInput, FeedbackModule, FeedbackResult, MAX_IMAGES, MAX_MESSAGE, message_length};
use notefig_i18n::t_args;
use notefig_i18n::t;
use notefig_ui::{CoreExt, observe, rem, sp, tokens};
use std::rc::Rc;
use std::sync::Arc;

use crate::widgets::{Button, ButtonVariant, checkbox};

#[derive(Clone, Copy, PartialEq)]
enum Status {
    Idle,
    Sending,
    RateLimited,
    Failed,
}

pub struct FeedbackForm {
    feedback: Rc<FeedbackApi>,
    /// The pasted images by their draft URL, for the thumbnails.
    images: Rc<std::cell::RefCell<Vec<(String, Arc<gpui::Image>)>>>,
    too_many_images: Rc<std::cell::Cell<bool>>,
    message: Entity<TextareaState>,
    include_debug: bool,
    status: Status,
    _subs: Vec<Subscription>,
    _core_subs: Vec<notefig_core::Subscription>,
}

impl FeedbackForm {
    pub fn new(feedback: Rc<FeedbackApi>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let message = cx.new(|cx| TextareaState::new(window, cx).placeholder(t("feedbackPlaceholder")).auto_grow(4, 12));
        let subs = vec![cx.subscribe(&message, |this: &mut Self, _, _: &InputEvent, cx| {
            this.too_many_images.set(false);
            cx.notify()
        })];
        let f = feedback.clone();
        let core_subs = vec![observe(cx, move |notify| f.subscribe(move || notify()))];
        message.update(cx, |m, cx| m.focus(window, cx));
        Self {
            feedback,
            images: Rc::default(),
            too_many_images: Rc::default(),
            message,
            include_debug: false,
            status: Status::Idle,
            _subs: subs,
            _core_subs: core_subs,
        }
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.message.read(cx).value().to_string();
        let debug_report = self.include_debug.then(|| crate::debug_panel::debug_report(cx));
        self.status = Status::Sending;
        self.feedback.close();
        window.close_dialog(cx);
        let send = self.feedback.send(FeedbackInput { message: text, debug_report });
        let feedback = self.feedback.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = send.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    FeedbackResult::Sent => {
                        this.status = Status::Idle;
                        this.message.update(cx, |m, cx| m.set_value("", window, cx));
                    }
                    FeedbackResult::RateLimited => this.status = Status::RateLimited,
                    FeedbackResult::Failed => this.status = Status::Failed,
                }
                if result != FeedbackResult::Sent {
                    feedback.open();
                    show(cx.entity(), window, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for FeedbackForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tk = tokens(cx).clone();
        let text = self.message.read(cx).value().to_string();
        let sending = self.status == Status::Sending;
        let too_long = message_length(&text) > MAX_MESSAGE;
        let error = if too_long {
            Some(t("feedbackTooLong"))
        } else if self.too_many_images.get() {
            Some(t_args("feedbackTooManyImages", &[("count", &MAX_IMAGES.to_string())]))
        } else {
            match self.status {
                Status::Failed => Some(t("feedbackFailed")),
                Status::RateLimited => Some(t("feedbackRateLimited")),
                _ => None,
            }
        };
        let can_send = !too_long && !text.trim().is_empty();
        let entity = cx.entity();
        let include = self.include_debug;
        div()
            .flex()
            .flex_col()
            .gap(sp(3.))
            .child(div().text_size(tk.text_base).font_weight(FontWeight::SEMIBOLD).child(t("sendFeedback")))
            .child(Textarea::new(&self.message).on_paste({
                let feedback = self.feedback.clone();
                let images = self.images.clone();
                let too_many = self.too_many_images.clone();
                let message = self.message.clone();
                move |item, window, cx| {
                    let pasted: Vec<gpui::Image> = item
                        .entries()
                        .iter()
                        .filter_map(|e| match e {
                            gpui::ClipboardEntry::Image(img) => Some(img.clone()),
                            _ => None,
                        })
                        .collect();
                    if pasted.is_empty() {
                        return false;
                    }
                    let draft = message.read(cx).value().to_string();
                    for img in pasted {
                        let shown = images.borrow().iter().filter(|(url, _)| draft.contains(url.as_str())).count();
                        if shown >= MAX_IMAGES {
                            too_many.set(true);
                            break;
                        }
                        let url = feedback.add_image(DraftImage { mime: img.format.mime_type().to_string(), bytes: img.bytes.clone() });
                        images.borrow_mut().push((url.clone(), Arc::new(img)));
                        message.update(cx, |m, cx| m.insert(format!("![]({url})"), window, cx));
                    }
                    true
                }
            }))
            .children({
                // The images the draft still shows.
                let shown: Vec<_> = self.images.borrow().iter().filter(|(url, _)| text.contains(url.as_str())).cloned().collect();
                (!shown.is_empty()).then(|| {
                    div().flex().gap(sp(2.)).children(shown.into_iter().map(|(_, image)| {
                        div()
                            .size(rem(4.))
                            .rounded(tk.radius_md)
                            .border_1()
                            .border_color(tk.border)
                            .overflow_hidden()
                            .child({ use gpui::StyledImage as _; gpui::img(image).size_full().object_fit(gpui::ObjectFit::Cover) })
                    }))
                })
            })
            .when_some(error, |d, e| d.child(div().text_size(rem(0.6875)).text_color(tk.destructive).child(e)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(sp(3.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(sp(2.))
                            .text_size(tk.text_xs)
                            .child(checkbox(
                                "feedback-include-debug",
                                include,
                                sending,
                                {
                                    let e = entity.clone();
                                    move |v, _, cx| e.update(cx, |this, cx| {
                                        this.include_debug = v;
                                        cx.notify();
                                    })
                                },
                                cx,
                            ))
                            .child(t("feedbackIncludeDebug")),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(sp(2.))
                            .child(
                                Button::new("feedback-cancel", t("cancel"))
                                    .variant(ButtonVariant::Ghost)
                                    .compact()
                                    .on_click({
                                        let f = self.feedback.clone();
                                        move |_, window, cx| {
                                            f.close();
                                            window.close_dialog(cx);
                                        }
                                    })
                                    .render(cx),
                            )
                            .child(
                                Button::new("feedback-send", t(if sending { "feedbackSending" } else { "send" }))
                                    .variant(ButtonVariant::Primary)
                                    .compact()
                                    .disabled(sending || !can_send)
                                    .on_click(move |_, window, cx| entity.update(cx, |this, cx| this.send(window, cx)))
                                    .render(cx),
                            ),
                    ),
            )
    }
}

struct FeedbackForms(std::collections::HashMap<gpui::WindowId, Entity<FeedbackForm>>);
impl gpui::Global for FeedbackForms {}

fn show(form: Entity<FeedbackForm>, window: &mut Window, cx: &mut gpui::App) {
    let feedback = form.read(cx).feedback.clone();
    window.open_dialog(cx, move |dialog, _, _| {
        let f = feedback.clone();
        dialog.w(rem(36.)).p(sp(5.)).close_button(true).on_close(move |_, _, _| f.close()).child(form.clone())
    });
}

/// Open the feedback dialog (the palette's "Send Feedback", Settings). A
/// no-op where the module is unavailable. The draft survives a close.
pub fn open_feedback(window: &mut Window, cx: &mut gpui::App) {
    let Some(feedback) = cx.core().try_use::<FeedbackModule>() else { return };
    if !feedback.available() {
        return;
    }
    feedback.open();
    let id = window.window_handle().window_id();
    let existing = cx.try_global::<FeedbackForms>().and_then(|f| f.0.get(&id).cloned());
    let form = match existing {
        Some(form) => form,
        None => {
            let form = cx.new(|cx| FeedbackForm::new(feedback.clone(), window, cx));
            if !cx.has_global::<FeedbackForms>() {
                cx.set_global(FeedbackForms(Default::default()));
            }
            cx.global_mut::<FeedbackForms>().0.insert(id, form.clone());
            form
        }
    };
    show(form, window, cx);
}

/// ⌘⇧M.
pub fn toggle_feedback(window: &mut Window, cx: &mut gpui::App) {
    let Some(feedback) = cx.core().try_use::<FeedbackModule>() else { return };
    if feedback.is_open() {
        feedback.close();
        window.close_dialog(cx);
    } else {
        open_feedback(window, cx);
    }
}
