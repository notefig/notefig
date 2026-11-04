//! Port of `scratchpads.test.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use futures::FutureExt;
use notefig_core::testing::TestExecutor;
use notefig_core::Hooks;
use notefig_files::{FilesDeps, create_workspace_files};
use notefig_platform::fake::FakePlatform;

use crate::*;

const DIR: &str = "/ws/.notefig/scratchpads";

fn setup(lands: bool) -> (Rc<TestExecutor>, FakePlatform, WorkspaceScratchpads, Rc<RefCell<Vec<String>>>) {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed_dir("/ws");
    let files = create_workspace_files(FilesDeps {
        workspace_path: "/ws".into(),
        fs: fake.platform.fs.clone(),
        hooks: Hooks::new(exec.clone(), Rc::new(|_, _| {})),
        executor: exec.clone(),
    });
    exec.run_until_parked();
    let opened: Rc<RefCell<Vec<String>>> = Rc::default();
    let o = opened.clone();
    let pads = create_workspace_scratchpads(ScratchpadsDeps {
        workspace_path: "/ws".into(),
        files,
        fs: fake.platform.fs.clone(),
        lands_on_startup: Rc::new(move || futures::future::ready(lands).boxed_local()),
        open_tab: Rc::new(move |p| o.borrow_mut().push(p.to_string())),
    });
    (exec, fake, pads, opened)
}

#[test]
fn recognizes_scratchpads_by_folder_membership_not_filename() {
    assert!(is_scratchpad_file(Some(".notefig/scratchpads/a.md"), true));
    assert!(is_scratchpad_file(Some(".notefig/scratchpads/notes.txt"), true));
    assert!(!is_scratchpad_file(Some(".notefig/scratchpads/x/a.md"), true));
    assert!(!is_scratchpad_file(Some(".notefig/scratchpads"), false));
    assert!(!is_scratchpad_file(Some("sunny-otter.md"), true));
    assert!(!is_scratchpad_file(None, true));
}

#[test]
fn generates_collision_free_names_counter_suffixed_as_a_last_resort() {
    let n = random_scratchpad_basename(&[]);
    assert!(n.ends_with(".md") && n.contains('-'));
    // Every pair taken: a counter suffix.
    let mut all = Vec::new();
    for a in ["amber", "breezy", "bright", "bubbly", "brave", "cheery", "chipper", "coral", "cozy", "dandy", "dapper", "dreamy", "fuzzy", "gentle", "glossy", "golden", "groovy", "humble", "indigo", "jolly", "lilac", "lively", "lucky", "mellow", "merry", "minty", "nimble", "olive", "peppy", "perky", "plucky", "quirky", "rosy", "silky", "snug", "sprightly", "sunny", "tidy", "velvet", "witty", "zesty"] {
        for b in ["acorn", "badger", "beaver", "brook", "bunny", "chipmunk", "clover", "dolphin", "falcon", "fox", "gecko", "hedgehog", "heron", "kitten", "koala", "lemur", "magpie", "maple", "marmot", "meadow", "newt", "ocelot", "otter", "owl", "panda", "pebble", "penguin", "puffin", "quokka", "raccoon", "robin", "seal", "sparrow", "squirrel", "tanuki", "toucan", "walrus", "willow", "wombat", "yak"] {
            all.push(format!("{a}-{b}.MD"));
        }
    }
    assert!(random_scratchpad_basename(&all).ends_with("-2.md"));
}

#[test]
fn picks_the_most_recent_deterministic_without_stats() {
    assert_eq!(pick_most_recent_scratchpad(&[("/d/a.md".into(), Some(1)), ("/d/b.md".into(), Some(5))]), "/d/b.md");
    assert_eq!(pick_most_recent_scratchpad(&[("/d/a.md".into(), None), ("/d/b.md".into(), None)]), "/d/b.md");
}

#[test]
fn protects_only_the_app_dir_and_the_folder_itself() {
    assert!(is_protected_tree_path(".notefig"));
    assert!(is_protected_tree_path(".notefig/scratchpads"));
    assert!(!is_protected_tree_path(".notefig/scratchpads/a.md"));
}

#[test]
fn strips_prompt_markers_only() {
    assert_eq!(strip_prompt_markers("<!-- notefig:prompt id=\"blob_1\" task=\"task_2\" -->\n").trim(), "");
    assert_eq!(strip_prompt_markers("<!-- other -->"), "<!-- other -->");
}

#[test]
fn create_makes_a_generated_name_file_in_the_folder() {
    let (exec, fake, pads, opened) = setup(true);
    let path = exec.block_on(pads.create()).unwrap();
    assert!(path.starts_with(&format!("{DIR}/")));
    assert_eq!(fake.fs.read(&path).as_deref(), Some(""));
    exec.block_on(pads.create_and_open());
    assert_eq!(opened.borrow().len(), 1);
}

#[test]
fn create_throws_when_a_file_squats_on_the_folder_path() {
    let (exec, fake, pads, _) = setup(true);
    fake.fs.seed("/ws/.notefig", "x");
    // A row for the squatter, as a walk of a real disk would list it.
    exec.block_on(pads_files(&pads).record_disk_changes(vec!["/ws/.notefig".into()], vec![]));
    assert!(exec.block_on(pads.create()).is_err());
}

fn pads_files(pads: &WorkspaceScratchpads) -> notefig_files::WorkspaceFiles {
    pads.files().clone()
}

#[test]
fn enter_creates_one_when_the_folder_is_missing_and_reuses_the_most_recent() {
    let (exec, fake, pads, _) = setup(true);
    let first = exec.block_on(pads.enter(vec![])).unwrap();
    assert!(fake.fs.read(&first).is_some());
    // Its row is recorded without a walk.
    assert!(pads.files().metadata().contains(&first));
    fake.fs.seed(&format!("{DIR}/kept.md"), "words");
    let landing = exec.block_on(pads.enter(vec![])).unwrap();
    // The empty one was swept; the one with words is where we land.
    assert_eq!(landing, format!("{DIR}/kept.md"));
    assert!(fake.fs.read(&first).is_none());
    assert!(!pads.files().metadata().contains(&first));
}

#[test]
fn enter_lands_nowhere_with_scratchpad_on_startup_off_but_still_sweeps() {
    let (exec, fake, pads, _) = setup(false);
    fake.fs.seed(&format!("{DIR}/empty.md"), "  \n");
    assert_eq!(exec.block_on(pads.enter(vec![])), None);
    assert!(fake.fs.read(&format!("{DIR}/empty.md")).is_none());
}

#[test]
fn sweep_spares_kept_paths_and_content_regardless_of_name() {
    let (exec, fake, pads, _) = setup(true);
    fake.fs.seed(&format!("{DIR}/open.md"), "");
    fake.fs.seed(&format!("{DIR}/My Notes.md"), "");
    fake.fs.seed(&format!("{DIR}/full.md"), "text");
    fake.fs.seed(&format!("{DIR}/prompt.md"), "<!-- notefig:prompt id=\"blob_a\" task=\"task_b\" -->\n");
    exec.block_on(pads.sweep(vec![format!("{DIR}/open.md")]));
    assert!(fake.fs.read(&format!("{DIR}/open.md")).is_some());
    assert!(fake.fs.read(&format!("{DIR}/full.md")).is_some());
    assert!(fake.fs.read(&format!("{DIR}/My Notes.md")).is_none());
    assert!(fake.fs.read(&format!("{DIR}/prompt.md")).is_none());
}

#[test]
fn sweep_does_nothing_when_the_folder_is_missing() {
    let (exec, _fake, pads, _) = setup(true);
    exec.block_on(pads.sweep(vec![]));
}
