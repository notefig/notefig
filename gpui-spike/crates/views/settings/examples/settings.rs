//! The Settings dialog over an empty window: `NOTEFIG_STATE_DIR=… cargo run
//! -p notefig-view-settings --example settings --features screenshot -- <ws>`
//! then `action:settings::OpenSettings` (or `key:cmd-shift-,`).

#[path = "common/harness.rs"]
mod harness;

use gpui::{AppContext as _, Context, IntoElement, Render, Window, div};

struct Empty;
impl Render for Empty {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn main() {
    harness::run(|_, window, cx| {
        let section = std::env::var("SETTINGS_SECTION").ok();
        let view = cx.new(|_| Empty);
        window.defer(cx, move |window, cx| notefig_view_settings::open_settings(section.as_deref(), window, cx));
        view.into()
    });
}
