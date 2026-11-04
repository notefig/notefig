//! `hotkey-catalog.ts`: the shortcuts the app ships, as the settings list
//! renders them. Documentation, not the registry: each binding still lives
//! where its action is bound. Read-only in TS too ("Customizing them is
//! coming in a future release").

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HotkeyGroup {
    General,
    Tabs,
    Editing,
}

#[derive(Clone, Copy, Debug)]
pub struct HotkeyEntry {
    pub id: &'static str,
    /// In TanStack notation (`Mod+Shift+,`), for [`format_for_display`].
    pub binding: &'static str,
    pub binding_end: Option<&'static str>,
    /// `display` overrides: a key held on its own.
    pub display: Option<&'static str>,
    /// Under `hotkeyLabels.`.
    pub label_key: &'static str,
    pub group: HotkeyGroup,
}

pub const HOTKEY_GROUPS: &[(HotkeyGroup, &str)] = &[
    (HotkeyGroup::General, "hotkeyGroups.general"),
    (HotkeyGroup::Tabs, "hotkeyGroups.tabs"),
    (HotkeyGroup::Editing, "hotkeyGroups.editing"),
];

const fn e(id: &'static str, binding: &'static str, group: HotkeyGroup) -> HotkeyEntry {
    HotkeyEntry { id, binding, binding_end: None, display: None, label_key: id, group }
}

use HotkeyGroup::*;

pub const HOTKEY_CATALOG: &[HotkeyEntry] = &[
    e("commandPalette", "Mod+K", General),
    e("quickSwitcher", "Mod+P", General),
    e("openSettings", "Mod+Shift+,", General),
    e("toggleSidebar", "Mod+\\", General),
    e("sessionsSidebar", "Mod+Shift+A", General),
    e("openUsage", "Mod+Shift+U", General),
    e("sendFeedback", "Mod+Shift+M", General),
    e("closeTab", "Mod+W", Tabs),
    e("nextTab", "Control+Tab", Tabs),
    e("prevTab", "Control+Shift+Tab", Tabs),
    HotkeyEntry { binding_end: Some("Mod+9"), ..e("selectTabByNumber", "Mod+1", Tabs) },
    e("previousPane", "Mod+[", Tabs),
    e("nextPane", "Mod+]", Tabs),
    e("focusPaneUp", "Mod+Alt+ArrowUp", Tabs),
    e("focusPaneDown", "Mod+Alt+ArrowDown", Tabs),
    e("focusPaneLeft", "Mod+Alt+ArrowLeft", Tabs),
    e("focusPaneRight", "Mod+Alt+ArrowRight", Tabs),
    e("newScratchpad", "Mod+N", Editing),
    e("searchInFile", "Mod+F", Editing),
    e("searchInAllFiles", "Mod+Shift+F", Editing),
    e("undo", "Mod+Z", Editing),
    e("redo", "Mod+Shift+Z", Editing),
    // @notefig/dictation: hold right ⌥ on macOS, right Ctrl elsewhere.
    HotkeyEntry { display: Some(DICTATE_DISPLAY), ..e("dictate", "Alt", Editing) },
];

#[cfg(target_os = "macos")]
const DICTATE_DISPLAY: &str = "Hold right ⌥";
#[cfg(not(target_os = "macos"))]
const DICTATE_DISPLAY: &str = "Hold right Ctrl";

/// `holdKeyLabel(dictationHoldKey())`.
pub fn dictation_hold_key_label() -> &'static str {
    if cfg!(target_os = "macos") { "right ⌥" } else { "right Ctrl" }
}

/// `formatForDisplay` from `@tanstack/react-hotkeys`: macOS symbols run
/// together (`⌘⇧,`), elsewhere `Ctrl+Shift+,`.
pub fn format_for_display(binding: &str) -> String {
    format_for(binding, cfg!(target_os = "macos"))
}

pub(crate) fn format_for(binding: &str, mac: bool) -> String {
    let parts: Vec<String> = binding
        .split('+')
        .enumerate()
        .filter(|(i, p)| !p.is_empty() || *i > 0)
        .map(|(_, p)| {
            let p = if p.is_empty() { "+" } else { p };
            match (p, mac) {
                ("Mod", true) | ("Meta", true) => "⌘".into(),
                ("Mod", false) | ("Control", false) => "Ctrl".into(),
                ("Control", true) => "⌃".into(),
                ("Shift", true) => "⇧".into(),
                ("Alt", true) => "⌥".into(),
                ("Meta", false) => "Win".into(),
                ("ArrowUp", _) => "↑".into(),
                ("ArrowDown", _) => "↓".into(),
                ("ArrowLeft", _) => "←".into(),
                ("ArrowRight", _) => "→".into(),
                ("Tab", _) => "⇥".into(),
                ("Escape", _) => "Esc".into(),
                (k, _) if k.len() == 1 => k.to_uppercase(),
                (k, _) => k.to_string(),
            }
        })
        .collect();
    if mac { parts.concat() } else { parts.join("+") }
}

/// A GPUI keystroke (`cmd-shift-p`) shown the same way.
pub fn format_keystroke(keystroke: &str) -> String {
    let binding: Vec<String> = keystroke
        .split('-')
        .map(|p| match p {
            "cmd" => "Mod".to_string(),
            "ctrl" => "Control".to_string(),
            "shift" => "Shift".to_string(),
            "alt" => "Alt".to_string(),
            "up" => "ArrowUp".into(),
            "down" => "ArrowDown".into(),
            "left" => "ArrowLeft".into(),
            "right" => "ArrowRight".into(),
            "tab" => "Tab".into(),
            "escape" => "Escape".into(),
            k => k.to_string(),
        })
        .collect();
    format_for_display(&binding.join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_tanstack() {
        assert_eq!(format_for("Mod+Shift+,", true), "⌘⇧,");
        assert_eq!(format_for("Mod+Shift+,", false), "Ctrl+Shift+,");
        assert_eq!(format_for("Mod+\\", false), "Ctrl+\\");
        assert_eq!(format_for("Control+Tab", true), "⌃⇥");
        assert_eq!(format_for("Mod+k", true), "⌘K");
    }

    #[test]
    fn every_entry_has_a_label() {
        for entry in HOTKEY_CATALOG {
            let key = format!("hotkeyLabels.{}", entry.label_key);
            assert!(notefig_i18n::has_key(&key), "{key}");
        }
    }
}
