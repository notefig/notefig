//! The Usage views: a port of `components/agent/usage-settings.tsx`,
//! `usage-bar-chart.tsx`, `usage-area-chart.tsx`, `usage-radar-chart.tsx`
//! and `session-usage.tsx`.
//!
//! - [`UsageSettings`]: Settings → Usage, the section the settings dialog
//!   composes (`init` registers it as `"usage"`).
//! - [`SessionUsageChip`] / [`TurnUsageLabel`] / [`session_usage_details`]:
//!   the chat's readouts, for the agent view to place.
//! - [`charts`]: the three charts, drawn with GPUI quads and paths.

pub mod charts;
mod format;
mod model;
mod session;
mod settings;

pub use format::{Locale, format_cost, format_tokens};
pub use session::{SessionUsageChip, TurnUsageLabel, session_usage_details};
pub use settings::{UsageControls, UsageSettings};

use gpui::AppContext as _;

/// Registers the Usage section with the settings dialog, its controls in
/// the section's title row (TS `SettingsSectionActions`).
pub fn init(cx: &mut gpui::App) {
    notefig_view_settings::register_section_actions(cx, "usage", |_, cx| UsageControls::for_title_row(cx).into());
    notefig_view_settings::register_section(cx, "usage", |window, cx| {
        cx.new(|cx| UsageSettings::new(window, cx)).into()
    });
}
