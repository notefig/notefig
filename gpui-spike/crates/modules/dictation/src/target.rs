//! Port of `packages/dictation/src/target.ts`: the contract between the
//! dictation service and the editors it types into. An editor offers itself
//! as a target (`DictationApi::attach`), and each dictation into it is an
//! insertion. The editor crates implement these; this crate has no editor.

use std::rc::Rc;

/// One dictation into one editor, from key down to commit or cancel.
pub trait DictationInsertion {
    /// The words heard so far. Not final: the phrase still being spoken is
    /// re-heard as it goes.
    fn preview(&self, text: &str);
    /// Insert the final text where the dictation began (fit it with
    /// [`fit_dictation`] against the text around the caret).
    fn commit(&self, text: &str);
    /// Drop the ghost; nothing is inserted.
    fn cancel(&self);
}

/// An editor that can take dictation.
pub trait DictationTarget {
    fn has_focus(&self) -> bool;
    /// Starts a dictation at the selection; `None` when the editor isn't editable.
    fn begin(&self) -> Option<Rc<dyn DictationInsertion>>;
}

fn is_letter_or_digit(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric()
}

/// Fits dictated `text` between what's before and after the caret in its
/// block: a space on either side where words would otherwise touch, a
/// lowercase first word mid-sentence, no closing period when the sentence
/// carries on after it.
pub fn fit_dictation(before: &str, after: &str, text: &str) -> String {
    let mut fitted = text.trim().to_string();
    if fitted.is_empty() {
        return String::new();
    }
    // `/[.!?:]\s*$/`
    let ends_sentence = before.trim_end().ends_with(['.', '!', '?', ':']);
    let mid_sentence = !before.trim().is_empty() && !ends_sentence;
    let mut chars = fitted.chars();
    let first = chars.next();
    let second = chars.next();
    // `/^[A-Z][a-z]/` and not `/^I\b/`
    let capitalised_word = matches!(first, Some(c) if c.is_ascii_uppercase())
        && matches!(second, Some(c) if c.is_ascii_lowercase());
    let is_i = fitted.starts_with('I') && !fitted[1..].starts_with(|c: char| c.is_alphanumeric() || c == '_');
    if mid_sentence && capitalised_word && !is_i {
        fitted = fitted[..1].to_ascii_lowercase() + &fitted[1..];
    }
    // `/^\s*[a-z]/`
    if after.trim_start().starts_with(|c: char| c.is_ascii_lowercase()) {
        if let Some(stripped) = fitted.strip_suffix('.') {
            fitted = stripped.to_string();
        }
    }
    if !before.is_empty() && !before.ends_with(char::is_whitespace) {
        fitted = format!(" {fitted}");
    }
    if after.starts_with(is_letter_or_digit) {
        fitted.push(' ');
    }
    fitted
}
