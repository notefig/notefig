//! Views ported from `packages/desktop/src/components/agent/*`.
//!
//! The shell composes them by the contracts in ARCHITECTURE.md:
//! [`SessionsPanel::new`], [`ChatTab::new`], [`prompt_widget_view`] and the
//! [`HarnessSettings`] section. [`init`] registers actions and key bindings.

// Owned by the chat/sessions porter.
mod chat_tab;
mod composer;
mod config_bar;
mod glyph;
mod sessions_panel;
mod session_usage;
mod style;
mod transcript;
mod cards;

// Owned by the settings/widget porter.
mod harness_settings;
mod prompt_widget;

pub use chat_tab::ChatTab;
pub use harness_settings::HarnessSettings;
pub use prompt_widget::prompt_widget_view;
pub use prompt_widget::minimap::prompt_minimap;
pub use prompt_widget::{PromptWidgetHost, PromptWidgetView, prompt_round_id};
pub use harness_settings::harness_logo_element;
pub use sessions_panel::SessionsPanel;
pub use cards::{AuthCard, permission_card};
pub use chat_tab::ChatTab as AgentChatTab;
pub use composer::{Composer, ComposerDrafts, ComposerEvent, is_directive_token, prompt_to_send};
pub use glyph::{AttentionKind, StatusGlyphState, harness_logo, status_glyph, task_glyph_state, turn_glyph_state};
pub use session_usage::{format_cost, format_tokens};
pub use sessions_panel::{JumpTarget, Jumper, TabsJumper, WidgetLocation, jump_to_round, jump_to_task};
pub use transcript::Transcript;

/// Actions and key bindings of every agent view.
pub fn init(cx: &mut gpui::App) {
    chat_tab::init(cx);
    composer::init(cx);
    sessions_panel::init(cx);
    harness_settings::init(cx);
    prompt_widget::init(cx);
}
