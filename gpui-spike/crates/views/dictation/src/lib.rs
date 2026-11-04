//! Dictation's GPUI side — what the TS app spread over
//! `modules/dictation/react.ts`, the `listen()` half of
//! `packages/dictation/src/dictation.ts` and the Tiptap extension in
//! `packages/widgets/src/dictation/extension.ts`:
//!
//! - [`init`]: follows the hold key and Escape for the core's dictation.
//!   GPUI's modifiers don't say which side was pressed, so on macOS an
//!   `NSEvent` local monitor reads `flagsChanged` key codes (62 right ⌃,
//!   61 right ⌥). Escape is a keystroke interceptor, ahead of every action,
//!   so it cancels a dictation before a composer's own Escape.
//! - [`EditorDictationTarget`]: a markdown editor as a dictation target.
//! - [`DictationIndicator`]: the voice wave and words-so-far while someone
//!   dictates, plus why the last one failed.
//! - [`dictation_key_label`]: "right ⌃" for the composers' placeholders.

mod indicator;
mod target;

pub use indicator::DictationIndicator;
pub use target::{DictationPreview, EditorDictationTarget};

use gpui::App;
use notefig_dictation::{DictationApi, DictationModule, KeyPlatform, hold_key_label};
use notefig_ui::CoreGlobal;

/// The core's dictation, when the root has the module.
pub fn dictation(cx: &App) -> Option<std::rc::Rc<DictationApi>> {
    cx.try_global::<CoreGlobal>().and_then(|core| core.0.try_use::<DictationModule>())
}

/// The hold key's name for the composers' placeholders ("… or hold right ⌃
/// to talk"), while dictation is on (`useDictationKey`). `enabled` is the
/// app setting `dictationEnabled` as the caller has read it.
pub fn dictation_key_label(enabled: bool, cx: &App) -> Option<String> {
    let dictation = dictation(cx)?;
    enabled.then(|| hold_key_label(dictation.hold_key(), KeyPlatform::current()))
}

/// Starts following the hold key and Escape. Call once, after the core
/// global is set; a root without the dictation module gets nothing.
pub fn init(cx: &mut App) {
    let Some(api) = dictation(cx) else {
        log::info!("dictation: no dictation module in this root");
        return;
    };
    let escape = api.clone();
    cx.intercept_keystrokes(move |event, _window, cx| {
        if event.keystroke.key == "escape" && escape.escape() {
            cx.stop_propagation();
        }
    })
    .detach();
    // Out of focus, the keys are let go and the mic with them: the
    // indicator observes its window's activation (`DictationIndicator::new`).
    #[cfg(target_os = "macos")]
    macos::install_hold_key_monitor((*api).clone());
    attach_every_editor(api, cx);
}

/// Every markdown editor — documents and the prompt composers alike — is a
/// dictation target for as long as it lives (TS: the Tiptap extension in
/// every editor). A read-only one declines at `begin`.
fn attach_every_editor(api: std::rc::Rc<DictationApi>, cx: &mut App) {
    let preview = cx.default_global::<SharedPreview>().0.clone();
    cx.observe_new::<markdown_editor::BlockEditorState>(move |_, window, cx| {
        let Some(window) = window else { return };
        let target = EditorDictationTarget::new(cx.entity().downgrade(), window.window_handle(), preview.clone(), cx);
        let attached = std::cell::RefCell::new(Some(api.attach(std::rc::Rc::new(target))));
        cx.on_release(move |_, _| drop(attached.borrow_mut().take())).detach();
    })
    .detach();
}

/// The preview every editor target writes to: what a window's
/// [`DictationIndicator`] shows (`DictationIndicator::new(Some(shared_preview(cx)), …)`).
#[derive(Default)]
struct SharedPreview(DictationPreview);

impl gpui::Global for SharedPreview {}

/// The words-so-far of whichever editor is being dictated into.
pub fn shared_preview(cx: &mut App) -> DictationPreview {
    cx.default_global::<SharedPreview>().0.clone()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use notefig_dictation::{DictationApi, ModifierKey};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

    /// Device-dependent modifier bits (IOKit's `NX_DEVICE*KEYMASK`): which
    /// side of a modifier is down.
    const LEFT_CONTROL: usize = 0x0001;
    const RIGHT_CONTROL: usize = 0x2000;
    const LEFT_OPTION: usize = 0x0020;
    const RIGHT_OPTION: usize = 0x0040;

    fn modifier(key_code: u16) -> Option<(ModifierKey, usize, NSEventModifierFlags)> {
        Some(match key_code {
            59 => (ModifierKey::ControlLeft, LEFT_CONTROL, NSEventModifierFlags::Control),
            62 => (ModifierKey::ControlRight, RIGHT_CONTROL, NSEventModifierFlags::Control),
            58 => (ModifierKey::AltLeft, LEFT_OPTION, NSEventModifierFlags::Option),
            61 => (ModifierKey::AltRight, RIGHT_OPTION, NSEventModifierFlags::Option),
            _ => return None,
        })
    }

    /// A local monitor (this app's events only) on `flagsChanged`. It lives
    /// for the life of the app; events always pass through untouched.
    pub fn install_hold_key_monitor(api: DictationApi) {
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands the monitor a live event for the call.
            let ns_event = unsafe { event.as_ref() };
            if let Some((key, side, flag)) = modifier(ns_event.keyCode()) {
                let flags = ns_event.modifierFlags();
                let down = flags.contains(flag) && flags.0 & side != 0;
                api.modifier_changed(key, down);
            }
            event.as_ptr()
        });
        // SAFETY: called on the main thread at startup; the block is 'static.
        let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::FlagsChanged, &block) };
        // Kept for the life of the app (removing it is `removeMonitor:`).
        std::mem::forget(monitor);
    }
}
