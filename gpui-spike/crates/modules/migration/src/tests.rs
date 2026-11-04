//! The import over fixture dbs in the TanStack persistence layout. No TS
//! counterpart: these pin the Tauri db's format and the never-write rule.

use std::path::Path;
use std::rc::Rc;

use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_platform::fake::FakePlatform;
use notefig_platform::{Db, PlatformService};
use rusqlite::Connection;
use serde_json::json;

use crate::*;

/// A db shaped like the Tauri app's: the registry, one table per
/// collection, tombstones. WAL, with the connection kept open so the rows
/// sit in `-wal` (the copy must carry it).
fn fixture(dir: &Path, collections: &[(&str, &[(&str, serde_json::Value)])]) -> Connection {
    let conn = Connection::open(dir.join(DB_FILE_NAME)).unwrap();
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(())).unwrap();
    conn.execute_batch(
        "CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT NOT NULL UNIQUE,
           tombstone_table_name TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    )
    .unwrap();
    for (i, (id, rows)) in collections.iter().enumerate() {
        let table = format!("c_t{i}");
        conn.execute(
            "INSERT INTO collection_registry VALUES (?1, ?2, ?3, 1, 0)",
            rusqlite::params![id, table, format!("{table}_tomb")],
        )
        .unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE \"{table}\" (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, row_version INTEGER NOT NULL);
             CREATE TABLE \"{table}_tomb\" (key TEXT PRIMARY KEY, row_version INTEGER NOT NULL);"
        ))
        .unwrap();
        for (key, value) in rows.iter() {
            conn.execute(
                &format!("INSERT INTO \"{table}\" VALUES (?1, ?2, NULL, 1)"),
                rusqlite::params![key, value.to_string()],
            )
            .unwrap();
        }
    }
    conn
}

fn migration(fake: &FakePlatform, exec: &Rc<TestExecutor>, dir: &Path) -> Rc<MigrationApi> {
    Rc::new(create_migration(fake.db.clone(), exec.clone(), None, Some(dir.to_path_buf()), None))
}

fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
        .collect();
    out.sort();
    out
}

#[test]
fn decodes_type_prefixed_keys() {
    assert_eq!(decode_storage_key("s:task_1").as_deref(), Some("task_1"));
    assert_eq!(decode_storage_key("s:").as_deref(), Some(""));
    assert_eq!(decode_storage_key("n:42").as_deref(), Some("42"));
    assert_eq!(decode_storage_key("n:-0").as_deref(), Some("0"));
    assert_eq!(decode_storage_key("x:1"), None);
}

#[test]
fn imports_kv_unwrapped_and_other_collections_as_they_are() {
    let tmp = tempfile::tempdir().unwrap();
    let _conn = fixture(
        tmp.path(),
        &[
            ("kv:settings", &[("s:theme", json!({"key": "theme", "value": "dark"}))]),
            ("agent-tasks", &[("s:task_a", json!({"taskId": "task_a", "title": "Hi", "status": "restored"}))]),
            ("usage-buckets", &[("s:usg_1", json!({"total": {"tokens": {"input": 3}}}))]),
            ("probe-notes", &[("s:a", json!({"id": "a"}))]),
        ],
    );
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let outcome = exec.block_on(migration(&fake, &exec, tmp.path()).run());

    let ImportOutcome::Imported(report) = outcome else { panic!("{outcome:?}") };
    assert_eq!(report.imported["kv:settings"], 1);
    assert!(!report.imported.contains_key("probe-notes"), "the TS probe is not data");
    assert_eq!(fake.db.snapshot("kv:settings")["theme"], json!("dark"));
    assert_eq!(fake.db.snapshot("agent-tasks")["task_a"]["title"], json!("Hi"));
    assert_eq!(fake.db.snapshot("usage-buckets")["usg_1"]["total"]["tokens"]["input"], json!(3));
    assert!(fake.db.snapshot("probe-notes").is_empty());
    assert!(fake.db.snapshot(MIGRATION_COLLECTION).contains_key(TAURI_IMPORT_KEY));
}

#[test]
fn never_writes_to_the_source() {
    let tmp = tempfile::tempdir().unwrap();
    let conn = fixture(tmp.path(), &[("kv:agent", &[("s:auth:claude-code", json!({"key": "auth:claude-code", "value": true}))])]);
    let before = files(tmp.path());
    assert!(before.iter().any(|(n, _)| n.ends_with("-wal")), "the rows are still in the WAL");
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    exec.block_on(migration(&fake, &exec, tmp.path()).run());
    assert_eq!(fake.db.snapshot("kv:agent")["auth:claude-code"], json!(true), "read through the WAL copy");
    assert_eq!(files(tmp.path()), before, "source folder byte-for-byte unchanged");
    drop(conn);
}

