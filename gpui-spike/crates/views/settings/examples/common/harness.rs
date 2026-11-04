//! Shared by the settings owner's view examples: a core over the native
//! platform (state in `NOTEFIG_STATE_DIR`, required), the workspace given
//! as the first argument opened, and one 1440×900 window whose body the
//! example builds. `NOTEFIG_SCRIPT` drives it (`notefig_ui::driver`).

use std::rc::Rc;

use futures::future::LocalBoxFuture;
use gpui::{
    AnyView, App, AppContext as _, Bounds, Context, InteractiveElement as _, IntoElement, ParentElement, Render, Styled,
    Window, WindowBounds, WindowOptions, div, px, size,
};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services, Subscription};
use notefig_platform::{AppStatus, PlatformEvent, PlatformService, PlatformUi, TextPromptOptions};
use notefig_ui::{CoreGlobal, GpuiExecutor, tokens};

struct StubUi;

impl PlatformUi for StubUi {
    fn pick_directory(&self, _: &str) -> LocalBoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
    fn prompt_text(&self, _: TextPromptOptions) -> LocalBoxFuture<'static, Option<String>> {
        Box::pin(async { None })
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
    body: AnyView,
    focus: gpui::FocusHandle,
    _theme: Option<Subscription>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        div()
            .track_focus(&self.focus)
            .size_full()
            .bg(t.background)
            .text_color(t.foreground)
            .font_family(notefig_ui::theme::FONT_SANS)
            .text_size(t.text_sm)
            .child(self.body.clone())
    }
}

/// Run the example. `body` builds the window's content once the core is up
/// and the workspace (if any) is open.
pub fn run(body: impl FnOnce(Option<String>, &mut Window, &mut App) -> AnyView + 'static) {
    let state_dir = std::env::var("NOTEFIG_STATE_DIR").expect("set NOTEFIG_STATE_DIR to a scratch folder");
    let workspace = std::env::args().nth(1).map(|p| {
        std::fs::canonicalize(&p).map(|p| p.to_string_lossy().to_string()).unwrap_or(p)
    });
    gpui_kit::application().with_assets(notefig_ui::NotefigAssets).run(move |cx: &mut App| {
        notefig_ui::init(cx);
        notefig_ui::set_appearance(Some(true), None, cx);
        notefig_view_settings::init(cx);
        let exec = GpuiExecutor::new(cx);
        let platform = notefig_platform_native::native_platform(state_dir.into(), exec.clone(), Rc::new(StubUi));
        let core = Core::new(
            CreateCoreOptions::new(exec)
                .services(Services::new().with::<PlatformService>(Rc::new(platform)))
                .modules(vec![
                    ModuleRef::of::<notefig_kv::KvModule>(),
                    ModuleRef::of::<notefig_i18n::I18nModule>(),
                    ModuleRef::of::<notefig_telemetry::TelemetryModule>(),
                    ModuleRef::of::<notefig_feedback::FeedbackModule>(),
                ]),
        )
        .expect("core");
        core.boot();
        cx.set_global(CoreGlobal(core.clone()));
        cx.spawn(async move |cx| {
            if let Some(ws) = &workspace {
                if let Err(err) = core.workspace(ws).open().await {
                    eprintln!("open {ws}: {err:?}");
                }
            }
            let _ = cx.update(|cx| {
                let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
                // `NOTEFIG_HEADLESS=1`: never show or focus the window
                // (`shot:` still renders it).
                let headless = std::env::var_os("NOTEFIG_HEADLESS").is_some();
                let options = WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    show: !headless,
                    focus: !headless,
                    ..Default::default()
                };
                let (window, _) = gpui_kit::open_window(options, cx, |window, cx| {
                    let body = body(workspace.clone(), window, cx);
                    cx.new(|cx| {
                        let focus = cx.focus_handle();
                        focus.focus(window, cx);
                        Host { body, focus, _theme: notefig_view_settings::watch_theme(window, cx) }
                    })
                })
                .expect("window");
                notefig_ui::driver::run_from_env(window, cx);
            });
        })
        .detach();
    });
}
