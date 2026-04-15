use crate::walkdir_utils::{check_circular_symlink, walk_directory, WalkOptions};
use grep::searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use grep_regex::RegexMatcher;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Window};

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

/// Event payload for search results (includes search_id for correlation)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultEvent {
    search_id: String,
    result: SearchMatch,
}

/// Event payload for search completion
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCompleteEvent {
    search_id: String,
    count: usize,
}

/// State for managing search cancellation per search_id
pub struct SearchState {
    /// Map of search_id -> cancellation token
    active_searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SearchState {
    pub fn new() -> Self {
        Self {
            active_searches: Mutex::new(HashMap::new()),
        }
    }

    /// Register a new search and return its cancellation token
    pub fn register(&self, search_id: &str) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        let mut searches = self.active_searches.lock().unwrap();
        searches.insert(search_id.to_string(), token.clone());
        token
    }

    /// Cancel a specific search by ID
    pub fn cancel(&self, search_id: &str) {
        let searches = self.active_searches.lock().unwrap();
        if let Some(token) = searches.get(search_id) {
            token.store(true, Ordering::SeqCst);
        }
    }

    /// Remove a search from tracking (called when search completes)
    pub fn unregister(&self, search_id: &str) {
        let mut searches = self.active_searches.lock().unwrap();
        searches.remove(search_id);
    }
}

impl Default for SearchState {
    fn default() -> Self {
        Self::new()
    }
}

/// Custom Sink implementation that streams matches via Tauri events
struct StreamingSink<'a> {
    window: &'a Window,
    cancellation_token: &'a AtomicBool,
    search_id: &'a str,
    file_path: String,
    count: &'a mut usize,
    max_results: usize,
    matcher: &'a RegexMatcher,
}

impl<'a> Sink for StreamingSink<'a> {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        // Check cancellation
        if self.cancellation_token.load(Ordering::SeqCst) {
            return Ok(false); // Stop searching
        }

        // Get line content (trim trailing newline)
        let line_content = String::from_utf8_lossy(mat.bytes())
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();

        // Find all matches in the line using the matcher
        use grep::matcher::Matcher;
        let mut matches_in_line = Vec::new();
        let _ = self.matcher.find_iter(mat.bytes(), |m| {
            matches_in_line.push((m.start(), m.end()));
            true
        });

        // Emit a result for each match in the line
        for (start, end) in matches_in_line {
            if self.cancellation_token.load(Ordering::SeqCst) || *self.count >= self.max_results {
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

            let search_match = SearchMatch {
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
            };

            // Emit result via Tauri event with search_id
            let event = SearchResultEvent {
                search_id: self.search_id.to_string(),
                result: search_match,
            };
            if let Err(e) = self.window.emit("search-result", &event) {
                eprintln!("Failed to emit search result: {}", e);
            }

            *self.count += 1;
        }

        // Continue searching unless we've hit max results
        Ok(*self.count < self.max_results)
    }
}

/// Search files in a directory and stream results via Tauri events
#[tauri::command]
pub async fn search_files_stream(
    search_id: String,
    directory: String,
    query: String,
    use_regex: bool,
    case_sensitive: bool,
    file_pattern: Option<String>,
    exclude_patterns: Option<Vec<String>>,
    max_results: Option<usize>,
    window: Window,
    state: tauri::State<'_, SearchState>,
) -> Result<(), String> {
    // Register this search and get its cancellation token
    let cancellation_token = state.register(&search_id);

    // Ensure we unregister when done (using a guard pattern)
    let _cleanup = scopeguard::guard(search_id.clone(), |id| {
        state.unregister(&id);
    });

    // Validate query
    if query.is_empty() {
        return Err("Query cannot be empty".to_string());
    }

    // Truncate query if too long
    let query = if query.len() > 1000 {
        query[..1000].to_string()
    } else {
        query
    };

    // Build regex pattern
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
    let mut count = 0;
    let visited = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));

    // Parse exclude patterns (e.g., gitignore patterns)
    let exclude_patterns = exclude_patterns.unwrap_or_default();

    // Create searcher with optimal settings
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .build();

    // Set up walk options using shared utilities
    let dir_path = PathBuf::from(&directory);

    if !dir_path.exists() {
        return Err(format!("Directory not found: {}", directory));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", directory));
    }

    let walk_options = WalkOptions {
        follow_links: true,
        exclude_hidden: true,
        exclude_patterns,
        base_path: dir_path.clone(),
    };

    // Use shared walk_directory utility
    let walk_result = walk_directory(&dir_path, &walk_options, |entry| {
        if cancellation_token.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }

        let path = entry.path();

        // Skip directories - we only search files
        if !path.is_file() {
            return Ok(());
        }

        // Check for circular symlinks
        {
            let mut visited_guard = visited.lock().unwrap();
            if check_circular_symlink(path, &mut visited_guard) {
                return Ok(()); // Skip circular symlinks
            }
        }

        // Check file pattern filter
        if let Some(ref pattern_str) = file_pattern {
            if !matches_file_pattern(path, pattern_str) {
                return Ok(());
            }
        }

        // Skip binary files by extension (additional check beyond grep's binary detection)
        if is_binary_by_extension(path) {
            return Ok(());
        }

        // Set up sink for this file
        let mut sink = StreamingSink {
            window: &window,
            cancellation_token: &cancellation_token,
            search_id: &search_id,
            file_path: path.to_string_lossy().to_string(),
            count: &mut count,
            max_results: max,
            matcher: &matcher,
        };

        // Search this file
        if let Err(e) = searcher.search_path(&matcher, path, &mut sink) {
            // Log but don't fail - continue searching other files
            eprintln!("Error searching {}: {}", path.display(), e);
        }

        // Check if we've hit max results
        if count >= max {
            return Err("Max results reached".to_string());
        }

        Ok(())
    });

    // Handle walk errors - "Cancelled" and "Max results reached" are not real errors
    if let Err(e) = walk_result {
        if e != "Cancelled" && e != "Max results reached" {
            return Err(e);
        }
    }

    // Emit completion event with search_id
    let complete_event = SearchCompleteEvent {
        search_id: search_id.clone(),
        count,
    };
    let _ = window.emit("search-complete", &complete_event);

    Ok(())
}

/// Cancel a specific search operation by ID
#[tauri::command]
pub fn cancel_search(search_id: String, state: tauri::State<'_, SearchState>) {
    state.cancel(&search_id);
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

    #[test]
    fn test_search_state_cancellation() {
        let state = SearchState::new();
        let token = state.register("test-search");
        assert!(!token.load(Ordering::SeqCst));

        state.cancel("test-search");
        assert!(token.load(Ordering::SeqCst));

        state.unregister("test-search");
    }

    #[test]
    fn test_search_state_multiple_searches() {
        let state = SearchState::new();
        let token1 = state.register("search-1");
        let token2 = state.register("search-2");

        // Cancel only search-1
        state.cancel("search-1");
        assert!(token1.load(Ordering::SeqCst));
        assert!(!token2.load(Ordering::SeqCst));

        // Cancel search-2
        state.cancel("search-2");
        assert!(token2.load(Ordering::SeqCst));
    }
}
