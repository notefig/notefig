//! The Git tab alone over a core: `cargo run -p notefig-view-git --example
//! git --features screenshot -- <workspace>`, driven by `NOTEFIG_SCRIPT`.

use std::rc::Rc;

use gpui::{AppContext as _, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowBounds, WindowOptions, div, px, size};
use notefig_core::{Core, CreateCoreOptions, ModuleRef};
use notefig_git::GitModule;
use notefig_history_module::HistoryModule;
use notefig_ui::{CoreExt as _, CoreGlobal, GpuiExecutor, NotefigAssets, tokens};
use notefig_view_git::GitPanel;

struct Host {
    panel: Entity<GitPanel>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        // The sidebar card the shell gives the tab.
        div().size_full().bg(t.background).p(px(8.)).child(
            notefig_ui::card(cx).size_full().flex().flex_col().overflow_hidden().child(self.panel.clone()),
        )
    }
}

fn main() {
    let ws = std::env::args().nth(1).expect("usage: git <workspace>");
    let ws = std::fs::canonicalize(&ws).map(|p| p.to_string_lossy().into_owned()).unwrap_or(ws);
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        let dark = std::env::var("NOTEFIG_THEME").map(|v| v != "light").unwrap_or(true);
        notefig_ui::set_appearance(Some(dark), None, cx);
        let core = Core::new(
            CreateCoreOptions::new(GpuiExecutor::new(cx))
                .modules(vec![ModuleRef::of::<HistoryModule>(), ModuleRef::of::<GitModule>()]),
        )
        .expect("core");
        core.boot();
        cx.set_global(CoreGlobal(core));
        notefig_view_git::init(cx);
        let open = cx.core().workspace(&ws).open();
        let ws2 = ws.clone();
        cx.spawn(async move |cx| {
            open.await.expect("open workspace");
            cx.update(|cx| {
                let bounds = Bounds::centered(None, size(px(std::env::var("NOTEFIG_W").ok().and_then(|w| w.parse().ok()).unwrap_or(360.)), px(640.)), cx);
                let window = gpui_kit::open_window(
                    {
                        // `NOTEFIG_HEADLESS=1`: never shown or focused; `shot:` still renders.
                        let headless = std::env::var_os("NOTEFIG_HEADLESS").is_some();
                        WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), show: !headless, focus: !headless, ..Default::default() }
                    },
                    cx,
                    |window, cx| {
                        let handle = cx.core().workspace(&ws2);
                        let panel = cx.new(|cx| GitPanel::new(handle, window, cx));
                        cx.new(|_| Host { panel })
                    },
                )
                .expect("window");
                notefig_ui::driver::run_from_env(window.0, cx);
            })
        })
        .detach();
        let _ = Rc::new(());
    });
}
