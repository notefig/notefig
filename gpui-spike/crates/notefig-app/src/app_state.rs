//! App-wide state: the persisted store, the theme preference, and the slot
//! the AI integration fills with its agent handle.

use std::time::Duration;

use gpui::{App, AppContext as _, Context, Entity, Global, Task, Window};
use gpui_kit::component::{Theme, ThemeMode};
use notefig_workspace::{AppStateData, StateStore, ThemePreference, state::save_to};

use crate::agents::Agents;

const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

pub struct AppState {
    store: StateStore,
    save_task: Option<Task<()>>,
    /// The agent runtime (`Agents::start` puts it here). `None` until
    /// agents start (tests without agents, or a boot failure).
    pub agent: Option<gpui::Entity<Agents>>,
    /// Start a file watcher per workspace (tests turn it off and feed
    /// `WorkspaceView::handle_fs_events` directly).
    pub watch_files: bool,
}

pub(crate) struct GlobalAppState(pub(crate) Entity<AppState>);
impl Global for GlobalAppState {}

impl AppState {
    /// Create the app state and register it as a global. Call before any
    /// window opens (the store is loaded synchronously).
    pub fn init(store: StateStore, cx: &mut App) -> Entity<AppState> {
        let state = cx.new(|_| AppState {
            store,
            save_task: None,
            agent: None,
            watch_files: true,
        });
        cx.set_global(GlobalAppState(state.clone()));
        state
    }

    pub fn global(cx: &App) -> Entity<AppState> {
        cx.global::<GlobalAppState>().0.clone()
    }

    pub fn data(&self) -> &AppStateData {
        &self.store.data
    }

    /// Mutate the persisted data; saves are debounced.
    pub fn update_data(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut AppStateData)) {
        f(&mut self.store.data);
        self.schedule_save(cx);
        cx.notify();
    }

    fn schedule_save(&mut self, cx: &mut Context<Self>) {
        self.save_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_DEBOUNCE).await;
            let Ok((path, data)) = this.update(cx, |this, _| {
                (this.store.path().to_path_buf(), this.store.data.clone())
            }) else {
                return;
            };
            let result = cx
                .background_executor()
                .spawn(async move { save_to(&path, &data) })
                .await;
            if let Err(err) = result {
                log::error!("saving app state failed: {err:#}");
            }
        }));
    }

    /// Write now (on quit).
    pub fn flush(&mut self) {
        self.save_task = None;
        if let Err(err) = self.store.save() {
            log::error!("saving app state failed: {err:#}");
        }
    }

    pub fn theme(&self) -> ThemePreference {
        self.store.data.theme
    }

    pub fn set_theme(&mut self, pref: ThemePreference, window: &mut Window, cx: &mut Context<Self>) {
        self.update_data(cx, |d| d.theme = pref);
        apply_theme(pref, window, cx);
    }
}

/// Apply a theme preference to gpui-kit's theme. `System` follows the
/// window's appearance; call again from `observe_window_appearance`.
pub fn apply_theme(pref: ThemePreference, window: &mut Window, cx: &mut App) {
    match pref {
        ThemePreference::System => Theme::sync_system_appearance(Some(window), cx),
        ThemePreference::Light => Theme::change(ThemeMode::Light, Some(window), cx),
        ThemePreference::Dark => Theme::change(ThemeMode::Dark, Some(window), cx),
    }
}

/// The next preference for the toggle: flips what is currently shown.
pub fn toggled(cx: &App) -> ThemePreference {
    if Theme::global(cx).is_dark() {
        ThemePreference::Light
    } else {
        ThemePreference::Dark
    }
}
