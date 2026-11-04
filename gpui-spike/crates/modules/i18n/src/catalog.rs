//! The catalogs and i18next's lookup rules: dotted keys, `{{var}}`
//! interpolation, `_one`/`_other` plurals, `returnObjects` for arrays.

use std::cell::RefCell;
use std::sync::OnceLock;

use serde_json::Value;

fn catalog(code: &str) -> Option<&'static Value> {
    static EN: OnceLock<Value> = OnceLock::new();
    match code {
        "en" => Some(EN.get_or_init(|| serde_json::from_str(include_str!("../locales/en.json")).expect("en.json"))),
        _ => None,
    }
}

/// The Language setting's codes → catalog codes. Only `en` ships.
fn catalog_code(language: &str) -> &'static str {
    match language {
        "english" | "en" => "en",
        "spanish" | "es" => "es",
        "french" | "fr" => "fr",
        "german" | "de" => "de",
        "japanese" | "ja" => "ja",
        "arabic" | "ar" => "ar",
        "hebrew" | "he" => "he",
        _ => "en",
    }
}

thread_local! {
    static CURRENT: RefCell<&'static str> = const { RefCell::new("en") };
}

pub(crate) fn set_current(language: &str) {
    CURRENT.with(|c| *c.borrow_mut() = catalog_code(language));
}

fn lookup(key: &str) -> Option<&'static Value> {
    let current = CURRENT.with(|c| *c.borrow());
    let find = |cat: &'static Value| {
        let mut v = cat;
        for part in key.split('.') {
            v = v.get(part)?;
        }
        Some(v)
    };
    catalog(current).and_then(find).or_else(|| catalog("en").and_then(find))
}

/// Whether the catalog has `key`.
pub fn has_key(key: &str) -> bool {
    lookup(key).is_some()
}

fn interpolate(text: &str, args: &[(&str, &str)]) -> String {
    let mut out = text.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{{{name}}}}}"), value);
    }
    out
}

/// `t(key)`: the string, or the key itself when missing.
pub fn t(key: &str) -> String {
    t_args(key, &[])
}

/// `t(key, { name: value })`.
pub fn t_args(key: &str, args: &[(&str, &str)]) -> String {
    match lookup(key) {
        Some(Value::String(s)) => interpolate(s, args),
        _ => key.to_string(),
    }
}

/// `t(key, { count })`: picks `key_one` / `key_other` (English rules).
pub fn t_count(key: &str, count: i64) -> String {
    t_count_args(key, count, &[])
}

pub fn t_count_args(key: &str, count: i64, args: &[(&str, &str)]) -> String {
    let suffix = if count == 1 { "one" } else { "other" };
    let plural = format!("{key}_{suffix}");
    let count_s = count.to_string();
    let mut all: Vec<(&str, &str)> = vec![("count", &count_s)];
    all.extend_from_slice(args);
    if has_key(&plural) { t_args(&plural, &all) } else { t_args(key, &all) }
}

/// `t(key, { returnObjects: true })` for a list of strings; empty if not one.
pub fn t_list(key: &str) -> Vec<String> {
    match lookup(key) {
        Some(Value::Array(items)) => items.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}
