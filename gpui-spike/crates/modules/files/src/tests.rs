//! Ports of `files.test.ts`, `metadata-collection.test.ts`,
//! `file-sync-ignore.test.ts`, `file-sync-watcher-isolation.test.ts`,
//! `files-watching.test.ts` and `file-search.test.tsx`, over the fake
//! platform.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, Hooks, ModuleRef, Services};
use notefig_platform::fake::FakePlatform;
use notefig_platform::{EntryType, MetadataChange, MetadataChangeKind, PlatformService};

use crate::file_score::FileSearchOptions;
use crate::file_search::{FileSearch, searched_workspaces};
use crate::{FilesChanged, FilesDeps, FilesModule, GitStale, WorkspaceFiles, create_workspace_files};

fn setup(seed: &[(&str, &str)]) -> (Rc<TestExecutor>, FakePlatform, WorkspaceFiles) {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed_dir("/ws");
    for (p, c) in seed {
        fake.fs.seed(p, c);
    }
    let hooks = Hooks::new(exec.clone(), Rc::new(|e, w| panic!("{w}: {e:#}")));
    let files = create_workspace_files(FilesDeps {
        workspace_path: "/ws".into(),
        fs: fake.platform.fs.clone(),
        hooks,
        executor: exec.clone(),
    });
    exec.run_until_parked();
    (exec, fake, files)
}

fn rels(files: &WorkspaceFiles) -> Vec<String> {
    let mut v: Vec<String> = files.metadata().rows().iter().filter_map(|r| r.relative_path.clone()).collect();
    v.sort();
    v
}

#[test]
fn create_writes_to_the_fs_and_entry_joins_metadata_and_content() {
    let (exec, fake, files) = setup(&[]);
    let f = files.file("/ws/new.md");
    exec.block_on(f.create("# Hi")).unwrap();
    assert_eq!(fake.fs.read("/ws/new.md").as_deref(), Some("# Hi"));
    let entry = f.entry().unwrap();
    assert_eq!(&*entry.content, "# Hi");
    assert_eq!(entry.relative_path.as_deref(), Some("new.md"));
    assert_eq!(entry.kind, EntryType::File);
    // write updates the content row in place.
    exec.block_on(f.write("changed", None)).unwrap();
    assert_eq!(f.content().as_deref(), Some("changed"));
    assert!(files.file("/ws/nope.md").entry().is_none());
}

#[test]
fn listing_has_typed_rows_without_stats_until_hydrated() {
    let (exec, _fake, files) = setup(&[("/ws/a.md", "a"), ("/ws/d/b.md", "bb"), ("/ws/d/e/c.md", "c")]);
    assert_eq!(rels(&files), vec!["a.md", "d", "d/b.md", "d/e", "d/e/c.md"]);
    assert!(files.metadata().get("/ws/d/b.md").unwrap().size.is_none());
    exec.block_on(files.hydrate_directory_stats(vec!["/ws/d".into()]));
    assert_eq!(files.metadata().get("/ws/d/b.md").unwrap().size, Some(2));
    // Direct children only.
    assert!(files.metadata().get("/ws/d/e/c.md").unwrap().size.is_none());
    // A refetch keeps hydrated stats.
    exec.block_on(files.refresh());
    assert_eq!(files.metadata().get("/ws/d/b.md").unwrap().size, Some(2));
}

#[test]
fn a_walk_drops_what_it_no_longer_lists_and_keeps_unchanged_rows_identical() {
    let (exec, fake, files) = setup(&[("/ws/a.md", "a"), ("/ws/b.md", "b")]);
    let before = files.metadata().get("/ws/a.md").unwrap();
    fake.fs.seed("/ws/c.md", "c");
    // Remove b without notifying anyone: only a walk sees it.
    exec.block_on(fake.platform.fs.delete_files(vec!["/ws/b.md".into()]));
    exec.block_on(files.refresh());
    assert_eq!(rels(&files), vec!["a.md", "c.md"]);
    assert!(Rc::ptr_eq(&before, &files.metadata().get("/ws/a.md").unwrap()));
}