#[test]
fn runs_once() {
    let tmp = tempfile::tempdir().unwrap();
    let _conn = fixture(tmp.path(), &[("seen", &[("s:document:/a.md", json!({"id": "document:/a.md"}))])]);
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let m = migration(&fake, &exec, tmp.path());
    assert!(matches!(exec.block_on(m.run()), ImportOutcome::Imported(_)));
    exec.block_on(fake.db.delete("seen", "document:/a.md")).unwrap();
    assert_eq!(exec.block_on(m.run()), ImportOutcome::AlreadyDone);
    assert!(fake.db.snapshot("seen").is_empty(), "a second launch imports nothing");
}

#[test]
fn never_overwrites_a_collection_the_new_app_already_has() {
    let tmp = tempfile::tempdir().unwrap();
    let _conn = fixture(
        tmp.path(),
        &[
            ("kv:settings", &[("s:theme", json!({"key": "theme", "value": "dark"}))]),
            ("harnesses", &[("s:claude-code", json!({"id": "claude-code"}))]),
        ],
    );
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    exec.block_on(fake.db.put("kv:settings", "theme", json!("light"))).unwrap();
    let ImportOutcome::Imported(report) = exec.block_on(migration(&fake, &exec, tmp.path()).run()) else { panic!() };
    assert_eq!(report.skipped, vec!["kv:settings".to_string()]);
    assert_eq!(fake.db.snapshot("kv:settings")["theme"], json!("light"));
    assert_eq!(report.imported["harnesses"], 1);
}

#[test]
fn no_source_and_foreign_dbs_import_nothing() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(exec.block_on(migration(&fake, &exec, empty.path()).run()), ImportOutcome::NoSource);
    // A db without the registry (this app's own `docs` db, say).
    let other = tempfile::tempdir().unwrap();
    Connection::open(other.path().join(DB_FILE_NAME))
        .unwrap()
        .execute_batch("CREATE TABLE docs (collection TEXT, key TEXT, value TEXT);")
        .unwrap();
    assert_eq!(exec.block_on(migration(&fake, &exec, other.path()).run()), ImportOutcome::NoSource);
    assert!(fake.db.snapshot(MIGRATION_COLLECTION).is_empty(), "nothing recorded: a later Tauri db still imports");
}

#[test]
fn skips_its_own_data_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let _conn = fixture(tmp.path(), &[("seen", &[("s:x", json!({}))])]);
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let m = Rc::new(create_migration(
        fake.db.clone(),
        exec.clone(),
        None,
        Some(tmp.path().to_path_buf()),
        Some(tmp.path().to_path_buf()),
    ));
    assert_eq!(exec.block_on(m.run()), ImportOutcome::NoSource);
}

#[test]
fn registers_as_a_module_and_announces_the_import() {
    let tmp = tempfile::tempdir().unwrap();
    let _conn = fixture(tmp.path(), &[("open-workspaces", &[("s:/w", json!({"path": "/w"}))])]);
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(vec![ModuleRef::of::<MigrationModule>()]),
    )
    .unwrap();
    let heard = Rc::new(std::cell::RefCell::new(None));
    let h = heard.clone();
    let _sub = core.hooks().on::<MigrationImported, _>(move |report| {
        *h.borrow_mut() = Some(report.clone());
    });
    // The module reads the real default folder; the test swaps in a
    // migration over the fixture through the same hooks.
    let m = Rc::new(create_migration(
        fake.db.clone(),
        exec.clone(),
        Some(core.hooks().clone()),
        Some(tmp.path().to_path_buf()),
        None,
    ));
    exec.block_on(m.run());
    exec.run_until_parked();
    assert_eq!(heard.borrow().as_ref().unwrap().imported["open-workspaces"], 1);
    let _ = core.use_::<MigrationModule>();
}

/// Against a COPY of a real Tauri db: `NOTEFIG_MIGRATION_FIXTURE=<dir with
/// a copied notefig.db> cargo test -p notefig-migration -- --ignored`.
#[test]
#[ignore]
fn imports_a_copied_real_db() {
    let Some(dir) = std::env::var_os("NOTEFIG_MIGRATION_FIXTURE") else { return };
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let outcome = exec.block_on(migration(&fake, &exec, Path::new(&dir)).run());
    eprintln!("{outcome:?}");
    assert!(matches!(outcome, ImportOutcome::Imported(_)));
}
