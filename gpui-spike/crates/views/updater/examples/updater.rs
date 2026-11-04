//! Every updater button face, the toasts and the release notes over a core:
//! `cargo run -p notefig-view-updater --example updater --features screenshot`,
//! driven by `NOTEFIG_SCRIPT`. `NOTES=<file.md>` shows that file as the notes
//! (this crate bundles none for its own version).

use std::rc::Rc;

use gpui::{
    AppContext as _, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowBounds,
    WindowOptions, div, px, size,
};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;
use notefig_ui::{CoreGlobal, GpuiExecutor, NotefigAssets, tokens};
use notefig_updater::{
    AppUpdaterView, UpdateFlow, UpdateInfo, UpdateNotice, UpdateProgress, UpdaterModule, UpdaterStatus, release_notes,
};
use notefig_view_updater::{ReleaseNotesView, UpdateToasts, UpdaterButton, updater_button_face};

struct Host {
    live: Entity<UpdaterButton>,
    toasts: Entity<UpdateToasts>,
    notes: Entity<ReleaseNotesView>,
}

fn face(status: UpdaterStatus, flow: UpdateFlow, progress: Option<(u64, u64)>) -> AppUpdaterView {
    AppUpdaterView {
        status,
        progress: progress.map(|(d, t)| UpdateProgress { downloaded: d, total: Some(t) }).unwrap_or_default(),
        error: None,
        update_info: Some(UpdateInfo { version: "0.0.153".into(), body: None }),
        flow,
    }
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        let faces = [
            ("idle", face(UpdaterStatus::Idle, UpdateFlow::DownloadRestart, None)),
            ("checking", face(UpdaterStatus::Checking, UpdateFlow::DownloadRestart, None)),
            ("up-to-date", face(UpdaterStatus::UpToDate, UpdateFlow::DownloadRestart, None)),
            ("error", face(UpdaterStatus::Error, UpdateFlow::DownloadRestart, None)),
            ("available", face(UpdaterStatus::Available, UpdateFlow::DownloadRestart, None)),
            ("available (refresh)", face(UpdaterStatus::Available, UpdateFlow::Refresh, None)),
            ("downloading", face(UpdaterStatus::Downloading, UpdateFlow::DownloadRestart, Some((42, 100)))),
            ("ready", face(UpdaterStatus::Ready, UpdateFlow::DownloadRestart, None)),
        ];
        div()
            .size_full()
            .relative()
            .flex()
            .bg(t.background)
            .text_color(t.foreground)
            .child(
                div()
                    .w(px(300.))
                    .flex_none()
                    .p(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(div().text_size(t.text_xs).text_color(t.muted_foreground).child("live (NoopUpdater)"))
                    .child(self.live.clone())
                    .children(faces.into_iter().map(|(label, view)| {
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(div().text_size(t.text_xs).text_color(t.muted_foreground).child(label))
                            .child(updater_button_face(&view, None, cx))
                    })),
            )
            .child(div().flex_1().min_w_0().overflow_hidden().h_full().border_l_1().border_color(t.border).child(self.notes.clone()))
            .child(self.toasts.clone())
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
                .modules(vec![ModuleRef::of::<UpdaterModule>()]),
        )
        .expect("core");
        core.boot();
        let updater = core.use_::<UpdaterModule>();
        cx.set_global(CoreGlobal(core));
        notefig_view_updater::init(cx);
        // The toasts the TS app showed, all at once.
        for notice in [
            UpdateNotice::Available { version: "0.0.153".into(), flow: UpdateFlow::DownloadRestart },
            UpdateNotice::Downloading,
            UpdateNotice::ReadyToRestart,
        ] {
            updater.push_notice(notice);
        }
        let notes = std::env::var("NOTES").ok().and_then(|p| std::fs::read_to_string(p).ok());
        let bounds = Bounds::centered(None, size(px(1100.), px(720.)), cx);
        let window = gpui_kit::open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            cx,
            |window, cx| {
                let live = cx.new(|cx| UpdaterButton::new(window, cx));
                let toasts = cx.new(|cx| UpdateToasts::new(window, cx));
                let notes = cx.new(|cx| match notes {
                    Some(md) => ReleaseNotesView::with_notes(release_notes(&md, "0.0.152"), window, cx),
                    None => ReleaseNotesView::new(window, cx),
                });
                cx.new(|_| Host { live, toasts, notes })
            },
        )
        .expect("window");
        notefig_ui::driver::run_from_env(window.0, cx);
        let _ = Rc::new(());
    });
}
