//! GPUI glue shared by every view crate (the role `@notefig/core/react` and
//! `components/ui` play in the TS app):
//!
//! - [`GpuiExecutor`]: core's executor on GPUI's.
//! - [`CoreGlobal`] / [`CoreExt::core`]: the app's core, reachable from any
//!   view (`useCore()`).
//! - [`observe`]: re-render a view when module state it reads changes.
//! - [`theme`]: the design tokens of `styles.css` ([`tokens`], [`rem`],
//!   [`sp`]), fonts, light/dark.
//! - [`primitives`]: the chrome's building blocks ([`card`], [`icon`],
//!   [`IconButton`], [`TabStripTab`], [`list_row`], [`section_header`],
//!   [`kbd`], [`separator`]).
//! - [`NotefigAssets`]: the asset source (the logo and every Lucide icon).
//! - [`driver`]: `NOTEFIG_SCRIPT` — scripted keystrokes, clicks, actions and
//!   screenshots, so a view can be checked by eye from a terminal.
//!
//! Call [`init`] once at startup and register [`NotefigAssets`] on the
//! application (`gpui_kit::application().with_assets(NotefigAssets)`).

mod assets;
mod bridge;
pub mod driver;
pub mod primitives;
pub mod theme;

pub use assets::NotefigAssets;
pub use bridge::{CoreExt, CoreGlobal, GpuiExecutor, observe};
pub use primitives::{
    ButtonStyle, IconButton, TabStripTab, card, icon, icon_colored, kbd, list_row, section_header, separator,
};
pub use theme::{Tokens, is_dark, rem, set_appearance, sp, tokens};

/// gpui-kit's components plus the Notefig theme and fonts. Views' own
/// `init`s run after this.
pub fn init(cx: &mut gpui::App) {
    gpui_kit::component::init(cx);
    theme::init(cx);
}
