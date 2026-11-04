//! Settings, and the dialogs that hang off it: a port of
//! `components/editor/settings-modal.tsx` and `settings-section.tsx`, the
//! telemetry consent dialog (`components/telemetry-consent-dialog.tsx`,
//! `modules/telemetry/react.tsx`), the feedback dialog
//! (`modules/feedback/react.tsx`), and `hooks/use-app-settings.ts`.
//!
//! Public API:
//! - [`init`]: actions and key bindings (⌘⇧, toggles Settings, ⌘⇧U opens
//!   Usage, ⌘⇧M toggles feedback when available).
//! - [`open_settings`]`(section, window, cx)` / [`close_settings`].
//! - [`register_section`]`(cx, "harnesses" | "usage", builder)`: how the
//!   agent and usage owners compose their sections;
//!   [`register_section_actions`] puts controls in a section's title row.
//! - [`app_settings`]: `AppSettings`, `AppSettingsStore` (no GPUI).
//! - [`apply_theme`], [`watch_theme`]: the theme provider.
//! - [`consent::TelemetryBootstrap`], [`feedback_dialog::open_feedback`].

pub mod app_settings;
pub mod consent;
pub mod debug_panel;
pub mod debug_report;
pub mod feedback_dialog;
pub mod hotkeys;
mod modal;
pub mod widgets;

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{AnyView, App, Global, KeyBinding, ParentElement as _, Styled as _, WeakEntity, Window, WindowId};
use gpui_kit::component::WindowExt as _;
use notefig_ui::{CoreExt, sp};

pub use modal::{DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, SectionBuilder, SettingsModal, resolve_section};

use app_settings::{AppSettingsStore, ThemeChoice};

gpui_kit::actions!(
    settings,
    [
        /// ⌘⇧, — open Settings on General, or close it.
        ToggleSettings,
        /// Open Settings on General.
        OpenSettings,
        /// ⌘⇧U — open Settings on Usage.
        OpenUsage,
        /// The palette's "Toggle Theme": dark ↔ light (system counts as dark).
        ToggleTheme,
        /// ⌘⇧M — the feedback dialog (only in builds with a support URL).
        ToggleFeedback,
        /// Debug mode on/off (Settings → Advanced).
        ToggleDebugMode,
    ]
);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-shift-,", ToggleSettings, None),
        KeyBinding::new("cmd-shift-u", OpenUsage, None),
        KeyBinding::new("cmd-shift-m", ToggleFeedback, None),
    ]);
    cx.on_action(|_: &ToggleTheme, cx| with_active_window(cx, toggle_theme));
    // Window-scoped actions are dispatched through the root; handle them on
    // the app as a fallback so they work from any focused element.
    cx.on_action(|_: &ToggleSettings, cx| with_active_window(cx, |window, cx| {
        if is_open(window, cx) {
            close_settings(window, cx)
        } else {
            open_settings(None, window, cx)
        }
    }));
    cx.on_action(|_: &OpenSettings, cx| with_active_window(cx, |w, cx| open_settings(None, w, cx)));
    cx.on_action(|_: &OpenUsage, cx| with_active_window(cx, |w, cx| open_settings(Some("usage"), w, cx)));
    cx.on_action(|_: &ToggleFeedback, cx| with_active_window(cx, feedback_dialog::toggle_feedback));
    cx.on_action(|_: &ToggleDebugMode, cx| {
        with_active_window(cx, |w, cx| {
            let on = cx.try_global::<DebugMode>().is_some_and(|d| d.0);
            set_debug_mode(!on, w, cx)
        })
    });
}

/// App-level action handlers run while the window dispatching them is
/// borrowed, so the window work is deferred until that dispatch ends.
fn with_active_window(cx: &mut App, f: impl FnOnce(&mut Window, &mut App) + 'static) {
    cx.defer(move |cx| {
        if let Some(w) = cx.active_window().or_else(|| cx.windows().first().copied()) {
            let _ = w.update(cx, |_, window, cx| f(window, cx));
        }
    });
}

#[derive(Default)]
struct OpenModals(HashMap<WindowId, WeakEntity<SettingsModal>>);
impl Global for OpenModals {}

/// Section views other crates contribute (`"harnesses"`, `"usage"`), and
/// the controls they put in their section's title row.
#[derive(Default, Clone)]
pub(crate) struct SectionViews(pub HashMap<&'static str, SectionBuilder>, pub HashMap<&'static str, SectionBuilder>);
impl Global for SectionViews {}

/// Compose an owner's section: `"harnesses"` (views/agent's
/// `HarnessSettings`) or `"usage"` (views/usage's `UsageSettings`). Call
/// from that crate's `init`, or from the app root.
pub fn register_section(cx: &mut App, id: &'static str, builder: impl Fn(&mut Window, &mut App) -> AnyView + 'static) {
    cx.default_global::<SectionViews>().0.insert(id, Rc::new(builder));
}

