//! The pure parts of the search panel: grouping matches by file (sorted by
//! file name, as `groupedResults`), the highlighted segments of a result
//! line (`SearchResultItem`), and the ignore rules `useSearch` passes
//! (`utils/ignore.ts`'s `IGNORE_RULES`).

use notefig_platform::{IgnoreRules, SearchMatch};

/// `IGNORE_RULES` (the files module's `utils/ignore.ts`).
pub fn ignore_rules() -> IgnoreRules {
    notefig_files::ignore::ignore_rules()
}

/// `getFileName`.
pub fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// `deriveProjectName`.
pub fn project_name(path: &str) -> String {
    path.split(['/', '\\']).filter(|s| !s.is_empty()).next_back().unwrap_or("Untitled").to_string()
}

/// Matches grouped by file, files sorted by lowercased name.
pub fn group_by_file(results: &[SearchMatch]) -> Vec<(String, Vec<SearchMatch>)> {
    let mut groups: Vec<(String, Vec<SearchMatch>)> = Vec::new();
    for m in results {
        match groups.iter_mut().find(|(p, _)| *p == m.file_path) {
            Some((_, list)) => list.push(m.clone()),
            None => groups.push((m.file_path.clone(), vec![m.clone()])),
        }
    }
    groups.sort_by(|a, b| file_name(&a.0).to_lowercase().cmp(&file_name(&b.0).to_lowercase()));
    groups
}

/// The line split into plain and highlighted runs: every literal
/// occurrence of `query` (case-insensitively unless `case_sensitive`).
pub fn segments(line: &str, query: &str, case_sensitive: bool) -> Vec<(String, bool)> {
    if query.trim().is_empty() {
        return vec![(line.to_string(), false)];
    }
    let fold = |s: &str| if case_sensitive { s.to_string() } else { s.to_lowercase() };
    // Lowercasing can change byte lengths; fall back to no highlight then.
    let (hay, needle) = (fold(line), fold(query));
    if hay.len() != line.len() || needle.is_empty() {
        return vec![(line.to_string(), false)];
    }
    let mut out = Vec::new();
    let mut last = 0;
    let mut from = 0;
    while let Some(off) = hay[from..].find(&needle) {
        let start = from + off;
        let end = start + needle.len();
        if !line.is_char_boundary(start) || !line.is_char_boundary(end) {
            break;
        }
        if start > last {
            out.push((line[last..start].to_string(), false));
        }
        out.push((line[start..end].to_string(), true));
        last = end;
        from = end;
    }
    if last < line.len() {
        out.push((line[last..].to_string(), false));
    }
    if out.is_empty() { vec![(line.to_string(), false)] } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(path: &str, line: u32) -> SearchMatch {
        SearchMatch { file_path: path.into(), match_text: "x".into(), line_text: "x".into(), line, occurrence: 0 }
    }

    #[test]
    fn groups_by_file_sorted_by_name() {
        let g = group_by_file(&[m("/w/notes/ideas.md", 1), m("/w/README.md", 1), m("/w/notes/ideas.md", 2), m("/w/a/getting.md", 3)]);
        let names: Vec<_> = g.iter().map(|(p, l)| (file_name(p), l.len())).collect();
        assert_eq!(names, vec![("getting.md", 1), ("ideas.md", 2), ("README.md", 1)]);
    }

    #[test]
    fn highlights_every_occurrence_respecting_case() {
        assert_eq!(
            segments("Welcome to **Notefig** notefig", "notefig", false),
            vec![("Welcome to **".into(), false), ("Notefig".into(), true), ("** ".into(), false), ("notefig".into(), true)]
        );
        assert_eq!(segments("Notefig notefig", "notefig", true), vec![("Notefig ".into(), false), ("notefig".into(), true)]);
        assert_eq!(segments("a.b", ".", false)[1], (".".into(), true), "the query is literal");
        assert_eq!(segments("line", "", false), vec![("line".into(), false)]);
    }

    #[test]
    fn names_the_workspace() {
        assert_eq!(project_name("/Users/me/ref-ws/"), "ref-ws");
        assert_eq!(project_name(""), "Untitled");
    }
}
