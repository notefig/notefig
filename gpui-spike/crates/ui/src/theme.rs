//! The app's look: a port of the design tokens in
//! `packages/desktop/src/styles.css` (shadcn "stone" plus the terracotta
//! brand), its type scale and spacing, and the bundled fonts.
//!
//! Read the tokens with [`tokens`] (`let t = notefig_ui::tokens(cx);`) and
//! size things with [`rem`] / [`sp`], which follow the TS app's root font
//! size (`html { font-size: 150% }`, so 1rem = 24px at zoom 1). The
//! gpui-kit theme (buttons, inputs, popovers) is loaded from the same
//! tokens, so kit components and hand-built chrome agree.
//!
//! ```ignore
//! let t = notefig_ui::tokens(cx);
//! div().bg(t.card).border_1().border_color(t.border).rounded(t.radius_lg)
//!     .text_size(t.text_xs).text_color(t.muted_foreground)
//!     .p(sp(2.));                       // p-2 = 0.5rem
//! ```

use std::borrow::Cow;

use gpui::{App, Global, Hsla, Pixels, Rgba, Window, px};
use gpui_kit::component::{Theme, ThemeMode, ThemeRegistry};

pub const LIGHT: &str = "Notefig Light";
pub const DARK: &str = "Notefig Dark";
const THEME_JSON: &str = include_str!("../assets/notefig-theme.json");

/// The UI font (`--font-sans`), the serif and the mono.
pub const FONT_SANS: &str = "Inter";
pub const FONT_SERIF: &str = "Libre Baskerville";
pub const FONT_MONO: &str = "Menlo";

/// The TS root font size in px at zoom 1 (`html { font-size: 150% }`).
///
/// Verified against the reference shots (2880×1800 PNGs of a 1440×900
/// viewport, so 2 PNG px per logical px): the sidebar is `15rem` wide and
/// measures 716 PNG px = 358 logical px ≈ 15 × 24; the header row is
/// `1.5rem` = 72 PNG px = 36 logical px. A view that looks 1.5× too big is
/// usually reading TS `px`/Tailwind sizes as rem-free: Tailwind spacing
/// and text sizes are rem-based (`text-xs` = 0.75rem = 18px here), but an
/// explicit `px` in TS (`h-[38px]`, `size={14}`) stays that many px.
pub const ROOT_FONT_PX: f32 = 24.;

/// `n` rem, in logical px.
pub fn rem(n: f32) -> Pixels {
    px(n * ROOT_FONT_PX)
}

/// Tailwind's spacing scale: `sp(2.)` is `p-2`/`gap-2` = 0.5rem.
pub fn sp(n: f32) -> Pixels {
    rem(n * 0.25)
}

/// The tokens of one appearance. Field names follow the CSS variables
/// (`--muted-foreground` → `muted_foreground`).
#[derive(Clone, Debug)]
pub struct Tokens {
    pub dark: bool,
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub card_foreground: Hsla,
    pub popover: Hsla,
    pub popover_foreground: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub secondary_foreground: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub accent_foreground: Hsla,
    pub destructive: Hsla,
    pub destructive_foreground: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    pub ring: Hsla,
    /// Terracotta: links, the caret, markdown file icons.
    pub brand: Hsla,
    /// Sage: "saved", finished.
    pub success: Hsla,
    /// Rust: errors, warnings, attention badges.
    pub warning: Hsla,
    /// Blush.
    pub highlight: Hsla,
    pub logo: Hsla,
    /// `.shell-chrome-wash`: the faint tint on tab strips and the sidebar
    /// header row.
    pub chrome_wash: Hsla,
    /// `hover:bg-accent/60`.
    pub accent_hover: Hsla,
    /// Selection in text.
    pub selection: Hsla,

    // Radii (`--radius: 0.5rem`).
    /// `rounded-lg`.
    pub radius_lg: Pixels,
    /// `rounded-md`.
    pub radius_md: Pixels,
    /// `rounded-sm`.
    pub radius_sm: Pixels,