#[test]
fn a_directly_written_row_no_walk_lists_survives_walks() {
    let (exec, _fake, files) = setup(&[("/ws/a.md", "a")]);
    files.metadata().write_upsert(crate::FileMetadata {
        path: "/ws/node_modules/x".into(),
        relative_path: Some("node_modules/x".into()),
        kind: EntryType::File,
        modified_ms: None,
        size: None,
        content_hash: String::new(),
        error: None,
    });
    exec.block_on(files.refresh());
    assert!(files.metadata().contains("/ws/node_modules/x"));
}

#[test]
fn delete_and_rename_move_rows_and_content() {
    let (exec, fake, files) = setup(&[("/ws/d/a.md", "a"), ("/ws/b.md", "b")]);
    exec.block_on(files.load_content(vec!["/ws/d/a.md".into()]));
    exec.block_on(files.file("/ws/d").rename("/ws/e")).unwrap();
    assert_eq!(rels(&files), vec!["b.md", "e", "e/a.md"]);
    assert_eq!(files.content().get("/ws/e/a.md").unwrap().content.as_ref(), "a");
    assert!(exec.block_on(files.file("/ws/b.md").rename("/ws/e/a.md")).is_err());
    exec.block_on(files.file("/ws/e").delete()).unwrap();
    assert_eq!(rels(&files), vec!["b.md"]);
    assert!(fake.fs.trashed().contains(&"/ws/e".to_string()));
}

#[test]
fn create_clears_a_poisoned_content_row_and_not_found_reads_fabricate_nothing() {
    let (exec, _fake, files) = setup(&[]);
    exec.block_on(files.load_content(vec!["/ws/ghost.md".into()]));
    assert!(files.content().get("/ws/ghost.md").is_none());
    exec.block_on(files.file("/ws/ghost.md").create("")).unwrap();
    assert!(files.content().get("/ws/ghost.md").is_none());
}

#[test]
fn record_disk_changes_adds_rows_with_missing_ancestors_and_drops_deleted() {
    let (exec, fake, files) = setup(&[("/ws/old.md", "")]);
    fake.fs.seed("/ws/.notefig/scratchpads/sunny-otter.md", "");
    exec.block_on(files.record_disk_changes(vec!["/ws/.notefig/scratchpads/sunny-otter.md".into()], vec!["/ws/old.md".into()]));
    assert_eq!(rels(&files), vec![".notefig", ".notefig/scratchpads", ".notefig/scratchpads/sunny-otter.md"]);
}

#[test]
fn watcher_events_apply_to_rows_and_announce_files_changed() {
    let (exec, fake, files) = setup(&[("/ws/a.md", "a")]);
    let changed: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    let sink = changed.clone();
    let _sub = files.inner_hooks().on::<FilesChanged, _>(move |e| sink.borrow_mut().push(e.paths.clone()));
    assert!(files.is_watching());

    fake.fs.external_write("/ws/new.md", "x");
    exec.run_until_parked();
    assert!(files.metadata().contains("/ws/new.md"));

    // A loaded file follows an external change; an unloaded one does not load.
    exec.block_on(files.load_content(vec!["/ws/a.md".into()]));
    files.watch_content(vec!["/ws/a.md".into()]);
    exec.run_until_parked();
    fake.fs.external_write("/ws/a.md", "external");
    exec.run_until_parked();
    assert_eq!(files.content().get("/ws/a.md").unwrap().content.as_ref(), "external");

    fake.fs.external_rename("/ws/a.md", "/ws/b.md");
    exec.run_until_parked();
    assert!(!files.metadata().contains("/ws/a.md"));
    assert_eq!(files.content().get("/ws/b.md").unwrap().content.as_ref(), "external");

    fake.fs.external_delete("/ws/b.md");
    exec.run_until_parked();
    assert!(!files.metadata().contains("/ws/b.md"));
    assert!(changed.borrow().iter().any(|p| p == &vec!["/ws/b.md".to_string()]));
}

#[test]
fn a_save_in_flight_defers_an_external_content_event() {
    let (exec, fake, files) = setup(&[("/ws/a.md", "a")]);
    exec.block_on(files.load_content(vec!["/ws/a.md".into()]));
    files.watch_content(vec!["/ws/a.md".into()]);
    files.set_dirty_check(|p| p == "/ws/a.md");
    exec.run_until_parked();
    fake.fs.external_write("/ws/a.md", "external");
    exec.run_until_parked();
    assert_eq!(files.content().get("/ws/a.md").unwrap().content.as_ref(), "a");
}

