//! Notefig's look on gpui-kit: the app's tokens (`desktop/src/styles.css`,
//! shadcn "stone" plus the terracotta brand) as a gpui-kit theme pair, and
//! the bundled fonts (Inter for UI and documents, Libre Baskerville for
//! serif). `assets/notefig-theme.json` is generated from the CSS tokens.

use std::borrow::Cow;

use gpui::{App, Global, Hsla, Rgba};
use gpui_kit::component::{Theme, ThemeRegistry};

pub const LIGHT: &str = "Notefig Light";
pub const DARK: &str = "Notefig Dark";
const THEME_JSON: &str = include_str!("../assets/notefig-theme.json");

/// Notefig colors gpui-kit has no slot for (spec 04 §8 "Brand").
#[derive(Clone, Copy, Debug)]
pub struct BrandColors {
    pub brand: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub highlight: Hsla,
}

impl BrandColors {
    pub fn for_dark(dark: bool) -> Self {
        let c = |hex: u32| Hsla::from(Rgba::from(gpui::rgb(hex)));
        if dark {
            Self {
                brand: c(0xd98a6b),
                success: c(0xa3a68a),
                warning: c(0xeb6a45),
                highlight: c(0xe8c9b8),
            }
        } else {
            Self {
                brand: c(0xc56a4a),
                success: c(0x8c8f72),
                warning: c(0x9e3f2a),
                highlight: c(0xe8c9b8),
            }
        }
    }

    pub fn get(cx: &App) -> Self {
        Self::for_dark(Theme::global(cx).is_dark())
    }
}

struct FontsLoaded;
impl Global for FontsLoaded {}

/// Register the fonts and the Notefig theme pair. Call after `gpui_kit::init`
/// and before the first `Theme::change`.
pub fn init(cx: &mut App) {
    if !cx.has_global::<FontsLoaded>() {
        let fonts: Vec<Cow<'static, [u8]>> = vec![
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-400-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-400-italic.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-500-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-600-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-700-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/libre-baskerville-latin-400-normal.ttf")),
        ];
        if let Err(err) = cx.text_system().add_fonts(fonts) {
            log::warn!("bundled fonts failed to load: {err:#}");
        }
        let names = cx.text_system().all_font_names();
        for family in ["Inter", "Libre Baskerville"] {
            if names.iter().any(|n| n == family) {
                log::info!("font {family} registered");
            } else {
                log::warn!("font {family} is not available; falling back");
            }
        }
        cx.set_global(FontsLoaded);
    }
    if let Err(err) = ThemeRegistry::global_mut(cx).load_themes_from_str(THEME_JSON) {
        log::error!("Notefig theme failed to load: {err:#}");
        return;
    }
    let registry = ThemeRegistry::global(cx);
    let light = registry.themes().get(LIGHT).cloned();
    let dark = registry.themes().get(DARK).cloned();
    if let (Some(light), Some(dark)) = (light, dark) {
        let theme = Theme::global_mut(cx);
        theme.light_theme = light;
        theme.dark_theme = dark;
    }
}