    // Type scale (Tailwind, in rem).
    /// `text-[10px]`-ish captions: 0.625rem.
    pub text_2xs: Pixels,
    /// `text-xs`: 0.75rem.
    pub text_xs: Pixels,
    /// `text-sm`: 0.875rem.
    pub text_sm: Pixels,
    /// `text-base`: 1rem.
    pub text_base: Pixels,

    /// Tailwind's line heights for `text-2xs`/`xs`/`sm`/`base` (0.625rem→
    /// 0.875rem lh, 0.75rem→1rem, 0.875rem→1.25rem, 1rem→1.5rem). GPUI's
    /// default line height is taller; set these with the text size.
    pub leading_2xs: Pixels,
    pub leading_xs: Pixels,
    pub leading_sm: Pixels,
    pub leading_base: Pixels,

    /// `size-3.5`: the chrome's icon size.
    pub icon_sm: Pixels,
    /// `size-4`.
    pub icon_md: Pixels,
    /// `--shell-header-height` (1.5rem off macOS).
    pub header_height: Pixels,
    /// The shell root's padding and the gap between its cards (`p-2 gap-2`).
    pub shell_gap: Pixels,
}

fn hsl(h: f32, s: f32, l: f32) -> Hsla {
    gpui::hsla(h / 360., s / 100., l / 100., 1.)
}

fn hex(c: u32) -> Hsla {
    Hsla::from(Rgba::from(gpui::rgb(c)))
}

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Hsla {
    Hsla::from(Rgba {
        r: r as f32 / 255.,
        g: g as f32 / 255.,
        b: b as f32 / 255.,
        a,
    })
}

impl Tokens {
    /// `:root` in styles.css.
    pub fn light() -> Self {
        let accent = hsl(60., 4.8, 95.9);
        Self {
            dark: false,
            background: hsl(0., 0., 100.),
            foreground: hsl(20., 14.3, 4.1),
            card: hsl(0., 0., 100.),
            card_foreground: hsl(20., 14.3, 4.1),
            popover: hsl(0., 0., 100.),
            popover_foreground: hsl(20., 14.3, 4.1),
            primary: hsl(24., 9.8, 10.),
            primary_foreground: hsl(60., 9.1, 97.8),
            secondary: hsl(60., 4.8, 95.9),
            secondary_foreground: hsl(24., 9.8, 10.),
            muted: hsl(60., 4.8, 95.9),
            muted_foreground: hsl(25., 5.3, 44.7),
            accent,
            accent_foreground: hsl(24., 9.8, 10.),
            destructive: hsl(11., 58., 39.),
            destructive_foreground: hsl(60., 9.1, 97.8),
            border: hsl(20., 5.9, 90.),
            input: hsl(20., 5.9, 90.),
            ring: hsl(20., 14.3, 4.1),
            brand: hex(0xc56a4a),
            success: hex(0x8c8f72),
            warning: hex(0x9e3f2a),
            highlight: hex(0xe8c9b8),
            logo: hex(0xc56a4a),
            chrome_wash: rgba(15, 15, 15, 0.05),
            accent_hover: accent.opacity(0.6),
            selection: hex(0xc56a4a).opacity(0.22),
            ..Self::metrics()
        }
    }

    /// `.dark` in styles.css.
    pub fn dark() -> Self {
        let accent = hsl(12., 6.5, 15.1);
        Self {
            dark: true,
            background: hsl(20., 14.3, 4.1),
            foreground: hsl(60., 9.1, 97.8),
            card: hsl(20., 14.3, 4.1),
            card_foreground: hsl(60., 9.1, 97.8),
            popover: hsl(20., 14.3, 4.1),
            popover_foreground: hsl(60., 9.1, 97.8),
            primary: hsl(60., 9.1, 97.8),
            primary_foreground: hsl(24., 9.8, 10.),
            secondary: hsl(12., 6.5, 15.1),
            secondary_foreground: hsl(60., 9.1, 97.8),
            muted: hsl(12., 6.5, 15.1),
            muted_foreground: hsl(24., 5.4, 63.9),
            accent,
            accent_foreground: hsl(60., 9.1, 97.8),
            destructive: hsl(13., 80., 60.),
            destructive_foreground: hsl(60., 9.1, 97.8),
            border: hsl(12., 6.5, 15.1),
            input: hsl(12., 6.5, 15.1),
            ring: hsl(24., 5.7, 82.9),
            brand: hex(0xd98a6b),
            success: hex(0xa3a68a),
            warning: hex(0xeb6a45),
            highlight: hex(0xe8c9b8),
            logo: hex(0xd98a6b),
            chrome_wash: rgba(255, 255, 255, 0.05),
            accent_hover: accent.opacity(0.6),
            selection: hex(0xd98a6b).opacity(0.3),
            ..Self::metrics()
        }
    }

