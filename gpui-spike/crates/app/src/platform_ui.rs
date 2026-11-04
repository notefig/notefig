//! The desktop `PlatformUi` (TS: the Tauri adapter's ui surface): native
//! dialogs and OS integration over GPUI. Built here, at the root, because
//! it needs the app; `notefig_platform_native::native_platform` takes it.

use std::cell::RefCell;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use gpui::{AsyncApp, PathPromptOptions};
use notefig_core::{Listeners, Subscription};
use notefig_platform::{AppStatus, PlatformEvent, PlatformUi, TextPromptOptions};

pub struct GpuiPlatformUi {
    cx: AsyncApp,
    listeners: Listeners<PlatformEvent>,
    status: RefCell<AppStatus>,
}

impl GpuiPlatformUi {
    pub fn new(cx: AsyncApp) -> Rc<Self> {
        Rc::new(Self { cx, listeners: Listeners::new(), status: RefCell::default() })
    }

    /// Announce an OS event (the "Open Folder" menu, a theme change).
    pub fn emit(&self, event: PlatformEvent) {
        self.listeners.notify(&event);
    }
}

impl PlatformUi for GpuiPlatformUi {
    fn pick_directory(&self, title: &str) -> LocalBoxFuture<'static, Option<String>> {
        let cx = self.cx.clone();
        let prompt = Some(title.to_string().into());
        async move {
            let rx = cx
                .update(|cx| {
                    cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt })
                });
            let paths = rx.await.ok()?.ok()??;
            paths.into_iter().next().map(|p| p.to_string_lossy().into_owned())
        }
        .boxed_local()
    }

    fn prompt_text(&self, options: TextPromptOptions) -> LocalBoxFuture<'static, Option<String>> {
        let cx = self.cx.clone();
        async move {
            let rx = cx.update(|cx| notefig_view_workspace::prompt_text(options, cx));
            rx.await.ok().flatten()
        }
        .boxed_local()
    }

    fn open_external(&self, url: &str) {
        let url = url.to_string();
        let _ = self.cx.update(|cx| cx.open_url(&url));
    }

    fn reveal_in_file_manager(&self, path: &str) {
        let path = std::path::PathBuf::from(path);
        let _ = self.cx.update(|cx| cx.reveal_path(&path));
    }

    fn toggle_fullscreen(&self) {
        let _ = self.cx.update(|cx| {
            if let Some(w) = cx.active_window() {
                let _ = w.update(cx, |_, window, _| window.toggle_fullscreen());
            }
        });
    }

    fn publish_app_status(&self, status: AppStatus) {
        // No tray or dock menu on this build; kept for the next reader.
        *self.status.borrow_mut() = status;
    }

    fn subscribe(&self, listener: Box<dyn Fn(&PlatformEvent)>) -> Subscription {
        self.listeners.subscribe(move |e| listener(e))
    }
}
