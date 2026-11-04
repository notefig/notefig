//! The palette's two rankers: cmdk's `defaultFilter` (the `command-score`
//! package) for commands, and `utils/file-score.ts` + the merge in
//! `modules/files/file-search.ts` for quick-open file rows.

use std::collections::HashMap;

const SCORE_CONTINUE_MATCH: f64 = 1.;
const SCORE_SPACE_WORD_JUMP: f64 = 0.9;
const SCORE_NON_SPACE_WORD_JUMP: f64 = 0.8;
const SCORE_CHARACTER_JUMP: f64 = 0.17;
const SCORE_TRANSPOSITION: f64 = 0.1;
const PENALTY_SKIPPED: f64 = 0.999;
const PENALTY_CASE_MISMATCH: f64 = 0.9999;
const PENALTY_NOT_COMPLETE: f64 = 0.99;

fn is_gap(c: Option<char>) -> bool {
    matches!(c, Some('\\' | '/' | '_' | '+' | '.' | '#' | '"' | '@' | '[' | '(' | '{' | '&'))
}
fn is_space(c: Option<char>) -> bool {
    matches!(c, Some(c) if c.is_whitespace() || c == '-')
}

struct Inner<'a> {
    s: &'a [char],
    a: &'a [char],
    ls: &'a [char],
    la: &'a [char],
    memo: HashMap<(usize, usize), f64>,
}

impl Inner<'_> {
    fn index_of(&self, c: char, from: usize) -> Option<usize> {
        (from..self.ls.len()).find(|&i| self.ls[i] == c)
    }

    fn score(&mut self, si: usize, ai: usize) -> f64 {
        if ai == self.a.len() {
            return if si == self.s.len() { SCORE_CONTINUE_MATCH } else { PENALTY_NOT_COMPLETE };
        }
        if let Some(v) = self.memo.get(&(si, ai)) {
            return *v;
        }
        let ac = self.la[ai];
        let mut index = self.index_of(ac, si);
        let mut high = 0.;
        while let Some(ix) = index {
            let mut score = self.score(ix + 1, ai + 1);
            if score > high {
                let prev = if ix > 0 { Some(self.s[ix - 1]) } else { None };
                if ix == si {
                    score *= SCORE_CONTINUE_MATCH;
                } else if is_gap(prev) {
                    score *= SCORE_NON_SPACE_WORD_JUMP;
                    let breaks = self.s[si..ix.saturating_sub(1).max(si)].iter().filter(|c| is_gap(Some(**c))).count();
                    if breaks > 0 && si > 0 {
                        score *= PENALTY_SKIPPED.powi(breaks as i32);
                    }
                } else if is_space(prev) {
                    score *= SCORE_SPACE_WORD_JUMP;
                    let breaks = self.s[si..ix.saturating_sub(1).max(si)].iter().filter(|c| is_space(Some(**c))).count();
                    if breaks > 0 && si > 0 {
                        score *= PENALTY_SKIPPED.powi(breaks as i32);
                    }
                } else {
                    score *= SCORE_CHARACTER_JUMP;
                    if si > 0 {
                        score *= PENALTY_SKIPPED.powi((ix - si) as i32);
                    }
                }
                if self.s[ix] != self.a[ai] {
                    score *= PENALTY_CASE_MISMATCH;
                }
            }
            let prev_l = if ix > 0 { Some(self.ls[ix - 1]) } else { None };
            let next_a = self.la.get(ai + 1).copied();
            if (score < SCORE_TRANSPOSITION && prev_l.is_some() && prev_l == next_a)
                || (next_a == Some(self.la[ai]) && prev_l != Some(self.la[ai]))
            {
                let transposed = self.score(ix + 1, ai + 2);
                if transposed * SCORE_TRANSPOSITION > score {
                    score = transposed * SCORE_TRANSPOSITION;
                }
            }
            if score > high {
                high = score;
            }
            index = self.index_of(ac, ix + 1);
        }
        self.memo.insert((si, ai), high);
        high
    }
}

fn format_input(s: &str) -> Vec<char> {
    s.to_lowercase().chars().map(|c| if c.is_whitespace() || c == '-' { ' ' } else { c }).collect()
}

/// `commandScore(value, search, keywords)`: 0 is no match.
pub fn command_score(value: &str, search: &str, keywords: &[String]) -> f64 {
    let full = if keywords.is_empty() { value.to_string() } else { format!("{value} {}", keywords.join(" ")) };
    let s: Vec<char> = full.chars().collect();
    let a: Vec<char> = search.chars().collect();
    let (ls, la) = (format_input(&full), format_input(search));
    if ls.len() != s.len() || la.len() != a.len() {
        return 0.;
    }
    if ai_overflow(&a) {
        return 0.;
    }
    Inner { s: &s, a: &a, ls: &ls, la: &la, memo: HashMap::new() }.score(0, 0)
}

fn ai_overflow(a: &[char]) -> bool {
    a.len() > 200
}

// ── file-score.ts ──

const BONUS_START: f64 = 1.;
const BONUS_MID_WORD: f64 = 0.3;
const PATH_MATCH_FACTOR: f64 = 0.75;
const NO_MATCH: f64 = f64::NEG_INFINITY;

fn positional_bonus(t: &[char], j: usize) -> f64 {
    if j == 0 {
        return BONUS_START;
    }
    match t[j - 1] {
        '/' | '\\' | ' ' => 0.9,
        '-' | '_' | '.' => 0.8,
        _ => BONUS_MID_WORD,
    }
}