    fn metrics() -> Self {
        let c = Hsla::default();
        Self {
            dark: false,
            background: c,
            foreground: c,
            card: c,
            card_foreground: c,
            popover: c,
            popover_foreground: c,
            primary: c,
            primary_foreground: c,
            secondary: c,
            secondary_foreground: c,
            muted: c,
            muted_foreground: c,
            accent: c,
            accent_foreground: c,
            destructive: c,
            destructive_foreground: c,
            border: c,
            input: c,
            ring: c,
            brand: c,
            success: c,
            warning: c,
            highlight: c,
            logo: c,
            chrome_wash: c,
            accent_hover: c,
            selection: c,
            radius_lg: rem(0.5),
            radius_md: rem(0.5) - px(2.),
            radius_sm: rem(0.5) - px(4.),
            text_2xs: rem(0.625),
            text_xs: rem(0.75),
            text_sm: rem(0.875),
            text_base: rem(1.),
            leading_2xs: rem(0.875),
            leading_xs: rem(1.),
            leading_sm: rem(1.25),
            leading_base: rem(1.5),
            icon_sm: sp(3.5),
            icon_md: sp(4.),
            header_height: rem(1.5),
            shell_gap: sp(2.),
        }
    }

    /// The logo asset for this appearance (the pear on its tile).
    pub fn logo_asset(&self) -> &'static str {
        if self.dark { "notefig/logo-dark.svg" } else { "notefig/logo-light.svg" }
    }
}

struct TokenPair {
    light: Tokens,
    dark: Tokens,
}

impl Global for TokenPair {}

/// The tokens of the current appearance.
pub fn tokens(cx: &App) -> &Tokens {
    let pair = cx.global::<TokenPair>();
    if Theme::global(cx).is_dark() { &pair.dark } else { &pair.light }
}

/// Whether the app is in dark mode.
pub fn is_dark(cx: &App) -> bool {
    Theme::global(cx).is_dark()
}

/// Switch appearance (`theme-provider.tsx`'s `setTheme`). `None` follows
/// the OS.
pub fn set_appearance(dark: Option<bool>, window: Option<&mut Window>, cx: &mut App) {
    let mode = match dark {
        Some(true) => ThemeMode::Dark,
        Some(false) => ThemeMode::Light,
        None => match window.as_ref().map(|w| w.appearance()) {
            Some(gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark) => ThemeMode::Dark,
            _ => ThemeMode::Light,
        },
    };
    Theme::change(mode, window, cx);
}

struct FontsLoaded;
impl Global for FontsLoaded {}

/// Register the fonts, the token pair and the gpui-kit theme pair built
/// from the same tokens. Called by [`crate::init`].
pub(crate) fn init(cx: &mut App) {
    if !cx.has_global::<FontsLoaded>() {
        let fonts: Vec<Cow<'static, [u8]>> = vec![
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-400-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-400-italic.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-500-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-600-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-700-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/libre-baskerville-latin-400-normal.ttf")),
            // The welcome title's serif: bold and bold italic (TS bundles
            // these two faces and no regular italic).
            Cow::Borrowed(include_bytes!("../assets/fonts/libre-baskerville-latin-700-normal.ttf")),
            Cow::Borrowed(include_bytes!("../assets/fonts/libre-baskerville-latin-700-italic.ttf")),
        ];
        if let Err(err) = cx.text_system().add_fonts(fonts) {
            log::warn!("bundled fonts failed to load: {err:#}");
        }
        cx.set_global(FontsLoaded);
    }
    cx.set_global(TokenPair {
        light: Tokens::light(),
        dark: Tokens::dark(),
    });
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
