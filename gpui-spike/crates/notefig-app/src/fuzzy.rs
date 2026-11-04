//! Fuzzy ranking for quick open and the command palette (nucleo-matcher).

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher};

/// Indices of `items` matching `query`, best first, at most `limit`. An empty
/// query keeps the input order.
pub fn rank<S: AsRef<str>>(items: &[S], query: &str, paths: bool, limit: usize) -> Vec<usize> {
    if query.trim().is_empty() {
        return (0..items.len().min(limit)).collect();
    }
    let config = if paths {
        Config::DEFAULT.match_paths()
    } else {
        Config::DEFAULT
    };
    let mut matcher = Matcher::new(config);
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();
    let mut scored: Vec<(usize, u32)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let hay = nucleo_matcher::Utf32Str::new(s.as_ref(), &mut buf);
            pattern.score(hay, &mut matcher).map(|score| (i, score))
        })
        .collect();
    // Higher score first; shorter strings win ties.
    scored.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| items[a.0].as_ref().len().cmp(&items[b.0].as_ref().len()))
    });
    scored.into_iter().take(limit).map(|(i, _)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_paths() {
        let items = ["notes/today.md", "README.md", "src/notes.rs", "todo.md"];
        let r = rank(&items, "todmd", true, 10);
        assert_eq!(items[r[0]], "todo.md");
        assert!(rank(&items, "zzz", true, 10).is_empty());
        assert_eq!(rank(&items, "", true, 2), vec![0, 1]);
    }
}
