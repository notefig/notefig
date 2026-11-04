//! Feedback — `core.use_::<FeedbackModule>()`: whether the "Send Feedback"
//! dialog is open, and the send to the support Worker. A port of
//! `packages/desktop/src/modules/feedback/`.
//!
//! Every way in (the command palette, the hotkey, Settings) calls `open()`;
//! the one dialog follows `is_open()`. Builds without a support URL are
//! `available() == false` and offer no way in.
//!
//! **This port never sends.** The module registers with no support URL and
//! no transport, so it is unavailable and `send` resolves to `Failed`
//! without touching the network. The send path (multipart body, images as
//! `attachment:<id>`, timeout, 429 → rate-limited) is ported behind the
//! [`FeedbackTransport`] seam so its tests run over a recording transport.

mod feedback;
mod images;

pub use feedback::{
    DraftImage, FeedbackApi, FeedbackInput, FeedbackOptions, FeedbackResult, FeedbackTransport,
    OutgoingFeedback, create_feedback,
};
pub use images::{MAX_IMAGES, message_length};

use notefig_core::{Module, ModuleContext};

/// The hotkey that toggles the dialog (`FEEDBACK_HOTKEY`).
pub const FEEDBACK_HOTKEY: &str = "cmd-shift-m";
/// What the Worker accepts (`MAX_MESSAGE` in `react.tsx`).
pub const MAX_MESSAGE: usize = 5000;

/// `feedbackModule`.
pub struct FeedbackModule;

impl Module for FeedbackModule {
    const NAME: &'static str = "feedback";
    type Api = FeedbackApi;
    type Workspace = ();

    fn register(ctx: &ModuleContext) -> FeedbackApi {
        // No support URL in this build (TS: `VITE_SUPPORT_URL || undefined`).
        create_feedback(FeedbackOptions { support_url: None, transport: None, ..FeedbackOptions::new(ctx.executor()) })
    }
}

#[cfg(test)]
mod tests;
