//! File search across every open workspace (MET-255), a port of
//! `file-search.ts`: each workspace's rows are ranked on their own (cached
//! by its metadata version) and only the top matches of each merged.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use notefig_core::{Core, Subscription};

use crate::file_score::{FileSearchOptions, FileSearchResult, RankRow, compare_scored_paths, rank_file_rows, search_key_of};
use crate::paths::relative_tree_path;
use crate::{FilesModule, WorkspaceFiles};

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceFileSearchResult {
    pub result: FileSearchResult,
    pub workspace_path: String,
}

/// One open workspace as the search sees it.
#[derive(Clone)]
pub struct SearchedWorkspace {
    pub path: String,
    pub files: WorkspaceFiles,
    /// Open workspaces inside this one: their files are found there.
    pub nested: Vec<String>,
}

/// The open workspaces' files (`createSearchedWorkspaces`).
pub fn searched_workspaces(core: &Core) -> Vec<SearchedWorkspace> {
    let paths: Vec<String> = core.workspaces().list().into_iter().map(|r| r.path).collect();
    paths
        .iter()
        .filter_map(|path| {
            let files = core.workspace(path).get::<FilesModule>().ok()?;
            let nested = paths
                .iter()
                .filter(|other| *other != path && relative_tree_path(path, other).is_some())
                .cloned()
                .collect();
            Some(SearchedWorkspace { path: path.clone(), files: (*files).clone(), nested })
        })
        .collect()
}

/// Re-run `listener` when any open workspace's files change, or one opens
/// or closes.
pub fn subscribe_searched_workspaces(core: &Core, listener: impl Fn() + 'static) -> Subscription {
    let listener: Rc<dyn Fn()> = Rc::new(listener);
    let per_ws: Rc<RefCell<Vec<Subscription>>> = Rc::default();
    let rebuild = {
        let core = core.clone();
        let per_ws = per_ws.clone();
        let listener = listener.clone();
        move || {
            *per_ws.borrow_mut() = searched_workspaces(&core)
                .into_iter()
                .map(|ws| {
                    let l = listener.clone();
                    ws.files.metadata().subscribe(move || l())
                })
                .collect();
        }
    };
    rebuild();
    let rebuild = Rc::new(rebuild);
    let r = rebuild.clone();
    let open = core.workspaces().subscribe(move || {
        r();
        listener();
    });
    Subscription::join(vec![open, Subscription::new(move || per_ws.borrow_mut().clear())])
}

/// A searchable file with its search key worked out once (`SearchRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRow {
    /// Absolute path.
    pub path: String,
    /// Lowercased relative path.
    pub search_key: String,
    pub relative_path: String,
}

struct CachedRows {
    version: u64,
    rows: Rc<Vec<SearchRow>>,
}

/// A searcher that remembers each workspace's rows per metadata version
/// (`createFileSearch`).
#[derive(Default)]
pub struct FileSearch {
    rows: RefCell<HashMap<String, CachedRows>>,
}

impl FileSearch {
    pub fn new() -> Self {
        Self::default()
    }

    /// A workspace's searchable rows (files only, nested workspaces' files
    /// left to them), rebuilt only when its metadata changed. For quick
    /// open and pickers that rank on their own.
    pub fn rows(&self, ws: &SearchedWorkspace) -> Rc<Vec<SearchRow>> {
        self.rows_of(ws)
    }

    fn rows_of(&self, ws: &SearchedWorkspace) -> Rc<Vec<SearchRow>> {
        let version = ws.files.metadata().version();
        if let Some(c) = self.rows.borrow().get(&ws.path)
            && c.version == version
        {
            return c.rows.clone();
        }
        let rows: Vec<SearchRow> = ws
            .files
            .metadata()
            .rows()
            .into_iter()
            .filter(|r| !r.is_dir())
            .filter_map(|r| {
                let rel = r.relative_path.clone()?;
                if ws.nested.iter().any(|inner| relative_tree_path(inner, &r.path).is_some()) {
                    return None;
                }
                Some(SearchRow { path: r.path.clone(), search_key: search_key_of(&rel), relative_path: rel })
            })
            .collect();
        let rows = Rc::new(rows);
        self.rows.borrow_mut().insert(ws.path.clone(), CachedRows { version, rows: rows.clone() });
        rows
    }

    /// Rank every workspace, merge, keep `limit`. `prefer` wins ties.
    pub fn search(
        &self,
        workspaces: &[SearchedWorkspace],
        query: &str,
        options: &FileSearchOptions,
        prefer: Option<&str>,
    ) -> Vec<WorkspaceFileSearchResult> {
        let limit = options.limit.unwrap_or(crate::file_score::DEFAULT_FILE_SEARCH_LIMIT);
        let mut merged: Vec<WorkspaceFileSearchResult> = Vec::new();
        for ws in workspaces {
            let rows = self.rows_of(ws);
            let ranked = rank_file_rows(
                rows.iter().map(|r| RankRow { path: &r.path, relative_path: Some(&r.relative_path), search_key: Some(&r.search_key) }),
                query,
                &FileSearchOptions { limit: Some(limit), ..options.clone() },
            );
            merged.extend(ranked.into_iter().map(|result| WorkspaceFileSearchResult { result, workspace_path: ws.path.clone() }));
        }
        merged.sort_by(|a, b| {
            b.result
                .score
                .partial_cmp(&a.result.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| (Some(b.workspace_path.as_str()) == prefer).cmp(&(Some(a.workspace_path.as_str()) == prefer)))
                .then_with(|| compare_scored_paths(a.result.score, &a.result.relative_path, b.result.score, &b.result.relative_path))
        });
        merged.truncate(limit);
        merged
    }
}
