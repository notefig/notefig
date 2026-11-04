//! Path scheme and naming (pure).

use std::time::{SystemTime, UNIX_EPOCH};

use notefig_files::paths::{basename, join};

/// The app-owned directory inside a workspace, and its one visible child
/// (`utils/app-dir.ts`).
pub const APP_DIR_NAME: &str = ".notefig";
pub const SCRATCHPADS_DIR_NAME: &str = "scratchpads";
pub const SCRATCHPADS_REL_PATH: &str = ".notefig/scratchpads";

const ADJECTIVES: &[&str] = &[
    "amber", "breezy", "bright", "bubbly", "brave", "cheery", "chipper", "coral", "cozy", "dandy", "dapper",
    "dreamy", "fuzzy", "gentle", "glossy", "golden", "groovy", "humble", "indigo", "jolly", "lilac", "lively",
    "lucky", "mellow", "merry", "minty", "nimble", "olive", "peppy", "perky", "plucky", "quirky", "rosy", "silky",
    "snug", "sprightly", "sunny", "tidy", "velvet", "witty", "zesty",
];
const NOUNS: &[&str] = &[
    "acorn", "badger", "beaver", "brook", "bunny", "chipmunk", "clover", "dolphin", "falcon", "fox", "gecko",
    "hedgehog", "heron", "kitten", "koala", "lemur", "magpie", "maple", "marmot", "meadow", "newt", "ocelot",
    "otter", "owl", "panda", "pebble", "penguin", "puffin", "quokka", "raccoon", "robin", "seal", "sparrow",
    "squirrel", "tanuki", "toucan", "walrus", "willow", "wombat", "yak",
];

fn rng() -> impl FnMut(usize) -> usize {
    let mut state = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9E37_79B9) | 1;
    move |n| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % n as u64) as usize
    }
}

/// A fresh `adjective-noun.md` avoiding `existing` (case-insensitive);
/// after a bounded retry the last pick gets a counter suffix.
pub fn random_scratchpad_basename(existing: &[String]) -> String {
    let taken: Vec<String> = existing.iter().map(|b| b.to_lowercase()).collect();
    let mut pick = rng();
    let mut name = String::new();
    for _ in 0..20 {
        name = format!("{}-{}", ADJECTIVES[pick(ADJECTIVES.len())], NOUNS[pick(NOUNS.len())]);
        if !taken.contains(&format!("{name}.md")) {
            return format!("{name}.md");
        }
    }
    let mut counter = 2;
    while taken.contains(&format!("{name}-{counter}.md")) {
        counter += 1;
    }
    format!("{name}-{counter}.md")
}

pub fn app_dir_path(workspace_path: &str) -> String {
    join(workspace_path, APP_DIR_NAME)
}

pub fn scratchpads_dir_path(workspace_path: &str) -> String {
    join(&app_dir_path(workspace_path), SCRATCHPADS_DIR_NAME)
}

/// A scratchpad is a file DIRECTLY in the folder, whatever its name.
pub fn is_scratchpad_file(relative_path: Option<&str>, is_file: bool) -> bool {
    let Some(rel) = relative_path.filter(|_| is_file) else { return false };
    rel.strip_prefix(SCRATCHPADS_REL_PATH)
        .and_then(|r| r.strip_prefix('/'))
        .is_some_and(|n| !n.is_empty() && !n.contains('/'))
}

/// Most recent by mtime; ties and missing stats fall back to the basename,
/// so the answer stays deterministic.
pub fn pick_most_recent_scratchpad(candidates: &[(String, Option<u64>)]) -> String {
    let mut best = &candidates[0];
    for c in &candidates[1..] {
        let (bt, ct) = (best.1.unwrap_or(0), c.1.unwrap_or(0));
        if ct > bt || (ct == bt && basename(&c.0) > basename(&best.0)) {
            best = c;
        }
    }
    best.0.clone()
}

/// Tree paths the user must not rename, delete or drag: the app dir and the
/// scratchpads folder themselves. Files inside stay editable.
pub fn is_protected_tree_path(relative_tree_path: &str) -> bool {
    relative_tree_path == APP_DIR_NAME || relative_tree_path == SCRATCHPADS_REL_PATH
}

/// The file with prompt-widget markers (`<!-- notefig:prompt id="…"
/// task="…" -->`, MET-163) taken out: `stripPromptMarkers`.
pub fn strip_prompt_markers(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        match after.find("-->") {
            Some(end) if is_marker(&after[4..end]) => rest = &after[end + 3..],
            _ => {
                out.push_str("<!--");
                rest = &after[4..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_marker(inner: &str) -> bool {
    let id_ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let mut parts = inner.split_whitespace();
    if parts.next() != Some("notefig:prompt") {
        return false;
    }
    let attr = |p: Option<&str>, key: &str| {
        p.and_then(|p| p.strip_prefix(key)).and_then(|v| v.strip_prefix("=\"")).and_then(|v| v.strip_suffix('"')).is_some_and(id_ok)
    };
    attr(parts.next(), "id") && attr(parts.next(), "task") && parts.next().is_none()
}
