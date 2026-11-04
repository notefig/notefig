//! Full-text search over a workspace, ported from the Tauri `search_content`
//! command: grep-searcher + grep-regex, literal or regex, case-insensitive by
//! default, binary files skipped, results capped. Results stream per file
//! through a callback so the UI can show them as they arrive.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, bail};
use grep_matcher::Matcher as _;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};

use crate::workspace::Workspace;

pub const DEFAULT_MAX_RESULTS: usize = 1000;
const MAX_QUERY_LEN: usize = 1000;

#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub max_results: Option<usize>,
}

/// One match. Lines and columns are 1-based; columns count chars.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchMatch {
    pub rel: String,
    pub line: usize,
    pub start_column: usize,
    pub end_column: usize,
    pub match_text: String,
    pub line_content: String,
}

struct Collect<'a> {
    rel: &'a str,
    matcher: &'a RegexMatcher,
    out: &'a mut Vec<SearchMatch>,
    remaining: usize,
}

impl Sink for Collect<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let line = String::from_utf8_lossy(mat.bytes())
            .trim_end_matches(['\n', '\r'])
            .to_string();
        let mut ranges = Vec::new();
        let _ = self.matcher.find_iter(mat.bytes(), |m| {
            ranges.push((m.start(), m.end()));
            true
        });
        for (start, end) in ranges {
            if self.remaining == 0 {
                return Ok(false);
            }
            let (start, end) = (start.min(line.len()), end.min(line.len()));
            if !line.is_char_boundary(start) || !line.is_char_boundary(end) {
                continue;
            }
            self.out.push(SearchMatch {
                rel: self.rel.to_string(),
                line: mat.line_number().unwrap_or(0) as usize,
                start_column: line[..start].chars().count() + 1,
                end_column: line[..end].chars().count() + 1,
                match_text: line[start..end].to_string(),
                line_content: line.clone(),
            });
            self.remaining -= 1;
        }
        Ok(self.remaining > 0)
    }
}

pub fn build_matcher(query: &str, options: &SearchOptions) -> Result<RegexMatcher> {
    if query.is_empty() {
        bail!("query cannot be empty");
    }
    let query: String = query.chars().take(MAX_QUERY_LEN).collect();
    let body = if options.regex {
        query
    } else {
        regex_syntax::escape(&query)
    };
    let pattern = if options.case_sensitive {
        body
    } else {
        format!("(?i){body}")
    };
    Ok(RegexMatcher::new(&pattern)?)
}

impl Workspace {
    /// Search every walked text file. `on_file` receives each file's matches
    /// (in walk order) and returns false to stop. `cancel` stops early.
    /// Returns the number of matches found.
    pub fn search(
        &self,
        query: &str,
        options: &SearchOptions,
        cancel: &AtomicBool,
        mut on_file: impl FnMut(Vec<SearchMatch>) -> bool,
    ) -> Result<usize> {
        let matcher = build_matcher(query, options)?;
        let max = options.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .binary_detection(BinaryDetection::quit(b'\x00'))
            .build();
        let mut total = 0;
        for entry in self.walker() {
            if cancel.load(Ordering::Relaxed) || total >= max {
                break;
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Some(rel) = self.rel_of(entry.path()) else { continue };
            if crate::rules::is_ignored_rel(&rel) || is_binary_by_extension(&rel) {
                continue;
            }
            let mut found = Vec::new();
            let mut sink = Collect {
                rel: &rel,
                matcher: &matcher,
                out: &mut found,
                remaining: max - total,
            };
            if let Err(err) = searcher.search_path(&matcher, entry.path(), &mut sink) {
                log::debug!("search {rel}: {err}");
            }
            if !found.is_empty() {
                total += found.len();
                if !on_file(found) {
                    break;
                }
            }
        }
        Ok(total)
    }
}

fn is_binary_by_extension(rel: &str) -> bool {
    const BINARY: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif",
    ];
    rel.rsplit_once('.')
        .is_some_and(|(_, e)| BINARY.contains(&e.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_regex_case_and_cap() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        ws.write("a.md", "Hello world\nhello again (x)\n").unwrap();
        ws.write("dir/b.md", "say héllo hello\n").unwrap();
        ws.write("node_modules/c.md", "hello\n").unwrap();
        ws.write("img.png", "hello\n").unwrap();
        let cancel = AtomicBool::new(false);
        let mut all = Vec::new();
        let n = ws
            .search("hello", &SearchOptions::default(), &cancel, |m| {
                all.extend(m);
                true
            })
            .unwrap();
        assert_eq!(n, 3);
        assert_eq!(all[0].rel, "a.md");
        assert_eq!((all[0].line, all[0].start_column, all[0].end_column), (1, 1, 6));
        assert_eq!(all[0].match_text, "Hello");
        assert_eq!(all[2].rel, "dir/b.md");
        assert_eq!(all[2].start_column, 11); // char-based after "é"

        let case = SearchOptions {
            case_sensitive: true,
            ..Default::default()
        };
        let mut c = 0;
        ws.search("Hello", &case, &cancel, |m| {
            c += m.len();
            true
        })
        .unwrap();
        assert_eq!(c, 1);

        // Literal mode escapes regex syntax; regex mode does not.
        let mut lit = 0;
        ws.search("(x)", &SearchOptions::default(), &cancel, |m| {
            lit += m.len();
            true
        })
        .unwrap();
        assert_eq!(lit, 1);
        let re = SearchOptions {
            regex: true,
            ..Default::default()
        };
        let mut r = Vec::new();
        ws.search(r"h.llo\s+a", &re, &cancel, |m| {
            r.extend(m);
            true
        })
        .unwrap();
        assert_eq!(r.len(), 1);
        assert!(ws.search("(", &re, &cancel, |_| true).is_err());

        let capped = SearchOptions {
            max_results: Some(2),
            ..Default::default()
        };
        assert_eq!(ws.search("hello", &capped, &cancel, |_| true).unwrap(), 2);
    }
}
