//! Scratchpads (MET-135), ported from `modules/scratchpads`: nameless new
//! notes live in `.notefig/scratchpads/` with a generated name
//! ("sunny-otter.md"). Entering a workspace sweeps abandoned empty ones and
//! lands on the most recent (or a fresh) scratchpad. Otherwise they are
//! ordinary files.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail};

use crate::rules::APP_DIR_NAME;
use crate::workspace::{Workspace, file_name};

pub const SCRATCHPADS_REL: &str = ".notefig/scratchpads";

const ADJECTIVES: &[&str] = &[
    "amber", "breezy", "bright", "bubbly", "brave", "cheery", "chipper", "coral", "cozy", "dandy",
    "dapper", "dreamy", "fuzzy", "gentle", "glossy", "golden", "groovy", "humble", "indigo",
    "jolly", "lilac", "lively", "lucky", "mellow", "merry", "minty", "nimble", "olive", "peppy",
    "perky", "plucky", "quirky", "rosy", "silky", "snug", "sprightly", "sunny", "tidy", "velvet",
    "witty", "zesty",
];
const NOUNS: &[&str] = &[
    "acorn", "badger", "beaver", "brook", "bunny", "chipmunk", "clover", "dolphin", "falcon", "fox",
    "gecko", "hedgehog", "heron", "kitten", "koala", "lemur", "magpie", "maple", "marmot", "meadow",
    "newt", "ocelot", "otter", "owl", "panda", "pebble", "penguin", "puffin", "quokka", "raccoon",
    "robin", "seal", "sparrow", "squirrel", "tanuki", "toucan", "walrus", "willow", "wombat", "yak",
];

/// Tree paths the user must not rename, delete or drag: the app dir and the
/// scratchpads folder themselves (files inside are ordinary).
pub fn is_protected(rel: &str) -> bool {
    rel == APP_DIR_NAME || rel == SCRATCHPADS_REL
}

/// A file directly inside the scratchpads folder.
pub fn is_scratchpad(rel: &str) -> bool {
    rel.strip_prefix(SCRATCHPADS_REL)
        .and_then(|r| r.strip_prefix('/'))
        .is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

/// A small xorshift seeded from the clock: names only need to look random.
fn rng() -> impl FnMut(usize) -> usize {
    let mut state = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9)
        | 1;
    move |n| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % n as u64) as usize
    }
}

/// A fresh `adjective-noun.md` not in `taken` (case-insensitive); after a
/// bounded retry the last pick gets a counter suffix.
pub fn random_basename(taken: &[String]) -> String {
    let taken: Vec<String> = taken.iter().map(|t| t.to_lowercase()).collect();
    let mut next = rng();
    let mut name = String::new();
    for _ in 0..20 {
        name = format!(
            "{}-{}",
            ADJECTIVES[next(ADJECTIVES.len())],
            NOUNS[next(NOUNS.len())]
        );
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

impl Workspace {
    /// Scratchpads on disk: (rel, modified).
    fn scratchpads_on_disk(&self) -> Vec<(String, SystemTime)> {
        let Ok(dir) = self.abs(SCRATCHPADS_REL) else {
            return Vec::new();
        };
        let Ok(read) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        read.filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let modified = e.metadata().ok()?.modified().unwrap_or(UNIX_EPOCH);
                Some((format!("{SCRATCHPADS_REL}/{name}"), modified))
            })
            .collect()
    }

    /// "New note": a fresh empty scratchpad. Returns its relative path.
    pub fn create_scratchpad(&self) -> Result<String> {
        for blocked in [APP_DIR_NAME, SCRATCHPADS_REL] {
            if self.abs(blocked)?.is_file() {
                bail!("a file occupies the scratchpads folder path ({blocked})");
            }
        }
        let taken: Vec<String> = self
            .scratchpads_on_disk()
            .iter()
            .map(|(r, _)| file_name(r).to_string())
            .collect();
        let rel = format!("{SCRATCHPADS_REL}/{}", random_basename(&taken));
        self.create_file(&rel, "")?;
        Ok(rel)
    }

    /// Delete whitespace-only scratchpads not in `keep`. Returns the deleted.
    pub fn sweep_scratchpads(&self, keep: &[String]) -> Vec<String> {
        let mut deleted = Vec::new();
        for (rel, _) in self.scratchpads_on_disk() {
            if keep.contains(&rel) {
                continue;
            }
            let empty = self
                .abs(&rel)
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .is_some_and(|t| t.trim().is_empty());
            if empty && self.delete_quiet(&rel).is_ok() {
                deleted.push(rel);
            }
        }
        deleted
    }

    /// Entering a workspace: sweep, then the most recent scratchpad (ties
    /// broken by name) or a fresh one.
    pub fn enter_scratchpad(&self, keep: &[String]) -> Result<String> {
        self.sweep_scratchpads(keep);
        let pads = self.scratchpads_on_disk();
        match pads
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| file_name(&a.0).cmp(file_name(&b.0))))
        {
            Some((rel, _)) => Ok(rel),
            None => self.create_scratchpad(),
        }
    }

    /// Remove without the trash (empty app-owned files).
    fn delete_quiet(&self, rel: &str) -> Result<()> {
        std::fs::remove_file(self.abs(rel)?)?;
        self.known.lock().unwrap().hashes.remove(rel);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths() {
        let name = random_basename(&[]);
        assert!(name.ends_with(".md") && name.contains('-'));
        assert!(is_scratchpad(".notefig/scratchpads/a.md"));
        assert!(!is_scratchpad(".notefig/scratchpads/x/a.md"));
        assert!(!is_scratchpad(".notefig/scratchpads"));
        assert!(is_protected(".notefig") && is_protected(".notefig/scratchpads"));
        assert!(!is_protected(".notefig/scratchpads/a.md"));
    }

    #[test]
    fn create_sweep_enter() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        // Entering an empty workspace creates one.
        let first = ws.enter_scratchpad(&[]).unwrap();
        assert!(is_scratchpad(&first) && ws.exists(&first));
        // Entering again sweeps the empty one and makes a new one.
        let second = ws.enter_scratchpad(&[]).unwrap();
        assert!(!ws.exists(&first));
        // A kept (open) empty one survives; a non-empty one is the landing.
        ws.write(&second, "keep me").unwrap();
        let kept_empty = ws.create_scratchpad().unwrap();
        let landing = ws.enter_scratchpad(&[kept_empty.clone()]).unwrap();
        assert!(ws.exists(&kept_empty));
        assert!(landing == second || landing == kept_empty);
        assert!(ws.scan().unwrap().contains_key(&second));
    }
}
