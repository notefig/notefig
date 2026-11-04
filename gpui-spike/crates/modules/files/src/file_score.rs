//! Path-aware fuzzy scoring for file search (MET-155): a port of
//! `utils/file-score.ts`. Pure, so ranking is unit-testable and shared by
//! every consumer (palette, mention picker, link completion).

use std::cmp::Ordering;

const BONUS_START: f64 = 1.0;
const BONUS_MID_WORD: f64 = 0.3;
/// A directory-segment-only match ranks below the same query matching a
/// basename.
const PATH_MATCH_FACTOR: f64 = 0.75;
const NO_MATCH: f64 = f64::NEG_INFINITY;
pub const DEFAULT_FILE_SEARCH_LIMIT: usize = 10;

fn boundary_bonus(c: char) -> Option<f64> {
    match c {
        '/' | '\\' | ' ' => Some(0.9),
        '-' | '_' | '.' => Some(0.8),
        _ => None,
    }
}

fn positional_bonus(t: &[char], j: usize) -> f64 {
    if j == 0 { BONUS_START } else { boundary_bonus(t[j - 1]).unwrap_or(BONUS_MID_WORD) }
}

fn is_subsequence(q: &[char], t: &[char]) -> bool {
    let mut i = 0;
    for &c in t {
        if i < q.len() && c == q[i] {
            i += 1;
        }
    }
    i == q.len()
}

/// The DP over lowercased chars; gives up (0) once `floor` is out of reach.
fn score_lowercased(q: &[char], t: &[char], floor: f64) -> f64 {
    if q.is_empty() || q.len() > t.len() || !is_subsequence(q, t) {
        return 0.0;
    }
    let mut prev = vec![NO_MATCH; t.len()];
    let mut row = vec![NO_MATCH; t.len()];
    let mut best = NO_MATCH;
    for j in 0..t.len() {
        prev[j] = if t[j] == q[0] { positional_bonus(t, j) } else { NO_MATCH };
        best = best.max(prev[j]);
    }
    for i in 1..q.len() {
        if (best + (q.len() - i) as f64) / q.len() as f64 / 1.0 < floor {
            return 0.0;
        }
        best = NO_MATCH;
        let mut jump = NO_MATCH;
        row[0] = NO_MATCH;
        for j in 1..t.len() {
            if j >= 2 {
                jump = jump.max(prev[j - 2]);
            }
            row[j] = if t[j] == q[i] { (prev[j - 1] + 1.0).max(jump + positional_bonus(t, j)) } else { NO_MATCH };
            best = best.max(row[j]);
        }
        std::mem::swap(&mut prev, &mut row);
    }
    if best == NO_MATCH { 0.0 } else { best / q.len() as f64 }
}

/// Case-insensitive subsequence match, scored in (0, 1]; 0 when no match.
pub fn fuzzy_score(query: &str, target: &str) -> f64 {
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = target.to_lowercase().chars().collect();
    score_lowercased(&q, &t, 0.0)
}

pub fn search_key_of(relative_path: &str) -> String {
    relative_path.to_lowercase()
}

fn score_search_key(q: &[char], t: &[char], floor: f64) -> f64 {
    if q.contains(&'/') {
        return score_lowercased(q, t, floor);
    }
    let base_start = t.iter().rposition(|c| *c == '/').map(|i| i + 1).unwrap_or(0);
    let basename = score_lowercased(q, &t[base_start..], floor);
    if basename >= PATH_MATCH_FACTOR || floor > PATH_MATCH_FACTOR {
        return basename;
    }
    let path_floor = floor.max(basename) / PATH_MATCH_FACTOR;
    basename.max(score_lowercased(q, t, path_floor) * PATH_MATCH_FACTOR)
}

