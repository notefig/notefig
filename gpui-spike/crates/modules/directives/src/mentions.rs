//! The mention text contract the directives read: a port of
//! `@notefig/widgets` `composer/draft-text.ts`'s `segmentMentions` /
//! `extractMentionPaths`, and `composer/mention-suggestion.ts`'s
//! directive half (`DirectiveCandidate`, `DirectiveSource`,
//! `findDirective`). Pure: the composer views reuse them.

use std::rc::Rc;

/// Paths with more space-separated words than this don't resolve.
const MAX_MENTION_WORDS: usize = 16;
const TRAILING_PUNCTUATION: &[char] = &['.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"', '`'];

/// The line's word-boundary prefixes after an "@", shortest first.
fn mention_candidates(rest: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    let mut in_word = false;
    for (i, c) in rest.char_indices() {
        if c.is_whitespace() {
            if in_word {
                candidates.push(&rest[..i]);
                if candidates.len() == MAX_MENTION_WORDS {
                    return candidates;
                }
            }
            in_word = false;
        } else {
            in_word = true;
        }
    }
    if in_word && candidates.len() < MAX_MENTION_WORDS {
        candidates.push(rest);
    }
    candidates
}

/// Multi-word candidates must look like a filename or consume the line.
fn is_plausible_mention(candidate: &str, rest: &str) -> bool {
    if !candidate.contains(char::is_whitespace) || candidate.len() == rest.len() {
        return true;
    }
    let last_word = candidate.rsplit(char::is_whitespace).next().unwrap_or("");
    last_word.contains('.')
}

fn resolve_candidate(candidate: &str, is_path: &dyn Fn(&str) -> bool) -> Option<String> {
    if is_path(candidate) {
        return Some(candidate.to_string());
    }
    let stripped = candidate.trim_end_matches(TRAILING_PUNCTUATION);
    (!stripped.is_empty() && stripped != candidate && is_path(stripped)).then(|| stripped.to_string())
}

/// Longest accepted candidate, with the length the match consumed.
fn longest_mention(rest: &str, is_path: &dyn Fn(&str) -> bool) -> Option<(String, usize)> {
    mention_candidates(rest)
        .into_iter()
        .rev()
        .filter(|c| is_plausible_mention(c, rest))
        .find_map(|c| resolve_candidate(c, is_path).map(|hit| (hit, c.len())))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MentionSegment {
    Text(String),
    Mention(String),
}

/// Split a prompt into plain-text runs and resolved mentions, in order. For
/// each "@" at the start or after whitespace, the line's word prefixes are
/// tried longest first (with trailing punctuation stripped as a fallback);
/// tokens nothing accepts are just text.
pub fn segment_mentions(text: &str, is_path: &dyn Fn(&str) -> bool) -> Vec<MentionSegment> {
    let mut segments = Vec::new();
    let mut plain_from = 0;
    let mut search_from = 0;
    while let Some(at) = next_mention_start(text, search_from) {
        let start = at + 1;
        let line_end = text[start..].find('\n').map_or(text.len(), |i| start + i);
        let rest = &text[start..line_end];
        search_from = start;
        if rest.is_empty() || rest.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((hit, consumed)) = longest_mention(rest, is_path) else { continue };
        if at > plain_from {
            segments.push(MentionSegment::Text(text[plain_from..at].to_string()));
        }
        plain_from = start + hit.len();
        segments.push(MentionSegment::Mention(hit));
        search_from = start + consumed;
    }
    if text.len() > plain_from {
        segments.push(MentionSegment::Text(text[plain_from..].to_string()));
    }
    segments
}

/// The next "@" at or after `from` that starts the text or follows
/// whitespace at or after `from` (the TS `/(?:^|\s)@/g` from `lastIndex`).
fn next_mention_start(text: &str, from: usize) -> Option<usize> {
    let mut prev: Option<(usize, char)> = None;
    for (i, c) in text[from..].char_indices().map(|(i, c)| (i + from, c)) {
        if c == '@' {
            let starts = i == 0 || prev.is_some_and(|(_, p)| p.is_whitespace());
            if starts {
                return Some(i);
            }
        }
        prev = Some((i, c));
    }
    None
}

/// Every distinct resolved mention in a finished prompt, in order.
pub fn extract_mention_paths(text: &str, is_path: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for segment in segment_mentions(text, is_path) {
        if let MentionSegment::Mention(value) = segment
            && !found.contains(&value)
        {
            found.push(value);
        }
    }
    found
}

/// One pickable value of a directive namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveCandidate {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

/// A namespace as the "@" suggestion sees it: its name and what it offers now.
#[derive(Clone)]
pub struct DirectiveSource {
    pub name: String,
    pub candidates: Rc<dyn Fn() -> Vec<DirectiveCandidate>>,
}

/// `findDirective`: the source and value a `<namespace>:<value>` token
/// names, if that namespace offers the value now.
pub fn find_directive<'a>(sources: &'a [DirectiveSource], token: &str) -> Option<(&'a DirectiveSource, String)> {
    let colon = token.find(':').filter(|c| *c > 0)?;
    let source = sources.iter().find(|s| s.name == token[..colon])?;
    let value = &token[colon + 1..];
    (source.candidates)().iter().any(|c| c.value == value).then(|| (source, value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(c: &str) -> bool {
        ["notes.md", "my notes.md", "a/b.md"].contains(&c)
    }

    #[test]
    fn segments_mentions_longest_first_keeping_trailing_punctuation_as_text() {
        let segs = segment_mentions("see @my notes.md. and @a/b.md, x @nope @ end", &files);
        assert_eq!(
            segs,
            vec![
                MentionSegment::Text("see ".into()),
                MentionSegment::Mention("my notes.md".into()),
                MentionSegment::Text(". and ".into()),
                MentionSegment::Mention("a/b.md".into()),
                MentionSegment::Text(", x @nope @ end".into()),
            ]
        );
    }

    #[test]
    fn needs_whitespace_before_the_at_and_stops_at_the_line() {
        assert_eq!(segment_mentions("a@notes.md", &files), vec![MentionSegment::Text("a@notes.md".into())]);
        assert_eq!(
            segment_mentions("@notes.md\n@notes.md", &files),
            vec![
                MentionSegment::Mention("notes.md".into()),
                MentionSegment::Text("\n".into()),
                MentionSegment::Mention("notes.md".into()),
            ]
        );
        assert_eq!(extract_mention_paths("@notes.md and @notes.md", &files), vec!["notes.md".to_string()]);
    }

    #[test]
    fn finds_a_directive_only_when_its_namespace_offers_the_value() {
        let sources = vec![DirectiveSource {
            name: "model".into(),
            candidates: Rc::new(|| vec![DirectiveCandidate { value: "opus".into(), label: "Opus".into(), description: None }]),
        }];
        assert_eq!(find_directive(&sources, "model:opus").map(|(s, v)| (s.name.clone(), v)), Some(("model".into(), "opus".into())));
        assert!(find_directive(&sources, "model:nope").is_none());
        assert!(find_directive(&sources, ":opus").is_none());
        assert!(find_directive(&sources, "skill:opus").is_none());
    }
}
