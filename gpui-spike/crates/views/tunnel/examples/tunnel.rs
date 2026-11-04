//! The pair dialog and status pill over a core whose tunnel talks to an
//! in-memory fake worker:
//! `cargo run -p notefig-view-tunnel --example tunnel --features screenshot`.
//! `TUNNEL=form|connected|deeplink` picks the opening state; drive the rest
//! with `NOTEFIG_SCRIPT`. `NOTEFIG_THEME=light` for the light theme.

use gpui::{
    AppContext as _, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowBounds,
    WindowOptions, div, px, size,
};
use notefig_core::{Core, CreateCoreOptions, ExecutorExt, ModuleRef, Services};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;
use notefig_tunnel::TunnelModule;
use notefig_tunnel::testing::{FakeWorker, FakeWorkerOptions};
use notefig_ui::{CoreGlobal, GpuiExecutor, NotefigAssets, tokens};
use notefig_view_tunnel::{PairDialog, TunnelStatus};

struct Host {
    status: Entity<TunnelStatus>,
    dialog: Entity<PairDialog>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(t.background)
            .text_color(t.foreground)
            .child(div().flex_1().p(px(24.)).text_size(t.text_sm).text_color(t.muted_foreground).child("workspace"))
            .child(
                div()
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .justify_end()
                    .px(px(12.))
                    .border_t_1()
                    .border_color(t.border)
                    .child(self.status.clone()),
            )
            .child(self.dialog.clone())
    }
}

fn main() {
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        let dark = std::env::var("NOTEFIG_THEME").map(|v| v != "light").unwrap_or(true);
        notefig_ui::set_appearance(Some(dark), None, cx);
        let fake = FakePlatform::new();
        let core = Core::new(
            CreateCoreOptions::new(GpuiExecutor::new(cx))
                .services(Services::new().with::<PlatformService>(fake.platform.clone()))
                .modules(vec![ModuleRef::of::<TunnelModule>()]),
        )
        .expect("core");
        core.boot();
        let tunnel = core.use_::<TunnelModule>();
        let worker = FakeWorker::new(FakeWorkerOptions {
            worker_name: "studio-mac".into(),
            workspace_path: "/Users/parsa/Documents/book".into(),
            ..Default::default()
        });
        tunnel.connection().set_socket_factory(worker.socket_factory());
        match std::env::var("TUNNEL").as_deref() {
            Ok("connected") => {
                let connecting = tunnel.connect(&worker.code());
                core.executor().spawn_local(async move {
                    let _ = connecting.await;
                });
            }
            Ok("deeplink") => {
                tunnel.dialog().open_from_link(&format!("notefig://pair#{}", worker.code()));
            }
            Ok("form") => tunnel.dialog().open(None),
            _ => {}
        }
        // Printed so a script can paste it.
        eprintln!("pairing code: {}", worker.code());
        cx.set_global(CoreGlobal(core));
        notefig_view_tunnel::init(cx);
        let headless = std::env::var_os("NOTEFIG_HEADLESS").is_some_and(|v| !v.is_empty() && v != "0");
        let bounds = Bounds::centered(None, size(px(900.), px(720.)), cx);
        let window = gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                // NOTEFIG_HEADLESS=1: rendered for `shot:`, never shown.
                show: !headless,
                focus: !headless,
                ..Default::default()
            },
            cx,
            |window, cx| {
                let status = cx.new(|cx| TunnelStatus::always(window, cx));
                let dialog = cx.new(|cx| PairDialog::new(window, cx));
                cx.new(|_| Host { status, dialog })
            },
        )
        .expect("window");
        notefig_ui::driver::run_from_env(window.0, cx);
        std::mem::forget(worker);
    });
}
