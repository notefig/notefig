//! Notefig on GPUI: the app shell. `main.rs` is a thin wrapper so tests can
//! build the same window (`open_main_window`) under `TestAppContext`.

pub mod actions;
pub mod agents;
pub mod app_state;
pub mod document;
pub mod fuzzy;
pub mod history;
pub mod layout;
pub mod palette;
pub mod root;
pub mod search_view;
pub mod theme;
pub mod tree_model;
pub mod workspace_view;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_agents;
#[cfg(test)]
mod tests_live;

use std::path::PathBuf;

use gpui::{App, AppContext as _, Bounds, Size, WindowBounds, WindowOptions, px, size};
use gpui_kit::component::TitleBar;
use notefig_workspace::StateStore;

pub use app_state::AppState;
pub use root::NotefigRoot;

/// Initialize gpui-kit, the editor, key bindings, menus and the app state.
/// Call once inside `Application::run`, before opening windows.
pub fn init(store: StateStore, cx: &mut App) {
    gpui_kit::init(cx);
    theme::init(cx);
    markdown_editor::init(cx);
    actions::bind_keys(cx);
    actions::set_menus(cx);
    AppState::init(store, cx);
}

pub fn window_options(cx: &App) -> WindowOptions {
    let saved = cx
        .try_global::<app_state::GlobalAppState>()
        .and_then(|g| g.0.read(cx).data().window);
    let window_bounds = match saved {
        Some(w) if w.width >= 400. && w.height >= 300. => {
            let bounds = Bounds::new(gpui::point(px(w.x), px(w.y)), size(px(w.width), px(w.height)));
            if w.fullscreen {
                WindowBounds::Fullscreen(bounds)
            } else if w.maximized {
                WindowBounds::Maximized(bounds)
            } else {
                WindowBounds::Windowed(bounds)
            }
        }
        _ => WindowBounds::Windowed(Bounds::centered(None, size(px(1440.), px(900.)), cx)),
    };
    WindowOptions {
        window_bounds: Some(window_bounds),
        window_min_size: Some(Size {
            width: px(800.),
            height: px(560.),
        }),
        ..TitleBar::window_options()
    }
}

/// Open the main window. `initial` is a folder to open instead of restoring
/// the last workspace.
pub fn open_main_window(
    initial: Option<PathBuf>,
    cx: &mut App,
) -> anyhow::Result<(gpui::AnyWindowHandle, gpui::Entity<NotefigRoot>)> {
    let options = window_options(cx);
    gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| NotefigRoot::new(initial, window, cx))
    })
}