/// Put controls in a section's title row, beside its heading
/// (`SettingsSectionActions` in TS): e.g. Usage's range and grain pickers.
/// The view is built once per opening of the dialog, like the section's.
/// A section without a title (harnesses, privacy) renders the row anyway
/// when it has actions.
pub fn register_section_actions(cx: &mut App, id: &'static str, builder: impl Fn(&mut Window, &mut App) -> AnyView + 'static) {
    cx.default_global::<SectionViews>().1.insert(id, Rc::new(builder));
}

/// Whether the Settings dialog is open in this window.
pub fn is_open(window: &Window, cx: &App) -> bool {
    cx.try_global::<OpenModals>()
        .and_then(|m| m.0.get(&window.window_handle().window_id()))
        .is_some_and(|w| w.upgrade().is_some())
}

/// `?settings=<section>`: open Settings on `section` (an unknown or `None`
/// section opens General), or scroll the open one there.
pub fn open_settings(section: Option<&str>, window: &mut Window, cx: &mut App) {
    let ix = resolve_section(section);
    let id = window.window_handle().window_id();
    if let Some(modal) = cx.try_global::<OpenModals>().and_then(|m| m.0.get(&id)).and_then(|w| w.upgrade()) {
        modal.update(cx, |m, cx| m.show_section(ix, cx));
        return;
    }
    let modal = modal::new_modal(ix, window, cx);
    cx.default_global::<OpenModals>().0.insert(id, modal.downgrade());
    let view = modal.clone();
    window.open_dialog(cx, move |dialog, window, cx| {
        let size = window.viewport_size();
        let t = notefig_ui::tokens(cx);
        dialog
            .w(size.width * 0.95)
            .margin_top(size.height * 0.075)
            .p_0()
            .gap_0()
            .bg(t.card)
            .close_button(false)
            .on_close(move |_, _, cx| {
                cx.default_global::<OpenModals>().0.remove(&id);
            })
            .child(view.clone())
    });
    let _ = sp(0.);
}

/// Close the Settings dialog in this window, if open.
pub fn close_settings(window: &mut Window, cx: &mut App) {
    if is_open(window, cx) {
        cx.default_global::<OpenModals>().0.remove(&window.window_handle().window_id());
        window.close_dialog(cx);
    }
}

/// `theme-provider.tsx`'s `setTheme`.
pub fn apply_theme(choice: ThemeChoice, window: &mut Window, cx: &mut App) {
    let dark = match choice {
        ThemeChoice::Dark => Some(true),
        ThemeChoice::Light => Some(false),
        ThemeChoice::System => None,
    };
    notefig_ui::set_appearance(dark, Some(window), cx);
    window.refresh();
}

/// The palette's `swapTheme`: system and dark go light, light goes dark.
pub fn toggle_theme(window: &mut Window, cx: &mut App) {
    let core = cx.core();
    let Some(store) = AppSettingsStore::from_core(&core) else { return };
    let next = match store.settings().theme {
        ThemeChoice::System | ThemeChoice::Dark => ThemeChoice::Light,
        ThemeChoice::Light => ThemeChoice::Dark,
    };
    apply_theme(next, window, cx);
    store.set(&core.executor(), app_settings::keys::THEME, serde_json::json!(next.as_str()));
}

/// The theme provider: apply the stored theme once settings hydrate and
/// whenever it changes. The shell keeps the returned subscription for the
/// window's life.
pub fn watch_theme<V: 'static>(window: &mut Window, cx: &mut gpui::Context<V>) -> Option<notefig_core::Subscription> {
    let store = AppSettingsStore::from_core(&cx.core())?;
    let (tx, rx) = async_channel::bounded::<()>(1);
    let _ = tx.try_send(());
    let sub = store.subscribe(move || {
        let _ = tx.try_send(());
    });
    let task = cx.spawn_in(window, async move |_, cx| {
        let mut last = None;
        while rx.recv().await.is_ok() {
            if !store.is_ready() {
                continue;
            }
            let theme = store.settings().theme;
            if last != Some(theme) {
                last = Some(theme);
                if cx.update(|window, cx| apply_theme(theme, window, cx)).is_err() {
                    break;
                }
            }
        }
    });
    Some(notefig_core::Subscription::join(vec![sub, notefig_core::Subscription::new(move || drop(task))]))
}

/// Debug mode (`?debug`): shows the debug panel.
#[derive(Default)]
pub struct DebugMode(pub bool);
impl Global for DebugMode {}

pub fn set_debug_mode(on: bool, window: &mut Window, cx: &mut App) {
    cx.set_global(DebugMode(on));
    if on {
        debug_panel::open_debug_panel(window, cx);
    } else {
        debug_panel::close_debug_panel(window, cx);
    }
    window.refresh();
}
