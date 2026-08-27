use crate::walkdir_utils::{
    check_circular_symlink, has_ignored_extension, walk_directory, WalkOptions,
};
use grep::searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use grep_regex::RegexMatcher;
use serde::Serialize;
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Position in a file (1-indexed)
#[derive(Debug, Clone, Serialize)]
pub struct FilePosition {
    pub line: usize,
    pub column: usize,
}

/// Range in a file
#[derive(Debug, Clone, Serialize)]
pub struct FileRange {
    pub start: FilePosition,
    pub end: FilePosition,
}

/// Location of a search match
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchLocation {
    pub file_path: String,
    pub range: FileRange,
}

/// Content and context of a search match
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchContent {
    pub match_text: String,
    pub line_content: String,
    pub before_context: Vec<String>,
    pub after_context: Vec<String>,
}

/// A single search match result
#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub location: SearchMatchLocation,
    pub content: SearchMatchContent,
}

/// Sink that collects matches into a Vec
struct CollectingSink<'a> {
    file_path: String,
    results: &'a mut Vec<SearchMatch>,
    max_results: usize,
    matcher: &'a RegexMatcher,
}

impl<'a> Sink for CollectingSink<'a> {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        let line_content = String::from_utf8_lossy(mat.bytes())
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();

        use grep::matcher::Matcher;
        let mut matches_in_line = Vec::new();
        let _ = self.matcher.find_iter(mat.bytes(), |m| {
            matches_in_line.push((m.start(), m.end()));
            true
        });

        for (start, end) in matches_in_line {
            if self.results.len() >= self.max_results {
                return Ok(false);
            }

            // Calculate column positions (1-indexed, character-based)
            let start_column = line_content[..start.min(line_content.len())]
                .chars()
                .count()
                + 1;
            let end_column = line_content[..end.min(line_content.len())]
                .chars()
                .count()
                + 1;

            let match_text = if end <= line_content.len() {
                line_content[start..end].to_string()
            } else {
                String::new()
            };

            let line_num = mat.line_number().unwrap_or(0) as usize;

            self.results.push(SearchMatch {
                location: SearchMatchLocation {
                    file_path: self.file_path.clone(),
                    range: FileRange {
                        start: FilePosition {
                            line: line_num,
                            column: start_column,
                        },
                        end: FilePosition {
                            line: line_num,
                            column: end_column,
                        },
                    },
                },
                content: SearchMatchContent {
                    match_text,
                    line_content: line_content.clone(),
                    before_context: vec![],
                    after_context: vec![],
                },
            });
        }

        Ok(self.results.len() < self.max_results)
    }
}

/// Search content in files within a directory and return all matches
#[tauri::command]
pub async fn search_content(
    directory: String,
    query: String,
    use_regex: bool,
    case_sensitive: bool,
    file_pattern: Option<String>,
    file_includes: Option<Vec<String>>,
    max_results: Option<usize>,
    ignore_directories: Option<Vec<String>>,
    ignore_extensions: Option<Vec<String>>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Err("Query cannot be empty".to_string());
    }

    let query = if query.len() > 1000 {
        query[..1000].to_string()
    } else {
        query
    };

    let pattern = if use_regex {
        if case_sensitive {
            query.clone()
        } else {
            format!("(?i){}", query)
        }
    } else {
        // Escape special regex characters for literal search
        let escaped = regex::escape(&query);
        if case_sensitive {
            escaped
        } else {
            format!("(?i){}", escaped)
        }
    };

    let matcher =
        RegexMatcher::new(&pattern).map_err(|e| format!("Invalid pattern: {}", e))?;

    let max = max_results.unwrap_or(1000);
    let mut results: Vec<SearchMatch> = Vec::new();
    let visited = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));

    // Parse file_includes into a HashSet for fast lookup
    let file_includes: Option<HashSet<PathBuf>> = file_includes.map(|paths| {
        paths.into_iter().map(PathBuf::from).collect()
    });

    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .build();

    let dir_path = PathBuf::from(&directory);

    if !dir_path.exists() {
        return Err(format!("Directory not found: {}", directory));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", directory));
    }

    let ignore_extensions = ignore_extensions.unwrap_or_default();
    let walk_options = WalkOptions {
        follow_links: true,
        exclude_hidden: true,
        exclude_patterns: ignore_directories.unwrap_or_default(),
        base_path: dir_path.clone(),
    };

    let walk_result = walk_directory(&dir_path, &walk_options, |entry| {
        let path = entry.path();

        if !path.is_file() {
            return Ok(());
        }

        if has_ignored_extension(path, &ignore_extensions) {
            return Ok(());
        }

        {
            let mut visited_guard = visited.lock().unwrap();
            if check_circular_symlink(path, &mut visited_guard) {
                return Ok(());
            }
        }

        if let Some(ref includes) = file_includes {
            if !includes.contains(&path.to_path_buf()) {
                return Ok(());
            }
        }

        if let Some(ref pattern_str) = file_pattern {
            if !matches_file_pattern(path, pattern_str) {
                return Ok(());
            }
        }

        // Skip binary files by extension (additional check beyond grep's binary detection)
        if is_binary_by_extension(path) {
            return Ok(());
        }

        let mut sink = CollectingSink {
            file_path: path.to_string_lossy().to_string(),
            results: &mut results,
            max_results: max,
            matcher: &matcher,
        };

        if let Err(e) = searcher.search_path(&matcher, path, &mut sink) {
            // Log but don't fail - continue searching other files
            eprintln!("Error searching {}: {}", path.display(), e);
        }

        if results.len() >= max {
            return Err("Max results reached".to_string());
        }

        Ok(())
    });

    // Handle walk errors - "Max results reached" is not a real error
    if let Err(e) = walk_result {
        if e != "Max results reached" {
            return Err(e);
        }
    }

    Ok(results)
}

