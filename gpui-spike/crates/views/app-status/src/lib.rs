//! The menu-bar item: the drawing half of `src-tauri/src/app_status.rs`
//! over `core.use_::<AppStatusModule>()`, and the publisher that feeds it
//! (`usePublishAppStatus`, [`publisher`]).
//!
//! A template icon (with a dot when anything needs the user), then a native
//! menu: each section as a disabled header over rows led by the sidebar's
//! glyphs (`assets/`, copied from `src-tauri/icons/menu`), then the actions,
//! then Quit. Rows carry ids, never behaviour: picking one brings the app
//! forward and hands the id to `AppStatusApi::activate`. The item is
//! created on the first publish, so it exists only once the app has said
//! something. AppKit runs on the main thread; so does all of this.
//!
//! Traffic lights (`src-tauri/src/traffic_lights.rs`): not ported. GPUI's
//! `TitlebarOptions::traffic_light_position` places them, and GPUI keeps
//! them there across AppKit's relayouts, so the Tauri pin-and-reapply has
//! nothing to do. The shell sets the position when it opens the window.
//!
//! Elsewhere than macOS, `init` draws nothing (as Tauri).

mod publisher;

use gpui::App;
use notefig_app_status::AppStatusModule;
use notefig_ui::CoreExt as _;

/// Start drawing the menu-bar item from `core.appStatus`. Call once, after
/// the core global is set.
pub fn init(cx: &mut App) {
    // `usePublishAppStatus`: derive and publish on every change.
    publisher::start(cx);
    let api = cx.core().use_::<AppStatusModule>();
    // Headless runs (`NOTEFIG_HEADLESS=1`) put nothing on the user's screen,
    // the menu bar included: the status is still derived and published.
    if headless() {
        return;
    }
    #[cfg(target_os = "macos")]
    mac::start(api, cx);
    #[cfg(not(target_os = "macos"))]
    let _ = api;
}