fn score_lowercased(q: &[char], t: &[char]) -> f64 {
    if q.is_empty() || q.len() > t.len() {
        return 0.;
    }
    let mut i = 0;
    for c in t {
        if i < q.len() && *c == q[i] {
            i += 1;
        }
    }
    if i != q.len() {
        return 0.;
    }
    let mut prev: Vec<f64> = t.iter().enumerate().map(|(j, c)| if *c == q[0] { positional_bonus(t, j) } else { NO_MATCH }).collect();
    let mut best = prev.iter().cloned().fold(NO_MATCH, f64::max);
    for &qc in &q[1..] {
        let mut row = vec![NO_MATCH; t.len()];
        let mut jump = NO_MATCH;
        best = NO_MATCH;
        for j in 1..t.len() {
            if j >= 2 {
                jump = jump.max(prev[j - 2]);
            }
            row[j] = if t[j] == qc { (prev[j - 1] + 1.).max(jump + positional_bonus(t, j)) } else { NO_MATCH };
            best = best.max(row[j]);
        }
        prev = row;
    }
    if best == NO_MATCH { 0. } else { best / q.len() as f64 }
}

/// `scoreFilePath`: the basename first, the whole path at a discount.
pub fn score_file_path(query: &str, relative_path: &str) -> f64 {
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if q.is_empty() {
        return 0.;
    }
    let t: Vec<char> = relative_path.to_lowercase().chars().collect();
    if q.contains(&'/') {
        return score_lowercased(&q, &t);
    }
    let base_start = t.iter().rposition(|c| *c == '/').map(|i| i + 1).unwrap_or(0);
    let base = score_lowercased(&q, &t[base_start..]);
    if base >= PATH_MATCH_FACTOR {
        return base;
    }
    base.max(score_lowercased(&q, &t) * PATH_MATCH_FACTOR)
}

/// One quick-open row.
#[derive(Debug, Clone, PartialEq)]
pub struct FileResult {
    pub path: String,
    pub relative_path: String,
    pub title: String,
    pub workspace_path: String,
    pub score: f64,
}

/// `DEFAULT_FILE_SEARCH_LIMIT`.
pub const FILE_SEARCH_LIMIT: usize = 10;

fn compare(a: &FileResult, b: &FileResult) -> std::cmp::Ordering {
    b.score
        .partial_cmp(&a.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then(a.relative_path.len().cmp(&b.relative_path.len()))
        .then(a.relative_path.cmp(&b.relative_path))
}

/// `useFileSearch(query, { filter, preferWorkspace })` over
/// `(workspace, absolute path, tree-relative path)` rows.
pub fn rank_files(rows: &[(String, String, String)], query: &str, prefer: Option<&str>, filter: impl Fn(&str) -> bool) -> Vec<FileResult> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let mut out: Vec<FileResult> = rows
        .iter()
        .filter_map(|(ws, path, rel)| {
            let score = score_file_path(query, rel);
            (score > 0. && filter(path)).then(|| FileResult {
                path: path.clone(),
                relative_path: rel.clone(),
                title: rel.rsplit('/').next().unwrap_or(rel).to_string(),
                workspace_path: ws.clone(),
                score,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| (Some(b.workspace_path.as_str()) == prefer).cmp(&(Some(a.workspace_path.as_str()) == prefer)))
            .then_with(|| compare(a, b))
    });
    out.truncate(FILE_SEARCH_LIMIT);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_score_filters_like_cmdk() {
        let kw = |k: &[&str]| k.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(command_score("New scratchpad", "ne", &[]) > 0.);
        assert!(command_score("Open Folder", "ne", &kw(&["open", "folder", "workspace", "directory"])) > 0.);
        assert_eq!(command_score("Close File", "ne", &kw(&["close", "file", "tab"])), 0.);
        assert_eq!(command_score("Redo", "ne", &kw(&["redo", "forward", "again"])), 0.);
        // A prefix outranks a scattered match.
        let undo = command_score("Undo", "ne", &kw(&["undo", "revert", "back"]));
        let search = command_score("Search in File", "ne", &kw(&["search", "find", "current", "file"]));
        assert!(search > undo, "{search} > {undo}");
        assert!(command_score("New file", "ne", &[]) > search);
    }

    #[test]
    fn ranks_files_by_basename_then_path() {
        let rows: Vec<(String, String, String)> = ["docs/getting-started.md", "notes/ideas.md", "README.md", ".notefig/scratchpads/lilac-brook.md"]
            .iter()
            .map(|r| ("/w".to_string(), format!("/w/{r}"), r.to_string()))
            .collect();
        let r = rank_files(&rows, "getting", Some("/w"), |_| true);
        assert_eq!(r[0].title, "getting-started.md");
        let r = rank_files(&rows, "ne", Some("/w"), |_| true);
        let titles: Vec<_> = r.iter().map(|f| f.title.as_str()).collect();
        assert!(titles.contains(&"ideas.md") && titles.contains(&"getting-started.md"));
        assert!(rank_files(&rows, "", None, |_| true).is_empty());
    }

    #[test]
    fn prefers_the_active_workspace_on_ties() {
        let rows = vec![
            ("/a".to_string(), "/a/x.md".to_string(), "x.md".to_string()),
            ("/b".to_string(), "/b/x.md".to_string(), "x.md".to_string()),
        ];
        assert_eq!(rank_files(&rows, "x", Some("/b"), |_| true)[0].workspace_path, "/b");
    }
}