/// Check if a file path matches a file pattern (e.g., "*.md", "*.txt")
fn matches_file_pattern(path: &Path, pattern: &str) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    // Convert glob pattern to regex
    let regex_pattern = pattern
        .replace('.', "\\.")
        .replace('*', ".*")
        .replace('?', ".");

    if let Ok(re) = regex::Regex::new(&format!("^{}$", regex_pattern)) {
        return re.is_match(file_name);
    }

    // Fallback to exact match if regex fails
    file_name == pattern
}

/// Check if a file should be skipped based on its extension
fn is_binary_by_extension(path: &Path) -> bool {
    const BINARY_EXTENSIONS: &[&str] = &[
        // Images
        "jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif",
        // Video
        "mp4", "mov", "avi", "mkv", "webm", "wmv", "flv",
        // Audio
        "mp3", "wav", "ogg", "flac", "aac", "m4a", "wma",
        // Archives
        "zip", "tar", "gz", "bz2", "7z", "rar", "xz",
        // Documents (binary)
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        // Executables
        "exe", "dll", "so", "dylib", "bin", "app",
        // Databases
        "db", "sqlite", "sqlite3",
        // Other binary
        "lock", "woff", "woff2", "ttf", "otf", "eot",
    ];

    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| BINARY_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matches_file_pattern_exact() {
        let path = Path::new("/workspace/test.md");
        assert!(matches_file_pattern(path, "test.md"));
        assert!(!matches_file_pattern(path, "other.md"));
    }

    #[test]
    fn test_matches_file_pattern_glob() {
        let path = Path::new("/workspace/test.md");
        assert!(matches_file_pattern(path, "*.md"));
        assert!(matches_file_pattern(path, "test.*"));
        assert!(matches_file_pattern(path, "*.*"));
        assert!(!matches_file_pattern(path, "*.txt"));
    }

    #[test]
    fn test_matches_file_pattern_single_char() {
        let path = Path::new("/workspace/test.md");
        assert!(matches_file_pattern(path, "tes?.md"));
        assert!(matches_file_pattern(path, "????.md"));
        assert!(!matches_file_pattern(path, "???.md"));
    }

    #[test]
    fn test_is_binary_by_extension() {
        assert!(is_binary_by_extension(Path::new("image.png")));
        assert!(is_binary_by_extension(Path::new("video.mp4")));
        assert!(is_binary_by_extension(Path::new("archive.zip")));
        assert!(!is_binary_by_extension(Path::new("code.rs")));
        assert!(!is_binary_by_extension(Path::new("readme.md")));
        assert!(!is_binary_by_extension(Path::new("config.json")));
    }
}
