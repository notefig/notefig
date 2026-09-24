//! macOS traffic-light pinning.
//!
//! `trafficLightPosition` (tauri.conf.json) is applied by tao on every
//! `drawRect:` by resizing the private title-bar container to
//! `close.height + y` and rewriting only the buttons' x origins. Where the
//! glyphs land vertically is therefore whatever AppKit's own layout put
//! inside that container — a per-macOS-version number. macOS 26 (Tahoe, and
//! any build linked against SDK 26) draws the controls as 14pt buttons on a
//! 23pt pitch where 11–15 drew 12pt on 20pt, so the same config lands the
//! lights a few points higher and the cluster runs wider.
//!
//! Instead of guessing the version, the shell tells this module the y it
//! wants the glyphs centred on (its header row's midline, in logical points
//! from the window's top) and gets back the cluster's measured rect. The pin
//! is re-applied on the window events after which AppKit re-runs its
//! title-bar layout (resize, theme change, focus after de-miniaturise), since
//! a one-shot move is undone by that relayout.
//!
//! Errors-as-values: every failure path yields `None` (no lights to place —
//! non-macOS, the mock runtime, a window without standard buttons) so the
//! frontend keeps its fallback geometry.

use serde::Serialize;
use tauri::Manager;
use std::sync::Mutex;

/// The lights' bounding box in logical points, origin at the window's
/// top-left, after pinning.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficLightsRect {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// The last requested centre line, kept so window events can re-apply it.
#[derive(Default)]
pub struct TrafficLightsPin(Mutex<Option<f64>>);

/// Pins the lights' vertical centre at `center_y` logical points from the
/// window's top edge and returns their measured rect.
#[tauri::command]
pub fn place_traffic_lights<R: tauri::Runtime>(
    window: tauri::Window<R>,
    pin: tauri::State<'_, TrafficLightsPin>,
    center_y: f64,
) -> Option<TrafficLightsRect> {
    *pin.0.lock().unwrap() = Some(center_y);
    place(&window, center_y)
}

/// Re-applies the pinned centre after AppKit has re-laid the title bar out.
/// No-op until the frontend has asked for a pin.
pub fn reapply<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let center_y = window
        .try_state::<TrafficLightsPin>()
        .and_then(|pin| *pin.0.lock().unwrap());
    if let Some(center_y) = center_y {
        place(window, center_y);
    }
}

/// Where a button's origin must go, in its superview's coordinates, for its
/// centre to sit `center_y` points below the window's top. Pure so the
/// bottom-up / flipped arithmetic is unit-testable off macOS.
///
/// `top_from_window_top` is the button's current distance from the window's
/// top edge; the superview being flipped means +y is downwards there.
pub fn pinned_origin_y(
    origin_y: f64,
    height: f64,
    top_from_window_top: f64,
    center_y: f64,
    superview_flipped: bool,
) -> f64 {
    let delta_down = (center_y - height / 2.0) - top_from_window_top;
    if superview_flipped {
        origin_y + delta_down
    } else {
        origin_y - delta_down
    }
}

#[cfg(target_os = "macos")]
fn place<R: tauri::Runtime>(window: &tauri::Window<R>, center_y: f64) -> Option<TrafficLightsRect> {
    use std::sync::mpsc;
    use std::time::Duration;

    // AppKit views are main-thread only. Sync commands already run there;
    // anything else hops over and waits.
    if objc2::MainThreadMarker::new().is_some() {
        return place_on_main_thread(window, center_y);
    }
    let (tx, rx) = mpsc::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(place_on_main_thread(&handle, center_y));
        })
        .ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

#[cfg(target_os = "macos")]
fn place_on_main_thread<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    center_y: f64,
) -> Option<TrafficLightsRect> {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::NSPoint;

    let ptr = window.ns_window().ok()?;
    // SAFETY: `ns_window()` hands back a live NSWindow pointer for this
    // window, and we are on the main thread (checked by the caller).
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let window_height = ns_window.frame().size.height;

    let mut rect: Option<TrafficLightsRect> = None;
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let button = ns_window.standardWindowButton(kind)?;
        // SAFETY: standard window buttons live in AppKit's title-bar view
        // hierarchy; reading the superview is the documented way to reach
        // its coordinate space (tao does the same to size the container).
        let superview = unsafe { button.superview() }?;
        let frame = button.frame();
        // Window base coordinates: origin at the frame's bottom-left, +y up.
        let in_window = superview.convertRect_toView(frame, None);
        let top_from_window_top = window_height - (in_window.origin.y + in_window.size.height);
        let origin_y = pinned_origin_y(
            frame.origin.y,
            frame.size.height,
            top_from_window_top,
            center_y,
            superview.isFlipped(),
        );
        if (origin_y - frame.origin.y).abs() > 0.01 {
            button.setFrameOrigin(NSPoint::new(frame.origin.x, origin_y));
        }
        let top = center_y - in_window.size.height / 2.0;
        let (left, right) = (in_window.origin.x, in_window.origin.x + in_window.size.width);
        rect = Some(match rect {
            None => TrafficLightsRect { left, right, top, bottom: top + in_window.size.height },
            Some(r) => TrafficLightsRect {
                left: r.left.min(left),
                right: r.right.max(right),
                top: r.top.min(top),
                bottom: r.bottom.max(top + in_window.size.height),
            },
        });
    }
    rect
}

#[cfg(not(target_os = "macos"))]
fn place<R: tauri::Runtime>(_window: &tauri::Window<R>, _center_y: f64) -> Option<TrafficLightsRect> {
    None
}

#[cfg(test)]
mod tests {
    use super::pinned_origin_y;

    // macOS 15 shape: a 12pt glyph whose top currently sits 22.5pt below
    // the window's top must move down 2.5pt to centre on 31; in AppKit's
    // bottom-up superview that is a smaller y.
    #[test]
    fn moves_down_in_a_bottom_up_superview() {
        assert_eq!(pinned_origin_y(8.0, 12.0, 22.5, 31.0, false), 5.5);
    }

    // macOS 26 shape: a 14pt glyph that landed 3pt too high (top at 21)
    // comes down to centre on 31.
    #[test]
    fn moves_down_in_a_flipped_superview() {
        assert_eq!(pinned_origin_y(4.0, 14.0, 21.0, 31.0, true), 7.0);
    }

    #[test]
    fn already_centred_is_a_no_op() {
        assert_eq!(pinned_origin_y(9.0, 12.0, 25.0, 31.0, false), 9.0);
    }
}