/// `NOTEFIG_HEADLESS`: no windows, no menu-bar item.
pub fn headless() -> bool {
    std::env::var_os("NOTEFIG_HEADLESS").is_some_and(|v| !v.is_empty() && v != "0")
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{App, Global};
    use notefig_app_status::{AppStatus, AppStatusApi, entry_text, glyph};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{AnyThread, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
    use objc2_app_kit::{NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem, NSVariableStatusItemLength};
    use objc2_foundation::{NSData, NSSize, NSString};

    const LOGO: &[u8] = include_bytes!("../assets/logo.png");
    const LOGO_ATTENTION: &[u8] = include_bytes!("../assets/logo-attention.png");

    fn glyph_bytes(name: &str) -> Option<&'static [u8]> {
        Some(match name {
            "running" => include_bytes!("../assets/running.png"),
            "settled" => include_bytes!("../assets/settled.png"),
            "queued" => include_bytes!("../assets/queued.png"),
            "error" => include_bytes!("../assets/error.png"),
            "attention" => include_bytes!("../assets/attention.png"),
            "document" => include_bytes!("../assets/document.png"),
            _ => return None,
        })
    }

    type Route = (Vec<String>, Option<async_channel::Sender<String>>);

    thread_local! {
        /// The ids behind the current menu's items, by tag; and where a
        /// picked id goes.
        static ROUTE: RefCell<Route> = RefCell::default();
    }

    define_class!(
        // The menu items' target: hands the picked item's id back.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "NotefigAppStatusTarget"]
        struct Target;

        impl Target {
            #[unsafe(method(activate:))]
            fn activate(&self, sender: &NSMenuItem) {
                let tag = sender.tag();
                ROUTE.with(|route| {
                    let route = route.borrow();
                    let id = usize::try_from(tag).ok().and_then(|t| route.0.get(t));
                    if let (Some(id), Some(tx)) = (id, &route.1) {
                        let _ = tx.try_send(id.clone());
                    }
                });
            }
        }
    );

    impl Target {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    struct Tray {
        item: Option<Retained<NSStatusItem>>,
        target: Retained<Target>,
    }

    struct TrayGlobal {
        _tray: Rc<RefCell<Tray>>,
        _sub: notefig_core::Subscription,
    }

    impl Global for TrayGlobal {}

    fn image(_mtm: MainThreadMarker, bytes: &[u8], template: bool) -> Option<Retained<NSImage>> {
        let data = NSData::with_bytes(bytes);
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        // The PNGs are @2x: draw them at menu size.
        let size = image.size();
        image.setSize(NSSize::new(size.width / 2.0, size.height / 2.0));
        image.setTemplate(template);
        Some(image)
    }

    fn menu_item(mtm: MainThreadMarker, title: &str, target: Option<(&Target, isize)>) -> Retained<NSMenuItem> {
        let action = target.map(|_| sel!(activate:));
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                action,
                &NSString::from_str(""),
            )
        };
        match target {
            Some((target, tag)) => {
                let target: &AnyObject = target.as_ref();
                unsafe { item.setTarget(Some(target)) };
                item.setTag(tag);
            }
            None => item.setEnabled(false),
        }
        item
    }

    fn build_menu(mtm: MainThreadMarker, status: &AppStatus, target: &Target) -> (Retained<NSMenu>, Vec<String>) {
        let menu = NSMenu::new(mtm);
        // Our items say whether they are enabled; AppKit mustn't re-decide.
        menu.setAutoenablesItems(false);
        let mut ids: Vec<String> = Vec::new();
        let mut routed = |id: &str| {
            ids.push(id.to_string());
            (ids.len() - 1) as isize
        };
        for section in &status.sections {
            menu.addItem(&menu_item(mtm, &section.title, None));
            for entry in &section.entries {
                let item = menu_item(mtm, &entry_text(entry), Some((target, routed(&entry.id))));
                if let Some(img) = glyph(entry.mark.as_deref()).and_then(glyph_bytes).and_then(|b| image(mtm, b, false)) {
                    item.setImage(Some(&img));
                }
                menu.addItem(&item);
            }
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        for action in &status.actions {
            menu.addItem(&menu_item(mtm, &action.label, Some((target, routed(&action.id)))));
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        let quit = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str("Quit Notefig"),
                Some(sel!(terminate:)),
                &NSString::from_str("q"),
            )
        };
        menu.addItem(&quit);
        (menu, ids)
    }

    fn present(tray: &mut Tray, status: &AppStatus) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let (menu, ids) = build_menu(mtm, status, &tray.target);
        ROUTE.with(|route| route.borrow_mut().0 = ids);
        let item = tray
            .item
            .get_or_insert_with(|| NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength));
        let logo = if status.attention.is_some() { LOGO_ATTENTION } else { LOGO };
        if let (Some(button), Some(icon)) = (item.button(mtm), image(mtm, logo, true)) {
            button.setImage(Some(&icon));
        }
        item.setMenu(Some(&menu));
    }

    pub fn start(api: Rc<AppStatusApi>, cx: &mut App) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let tray = Rc::new(RefCell::new(Tray { item: None, target: Target::new(mtm) }));
        let (tx, rx) = async_channel::unbounded::<String>();
        ROUTE.with(|route| route.borrow_mut().1 = Some(tx));
        // Picking anything brings the app forward — the user is coming back
        // to it — then the app does what the id means.
        let activator = api.clone();
        cx.spawn(async move |cx| {
            while let Ok(id) = rx.recv().await {
                let _ = cx.update(|cx| cx.activate(true));
                activator.activate(&id);
            }
        })
        .detach();
        let (drawn, watched) = (tray.clone(), api.clone());
        let sub = api.subscribe(move || {
            if let Some(status) = watched.current() {
                present(&mut drawn.borrow_mut(), &status);
            }
        });
        if let Some(status) = api.current() {
            present(&mut tray.borrow_mut(), &status);
        }
        cx.set_global(TrayGlobal { _tray: tray, _sub: sub });
    }
}
