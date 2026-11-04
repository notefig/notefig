//! The Search tab in a sidebar-sized card:
//! `NOTEFIG_STATE_DIR=… cargo run -p notefig-view-search --example search
//! --features screenshot -- <workspace>`.

#[path = "../../settings/examples/common/harness.rs"]
mod harness;

use gpui::{AppContext as _, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div, px};
use notefig_ui::{CoreExt, card, sp};
use notefig_view_search::{SearchPanel, SearchPanelEvent};

struct Sidebar {
    panel: Entity<SearchPanel>,
    last: Option<String>,
    _sub: gpui::Subscription,
}

impl Render for Sidebar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .p(sp(2.))
            .flex()
            .gap(sp(2.))
            .child(card(cx).w(px(345.)).h_full().pt(sp(2.)).child(self.panel.clone()))
            .child(div().flex_1().p(sp(4.)).child(self.last.clone().unwrap_or_default()))
    }
}

fn main() {
    harness::run(|ws, window, cx| {
        let ws = cx.core().workspace(&ws.expect("pass a workspace folder"));
        let panel = cx.new(|cx| SearchPanel::new(ws, window, cx));
        let view = cx.new(|cx| {
            let sub = cx.subscribe(&panel, |this: &mut Sidebar, _, e: &SearchPanelEvent, cx| {
                let SearchPanelEvent::OpenMatch { m, new_tab } = e;
                this.last = Some(format!("open {}:{} (new tab: {new_tab})", m.file_path, m.line));
                cx.notify();
            });
            Sidebar { panel: panel.clone(), last: None, _sub: sub }
        });
        panel.update(cx, |p, cx| p.focus_input(None, None, window, cx));
        view.into()
    });
}
