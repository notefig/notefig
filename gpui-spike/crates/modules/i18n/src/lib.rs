//! Localization: a port of `packages/desktop/src/utils/intl.ts` (i18next)
//! with the same keys and the same locales. `locales/en.json` is generated
//! from the TS catalog (it is the only locale the TS app ships).
//!
//! # Using it from a view (every owner)
//!
//! ```ignore
//! use notefig_i18n::{t, t_args, t_count};
//!
//! t("openFolder")                                   // "Open Folder"
//! t("hotkeyLabels.closeTab")                        // nested keys use dots
//! t_args("searchIn", &[("workspace", "ref-ws")])    // "Search ref-ws"   ({{workspace}})
//! t_count("searchResultCount", 3)                   // "3 results"       (_one / _other)
//! t_list("commandKeywords.undo")                    // ["undo", "revert", "back"] (returnObjects)
//! ```
//!
//! These read the **current language** (see below) and fall back to English,
//! then to the key itself, exactly as i18next does with `fallbackLng: "en"`.
//! Strings are `SharedString`-friendly `String`s; wrap with `.into()`.
//!
//! Interpolation is not escaped (`escapeValue: false`, as in TS).
//!
//! # Language and direction
//!
//! The language is app state, owned by [`I18nModule`]
//! (`core.use_::<I18nModule>()`): `language()`, `set_language(code)`,
//! `subscribe(listener)` so a view re-renders on a switch (wrap with
//! `notefig_ui::observe`). The free [`t`] functions read the language the
//! module last set (a process-wide current locale, the Rust form of the
//! i18next singleton the TS components import). Settings → General →
//! Language calls `set_language`; the codes are [`LANGUAGES`]. A code with
//! no catalog falls back to English, as in TS (which ships only `en`).
//!
//! Text direction is a per-workspace project setting in TS
//! (`project-settings`: `"ltr" | "rtl"`); [`Direction`] is its type here and
//! [`Direction::for_language`] is the default a language implies (Arabic,
//! Hebrew → RTL). Views that lay out by direction read the workspace's
//! setting and flip their flex rows with [`Direction::is_rtl`].

mod catalog;

use std::cell::RefCell;
use std::rc::Rc;

pub use catalog::{has_key, t, t_args, t_count, t_count_args, t_list};

use notefig_core::{Listeners, Module, ModuleContext, Subscription};

/// The Language setting's choices: `(code, i18n key of its label)`. The TS
/// select uses these values (`english`, `spanish`…).
pub const LANGUAGES: &[(&str, &str)] = &[
    ("english", "english"),
    ("spanish", "spanish"),
    ("french", "french"),
    ("german", "german"),
    ("japanese", "japanese"),
    ("arabic", "arabic"),
    ("hebrew", "hebrew"),
];

/// `"ltr" | "rtl"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Direction {
    #[default]
    Ltr,
    Rtl,
}

impl Direction {
    pub fn is_rtl(self) -> bool {
        self == Direction::Rtl
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Ltr => "ltr",
            Direction::Rtl => "rtl",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "rtl" { Direction::Rtl } else { Direction::Ltr }
    }

    /// The direction a language reads in.
    pub fn for_language(code: &str) -> Self {
        match code {
            "arabic" | "hebrew" | "ar" | "he" => Direction::Rtl,
            _ => Direction::Ltr,
        }
    }
}

/// `core.use_::<I18nModule>()`: the app's language.
pub struct I18nApi {
    language: RefCell<String>,
    changed: Rc<Listeners<()>>,
}

pub fn create_i18n(language: &str) -> I18nApi {
    catalog::set_current(language);
    I18nApi { language: RefCell::new(language.to_string()), changed: Rc::new(Listeners::new()) }
}

impl I18nApi {
    pub fn language(&self) -> String {
        self.language.borrow().clone()
    }

    /// Switch language; every `t()` reads it from now on.
    pub fn set_language(&self, code: &str) {
        if *self.language.borrow() == code {
            return;
        }
        *self.language.borrow_mut() = code.to_string();
        catalog::set_current(code);
        self.changed.emit();
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    pub fn t(&self, key: &str) -> String {
        t(key)
    }
}

/// The i18n module: registers the language (English at start, as the TS
/// detector resolves in every build that ships only `en`).
pub struct I18nModule;

impl Module for I18nModule {
    const NAME: &'static str = "i18n";
    type Api = I18nApi;
    type Workspace = ();

    fn register(_ctx: &ModuleContext) -> I18nApi {
        create_i18n("english")
    }
}

#[cfg(test)]
mod tests;