/// Score a query against a workspace-relative path: a query with "/" is
/// matched against the whole path; otherwise the basename wins.
pub fn score_file_path(query: &str, relative_path: &str) -> f64 {
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if q.is_empty() {
        return 0.0;
    }
    let t: Vec<char> = search_key_of(relative_path).chars().collect();
    score_search_key(&q, &t, 0.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileSearchResult {
    pub path: String,
    pub relative_path: String,
    pub title: String,
    pub score: f64,
}

#[derive(Clone, Default)]
pub struct FileSearchOptions {
    /// Cap on returned rows (default 10).
    pub limit: Option<usize>,
    /// Openability gate; paths failing it never surface.
    pub filter: Option<std::rc::Rc<dyn Fn(&str) -> bool>>,
    /// Empty query lists files (shallowest first) instead of nothing.
    pub match_all_when_empty: bool,
}

/// Score desc, then shorter path, then lexicographic: a total order.
pub fn compare_scored_paths(a_score: f64, a_rel: &str, b_score: f64, b_rel: &str) -> Ordering {
    b_score
        .partial_cmp(&a_score)
        .unwrap_or(Ordering::Equal)
        .then(a_rel.len().cmp(&b_rel.len()))
        .then(a_rel.cmp(b_rel))
}

/// A row to rank: `(path, relative_path, search_key)`.
pub struct RankRow<'a> {
    pub path: &'a str,
    pub relative_path: Option<&'a str>,
    pub search_key: Option<&'a str>,
}

/// Rank rows against a query, keeping only the best `limit` as they stream.
pub fn rank_file_rows<'a>(rows: impl IntoIterator<Item = RankRow<'a>>, query: &str, options: &FileSearchOptions) -> Vec<FileSearchResult> {
    let limit = options.limit.unwrap_or(DEFAULT_FILE_SEARCH_LIMIT);
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if limit == 0 || (q.is_empty() && !options.match_all_when_empty) {
        return Vec::new();
    }
    let mut top: Vec<FileSearchResult> = Vec::new();
    for row in rows {
        let Some(rel) = row.relative_path.filter(|r| !r.is_empty()) else { continue };
        let floor = if top.len() >= limit { top[limit - 1].score } else { 0.0 };
        let score = if q.is_empty() {
            0.0
        } else {
            let key: Vec<char> = match row.search_key {
                Some(k) => k.chars().collect(),
                None => search_key_of(rel).chars().collect(),
            };
            let s = score_search_key(&q, &key, floor);
            if s <= 0.0 {
                continue;
            }
            s
        };
        if top.len() >= limit && compare_scored_paths(score, rel, top[limit - 1].score, &top[limit - 1].relative_path) != Ordering::Less {
            continue;
        }
        if let Some(filter) = &options.filter
            && !filter(row.path)
        {
            continue;
        }
        let result = FileSearchResult {
            path: row.path.to_string(),
            relative_path: rel.to_string(),
            title: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            score,
        };
        let at = top
            .iter()
            .position(|r| compare_scored_paths(score, rel, r.score, &r.relative_path) == Ordering::Less)
            .unwrap_or(top.len());
        top.insert(at, result);
        top.truncate(limit);
    }
    top
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_basename_scores_one_and_beats_directory_matches() {
        assert_eq!(score_file_path("readme", "docs/readme.md"), 1.0);
        assert!(score_file_path("docs", "docs/x.md") < score_file_path("docs", "a/docs.md"));
        assert_eq!(score_file_path("zz", "a.md"), 0.0);
        assert!(fuzzy_score("rdm", "readme") > 0.0);
    }

    #[test]
    fn ranks_with_limit_and_empty_query_rules() {
        let rels = ["notes/plan.md", "plan.md", "deep/a/plan-old.md", "other.md"];
        let rows = || rels.iter().map(|r| RankRow { path: r, relative_path: Some(r), search_key: None });
        let r = rank_file_rows(rows(), "plan", &FileSearchOptions::default());
        assert_eq!(r.iter().map(|x| x.relative_path.as_str()).collect::<Vec<_>>(), vec!["plan.md", "notes/plan.md", "deep/a/plan-old.md"]);
        assert!(rank_file_rows(rows(), "  ", &FileSearchOptions::default()).is_empty());
        let all = rank_file_rows(rows(), "", &FileSearchOptions { match_all_when_empty: true, limit: Some(2), ..Default::default() });
        assert_eq!(all.iter().map(|x| x.relative_path.as_str()).collect::<Vec<_>>(), vec!["plan.md", "other.md"]);
    }
}
