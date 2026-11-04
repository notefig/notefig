//! Full-text search, ported from the Tauri `search_content` command
//! (`search.rs`): grep-searcher + grep-regex, literal or regex,
//! case-insensitive by default, binary files skipped, results capped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use grep_matcher::Matcher as _;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use notefig_platform::{EntryType, FsError, FsErrorKind, FsResult, ReadDirectoryOptions, SearchMatch, SearchOptions};

pub const DEFAULT_MAX_RESULTS: usize = 1000;
const MAX_QUERY_LEN: usize = 1000;
const BINARY_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif"];

fn build_matcher(options: &SearchOptions) -> FsResult<RegexMatcher> {
    let invalid = |message: String| FsError { kind: FsErrorKind::InvalidPath, path: String::new(), message };
    if options.query.is_empty() {
        return Err(invalid("query cannot be empty".into()));
    }
    let query: String = options.query.chars().take(MAX_QUERY_LEN).collect();
    let body = if options.use_regex { query } else { regex_syntax::escape(&query) };
    let pattern = if options.case_sensitive { body } else { format!("(?i){body}") };
    RegexMatcher::new(&pattern).map_err(|e| invalid(e.to_string()))
}

/// `*.md`-style globs on the file name: `*` any run, `?` one char.
fn glob_matches(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    go(&p, &n)
}

struct Collect<'a, F: FnMut(SearchMatch) -> bool> {
    file: &'a str,
    matcher: &'a RegexMatcher,
    emit: &'a mut F,
    remaining: usize,
    occurrences: HashMap<String, u32>,
    stopped: bool,
}

impl<F: FnMut(SearchMatch) -> bool> Sink for Collect<'_, F> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let line = String::from_utf8_lossy(mat.bytes()).trim_end_matches(['\n', '\r']).to_string();
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
            let text = line[start..end].to_string();
            let n = self.occurrences.entry(text.clone()).or_insert(0);
            let occurrence = *n;
            *n += 1;
            self.remaining -= 1;
            if !(self.emit)(SearchMatch {
                file_path: self.file.to_string(),
                match_text: text,
                line_text: line.clone(),
                line: mat.line_number().unwrap_or(0) as u32,
                occurrence,
            }) {
                self.stopped = true;
                return Ok(false);
            }
        }
        Ok(self.remaining > 0)
    }
}

/// Search every walked text file under `dir`, in walk order. `emit`
/// returns false to stop.
pub fn search(dir: &Path, options: &SearchOptions, mut emit: impl FnMut(SearchMatch) -> bool) -> FsResult<()> {
    let matcher = build_matcher(options)?;
    let mut remaining = options.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
    let entries = crate::fs::walk(
        dir,
        &ReadDirectoryOptions {
            recursive: true,
            include_files: true,
            include_directories: false,
            include_hidden: false,
            ignore: options.ignore.clone(),
        },
    )?;
    let includes: Vec<PathBuf> = options
        .file_includes
        .iter()
        .map(|p| if Path::new(p).is_absolute() { PathBuf::from(p) } else { dir.join(p) })
        .collect();
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .build();
    for entry in entries {
        if remaining == 0 {
            break;
        }
        if entry.kind != EntryType::File {
            continue;
        }
        let path = Path::new(&entry.path);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        if BINARY_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        if let Some(pattern) = &options.file_pattern
            && !glob_matches(pattern, name)
        {
            continue;
        }
        if !includes.is_empty() && !includes.iter().any(|inc| path == inc || path.starts_with(inc)) {
            continue;
        }
        let mut sink = Collect {
            file: &entry.path,
            matcher: &matcher,
            emit: &mut emit,
            remaining,
            occurrences: HashMap::new(),
            stopped: false,
        };
        if let Err(err) = searcher.search_path(&matcher, path, &mut sink) {
            log::debug!("search {}: {err}", entry.path);
        }
        remaining = sink.remaining;
        if sink.stopped {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_platform::IgnoreRules;

    #[test]
    fn literal_regex_case_cap_and_ignores() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let w = |rel: &str, s: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, s).unwrap();
        };
        w("a.md", "Hello world\nhello again (x)\n");
        w("dir/b.md", "say héllo hello\n");
        w("node_modules/c.md", "hello\n");
        w(".git/d.md", "hello\n");
        w("img.png", "hello\n");
        let ignore = Some(IgnoreRules { directories: vec!["node_modules".into()], extensions: vec![] });
        let run = |opts: SearchOptions| {
            let mut all = Vec::new();
            search(root, &opts, |m| {
                all.push(m);
                true
            })
            .map(|_| all)
        };
        let base = SearchOptions { query: "hello".into(), ignore: ignore.clone(), ..Default::default() };
        let all = run(base.clone()).unwrap();
        assert_eq!(all.len(), 3, "{all:?}");
        assert!(all[0].file_path.ends_with("a.md"));
        assert_eq!((all[0].line, all[0].match_text.as_str()), (1, "Hello"));
        assert_eq!(all[1].occurrence, 0);
        assert_eq!(run(SearchOptions { case_sensitive: true, query: "Hello".into(), ..base.clone() }).unwrap().len(), 1);
        assert_eq!(run(SearchOptions { query: "(x)".into(), ..base.clone() }).unwrap().len(), 1);
        assert_eq!(
            run(SearchOptions { query: r"h.llo\s+a".into(), use_regex: true, ..base.clone() }).unwrap().len(),
            1
        );
        assert!(run(SearchOptions { query: "(".into(), use_regex: true, ..base.clone() }).is_err());
        assert_eq!(run(SearchOptions { max_results: Some(2), ..base.clone() }).unwrap().len(), 2);
        assert_eq!(run(SearchOptions { file_pattern: Some("b.*".into()), ..base }).unwrap().len(), 1);
    }
}
