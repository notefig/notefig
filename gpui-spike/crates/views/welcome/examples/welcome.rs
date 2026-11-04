//! The welcome screen alone over a core with the native platform:
//! `NOTEFIG_STATE_DIR=… cargo run -p notefig-view-welcome --example welcome
//! --features screenshot`, driven by `NOTEFIG_SCRIPT`. `NOTEFIG_RECENT`
//! (comma-separated paths) seeds recent projects first.

use std::path::PathBuf;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use gpui::{AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services, Subscription};
use notefig_kv::KvModule;
use notefig_platform::{AppStatus, PlatformEvent, PlatformService, PlatformUi, TextPromptOptions};
use notefig_ui::{CoreExt as _, CoreGlobal, GpuiExecutor, NotefigAssets};
use notefig_view_welcome::{Welcome, add_recent_project};

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

fn main() {
    let state = PathBuf::from(std::env::var("NOTEFIG_STATE_DIR").expect("set NOTEFIG_STATE_DIR to a scratch dir"));
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        let dark = std::env::var("NOTEFIG_THEME").map(|v| v != "light").unwrap_or(true);
        notefig_ui::set_appearance(Some(dark), None, cx);
        let executor = GpuiExecutor::new(cx);
        let platform = notefig_platform_native::native_platform(state.clone(), executor.clone(), Rc::new(NoUi));
        let core = Core::new(
            CreateCoreOptions::new(executor)
                .services(Services::new().with::<PlatformService>(Rc::new(platform)))
                .modules(vec![ModuleRef::of::<KvModule>()]),
        )
        .expect("core");
        core.boot();
        cx.set_global(CoreGlobal(core));
        let kv = cx.core().use_::<KvModule>();
        let seeds: Vec<String> = std::env::var("NOTEFIG_RECENT").unwrap_or_default().split(',').filter(|s| !s.is_empty()).map(String::from).collect();
        cx.spawn(async move |cx| {
            let now = notefig_view_welcome::recent::now_ms();
            for (i, path) in seeds.iter().enumerate() {
                add_recent_project(&kv, path, now - (i as i64) * 7_200_000).await;
            }
            cx.update(|cx| {
                let w = std::env::var("NOTEFIG_W").ok().and_then(|w| w.parse().ok()).unwrap_or(1440.);
                let bounds = Bounds::centered(None, size(px(w), px(900.)), cx);
                let window = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        // `NOTEFIG_HEADLESS=1`: never shown or focused; `shot:` still renders.
                        show: std::env::var_os("NOTEFIG_HEADLESS").is_none(),
                        focus: std::env::var_os("NOTEFIG_HEADLESS").is_none(),
                        ..Default::default()
                    },
                    cx,
                    |window, cx| cx.new(|cx| Welcome::new(window, cx)),
                )
                .expect("window");
                notefig_ui::driver::run_from_env(window.0, cx);
            })
        })
        .detach();
    });
}
