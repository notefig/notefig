//! The command palette over an empty window: `NOTEFIG_STATE_DIR=… cargo run
//! -p notefig-view-command-palette --example command_palette --features
//! screenshot -- <workspace>`, then `key:cmd-k`.

#[path = "../../settings/examples/common/harness.rs"]
mod harness;

use gpui::{AppContext as _, Context, IntoElement, Render, Window, div};

struct Empty;
impl Render for Empty {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn main() {
    harness::run(|_, _, cx| {
        notefig_view_command_palette::init(cx);
        cx.new(|_| Empty).into()
    });
}