#[test]
fn watcher_backstop_drops_ignored_paths_and_maps_renames_across_the_boundary() {
    let (exec, fake, files) = setup(&[("/ws/a.md", "a")]);
    let run = |changes: Vec<MetadataChange>| {
        let f = files.clone();
        exec.block_on(async move { crate::sync::handle_metadata(&f, changes).await });
    };
    fake.fs.seed("/ws/node_modules/x.js", "x");
    run(vec![MetadataChange { kind: MetadataChangeKind::Created, path: "/ws/node_modules/x.js".into(), is_directory: false }]);
    assert!(!files.metadata().contains("/ws/node_modules/x.js"));
    // Rename INTO ignored space: a delete of the old path.
    run(vec![MetadataChange {
        kind: MetadataChangeKind::Renamed { old_path: "/ws/a.md".into() },
        path: "/ws/dist/a.md".into(),
        is_directory: false,
    }]);
    assert!(!files.metadata().contains("/ws/a.md"));
    // Rename OUT of untracked space: a create at the new path.
    fake.fs.seed("/ws/back.md", "b");
    run(vec![MetadataChange {
        kind: MetadataChangeKind::Renamed { old_path: "/ws/dist/back.md".into() },
        path: "/ws/back.md".into(),
        is_directory: false,
    }]);
    assert!(files.metadata().contains("/ws/back.md"));
}

#[test]
fn writes_invalidate_derived_state_debounced() {
    let (exec, _fake, files) = setup(&[("/ws/a.md", "a")]);
    let stale = Rc::new(RefCell::new(0));
    let s = stale.clone();
    let _sub = files.inner_hooks().on::<GitStale, _>(move |_| *s.borrow_mut() += 1);
    exec.block_on(files.file("/ws/a.md").write("1", None)).unwrap();
    exec.block_on(files.file("/ws/a.md").write("2", None)).unwrap();
    exec.advance(Duration::from_millis(600));
    assert_eq!(*stale.borrow(), 1);
}

#[test]
fn dispose_stops_the_watch() {
    let (exec, fake, files) = setup(&[("/ws/a.md", "a")]);
    files.dispose();
    fake.fs.external_write("/ws/late.md", "x");
    exec.run_until_parked();
    assert!(!files.metadata().contains("/ws/late.md"));
}

fn core_with(fake: &FakePlatform, exec: &Rc<TestExecutor>) -> Core {
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(vec![ModuleRef::of::<FilesModule>()]),
    )
    .unwrap();
    core.boot();
    core
}

#[test]
fn the_module_opens_files_per_workspace_and_closes_them() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed("/ws/a.md", "a");
    let core = core_with(&fake, &exec);
    exec.block_on(core.workspace("/ws").open()).unwrap();
    exec.run_until_parked();
    let files = core.workspace("/ws").get::<FilesModule>().unwrap();
    assert!(files.metadata().contains("/ws/a.md"));
    exec.block_on(core.workspace("/ws").close());
    fake.fs.external_write("/ws/b.md", "b");
    exec.run_until_parked();
    assert!(!files.metadata().contains("/ws/b.md"));
}

#[test]
fn file_search_spans_open_workspaces_and_dedupes_nested_ones() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed("/ws/plan.md", "");
    fake.fs.seed("/ws/inner/notes.md", "");
    fake.fs.seed("/other/plan-b.md", "");
    let core = core_with(&fake, &exec);
    for ws in ["/ws", "/ws/inner", "/other"] {
        exec.block_on(core.workspace(ws).open()).unwrap();
    }
    exec.run_until_parked();
    let search = FileSearch::new();
    let wss = searched_workspaces(&core);
    let r = search.search(&wss, "plan", &FileSearchOptions::default(), None);
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].result.relative_path, "plan.md");
    let notes = search.search(&wss, "notes", &FileSearchOptions::default(), None);
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].workspace_path, "/ws/inner");
    assert_eq!(notes[0].result.relative_path, "notes.md");
    assert!(search.search(&wss, " ", &FileSearchOptions::default(), None).is_empty());
}
