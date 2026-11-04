//! The Files tool alone over a core with the native platform:
//! `NOTEFIG_STATE_DIR=… cargo run -p notefig-view-file-tree --example
//! file_tree --features screenshot -- <workspace>`, driven by
//! `NOTEFIG_SCRIPT` (see `notefig_ui::driver`).

use std::path::PathBuf;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use gpui::{AppContext as _, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowBounds, WindowOptions, div, px, size};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services, Subscription};
use notefig_files::FilesModule;
use notefig_layout::{LayoutModule, MemoryUrl, UrlService};
use notefig_platform::{AppStatus, PlatformEvent, PlatformService, PlatformUi, TextPromptOptions};
use notefig_scratchpads::{ScratchpadLandingModule, ScratchpadsModule};
use notefig_tabs::TabsModule;
use notefig_tree_expansion::TreeExpansionModule;
use notefig_tree_inline_edit::TreeInlineEditModule;
use notefig_tree_model::TreeModelModule;
use notefig_ui::{CoreExt as _, CoreGlobal, GpuiExecutor, NotefigAssets, tokens};
use notefig_view_file_tree::FileTreePanel;
use notefig_workspaces::WorkspacesModule;

/// No dialogs in this harness.
struct NoUi;
impl PlatformUi for NoUi {
    fn pick_directory(&self, _: &str) -> LocalBoxFuture<'static, Option<String>> {
        futures::future::ready(None).boxed_local()
    }
    fn prompt_text(&self, _: TextPromptOptions) -> LocalBoxFuture<'static, Option<String>> {
        futures::future::ready(None).boxed_local()
    }
    fn open_external(&self, _: &str) {}
    fn reveal_in_file_manager(&self, _: &str) {}
    fn toggle_fullscreen(&self) {}
    fn publish_app_status(&self, _: AppStatus) {}
    fn subscribe(&self, _: Box<dyn Fn(&PlatformEvent)>) -> Subscription {
        Subscription::none()
    }
}

struct Host {
    panel: Entity<FileTreePanel>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        // The sidebar card the shell gives the tool.
        div().size_full().bg(t.background).p(px(8.)).child(
            notefig_ui::card(cx).size_full().flex().flex_col().overflow_hidden().child(self.panel.clone()),
        )
    }
}

fn main() {
    env_logger_init();
    let ws = std::env::args().nth(1).expect("usage: file_tree <workspace>");
    let ws = std::fs::canonicalize(&ws).map(|p| p.to_string_lossy().into_owned()).unwrap_or(ws);
    let state = PathBuf::from(std::env::var("NOTEFIG_STATE_DIR").expect("set NOTEFIG_STATE_DIR to a scratch dir"));
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        let dark = std::env::var("NOTEFIG_THEME").map(|v| v != "light").unwrap_or(true);
        notefig_ui::set_appearance(Some(dark), None, cx);
        let executor = GpuiExecutor::new(cx);
        let platform = notefig_platform_native::native_platform(state.clone(), executor.clone(), Rc::new(NoUi));
        let core = Core::new(
            CreateCoreOptions::new(executor)
                .services(
                    Services::new()
                        .with::<PlatformService>(Rc::new(platform))
                        .with::<UrlService>(MemoryUrl::new(&std::env::var("NOTEFIG_URL").unwrap_or_default())),
                )
                .modules(vec![
                    ModuleRef::of::<WorkspacesModule>(),
                    ModuleRef::of::<FilesModule>(),
                    ModuleRef::of::<LayoutModule>(),
                    ModuleRef::of::<TabsModule>(),
                    ModuleRef::of::<TreeModelModule>(),
                    ModuleRef::of::<TreeExpansionModule>(),
                    ModuleRef::of::<TreeInlineEditModule>(),
                    ModuleRef::of::<ScratchpadsModule>(),
                    ModuleRef::of::<ScratchpadLandingModule>(),
                ]),
        )
        .expect("core");
        core.boot();
        cx.set_global(CoreGlobal(core));
        notefig_view_file_tree::init(cx);
        let open = cx.core().workspace(&ws).open();
        let ws2 = ws.clone();
        cx.spawn(async move |cx| {
            open.await.expect("open workspace");
            cx.update(|cx| {
                let w = std::env::var("NOTEFIG_W").ok().and_then(|w| w.parse().ok()).unwrap_or(380.);
                let bounds = Bounds::centered(None, size(px(w), px(640.)), cx);
                let window = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        // `NOTEFIG_HEADLESS=1`: never shown or focused; `shot:` still renders.
                        show: std::env::var_os("NOTEFIG_HEADLESS").is_none(),
                        focus: std::env::var_os("NOTEFIG_HEADLESS").is_none(),
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        let handle = cx.core().workspace(&ws2);
                        let panel = cx.new(|cx| FileTreePanel::new(handle, window, cx));
                        cx.new(|_| Host { panel })
                    },
                )
                .expect("window");
                notefig_ui::driver::run_from_env(window.0, cx);
            })
        })
        .detach();
    });
}

fn env_logger_init() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Warn
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("[{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    let _ = log::set_logger(&Stderr).map(|()| log::set_max_level(log::LevelFilter::Warn));
}
