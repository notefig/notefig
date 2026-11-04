//! One-time import of the Tauri app's data into this app's db.
//!
//! Not a TS module: the TS app never had a predecessor with another db. The
//! source is the Tauri build's `notefig.db` (`~/Library/Application
//! Support/com.notefig.app/` on macOS), which is only ever read from a temp
//! copy (see `source.rs`). What it held is written through the platform
//! [`Db`] under the same collection names the Rust modules use, which are
//! the TS ones:
//!
//! - `kv:<namespace>` rows were `{ key, value }`; the kv module keeps the
//!   bare value, so the value is unwrapped.
//! - every other imported collection keeps its id and row shape
//!   (`agent-tasks`, `harnesses`, `usage-buckets`, …).
//!
//! It runs once: a `migration/tauri-import` row records that it did. A
//! target collection that already has rows is left alone, so nothing the
//! new app wrote is ever overwritten.
//!
//! **When it runs.** Modules hydrate at register/boot, so the import has to
//! finish before them. `Core::boot` is synchronous and cannot wait on a
//! module's future, so the root calls [`MigrationApi::run`] after
//! `Core::new` and awaits it before `core.boot()`. The
//! [`MigrationImported`] hook still announces the result, for anything that
//! loads earlier.

mod source;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, ExecutorExt, Hook, Hooks, Module, ModuleContext, ModuleRef};
use notefig_platform::{Db, PlatformService};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use source::{DB_FILE_NAME, SourceCollection, decode_storage_key, read_collections};

/// Where the import records that it ran.
pub const MIGRATION_COLLECTION: &str = "migration";
pub const TAURI_IMPORT_KEY: &str = "tauri-import";
/// Overrides the source folder; empty or `none` turns the import off.
pub const SOURCE_DIR_ENV: &str = "NOTEFIG_TAURI_DATA_DIR";

/// The collections imported besides every `kv:*` namespace. Left out:
/// `probe-notes` (the TS db's own persistence probe, test data), and any
/// collection not listed here (unknown shape; importing it could feed a
/// module rows it cannot read).
pub const IMPORTED_COLLECTIONS: &[&str] = &[
    "agent-tasks",
    "agent-turns",
    "agent-tool-calls",
    "harnesses",
    "harness-catalog",
    "usage-buckets",
    "usage-limits",
    "seen",
    "unseen",
    "agent-seen",
    "recent-documents",
    "prompt-rounds",
    "open-workspaces",
];

/// Whether a source collection is imported.
pub fn is_imported(collection: &str) -> bool {
    collection.starts_with("kv:") || IMPORTED_COLLECTIONS.contains(&collection)
}

/// A source row as the target collection stores it.
pub fn target_value(collection: &str, value: Value) -> Value {
    if collection.starts_with("kv:") {
        if let Value::Object(mut row) = value {
            return row.remove("value").unwrap_or(Value::Null);
        }
        return value;
    }
    value
}

/// What one import did.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImportReport {
    /// Rows written, by collection.
    pub imported: BTreeMap<String, usize>,
    /// Collections left alone because the new db already had rows there.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImportOutcome {
    /// A previous launch imported already.
    AlreadyDone,
    /// No Tauri db to import (or turned off).
    NoSource,
    Imported(ImportReport),
    /// Reading the source failed; the next launch tries again.
    Failed(String),
}

/// `"migration:imported"`: the Tauri data landed in the db.
pub struct MigrationImported;

impl Hook for MigrationImported {
    const NAME: &'static str = "migration:imported";
    type Payload = ImportReport;
}

/// The Tauri app's data folder on this OS, unless [`SOURCE_DIR_ENV`] says
/// otherwise. `None` when there is nowhere to look.
pub fn default_source_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(SOURCE_DIR_ENV) {
        return (!dir.is_empty() && dir != "none").then(|| PathBuf::from(dir));
    }
    // A run with its own state dir (scratch, tests, the script driver) never
    // imports the user's real Tauri data unless the source is named above:
    // the import would restore their workspaces into that run.
    if std::env::var_os("NOTEFIG_STATE_DIR").is_some() {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library/Application Support/com.notefig.app"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("com.notefig.app"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".local/share")))
            .map(|d| d.join("com.notefig.app"))
    }
}

/// `core.use_::<MigrationModule>()`.
pub struct MigrationApi {
    db: Rc<dyn Db>,
    executor: Rc<dyn Executor>,
    hooks: Option<Hooks>,
    source_dir: Option<PathBuf>,
    /// This app's own data folder: never read as a source.
    own_dir: Option<PathBuf>,
    outcome: RefCell<Option<ImportOutcome>>,
}

/// The import over the db it writes to and the folder it reads from.
pub fn create_migration(
    db: Rc<dyn Db>,
    executor: Rc<dyn Executor>,
    hooks: Option<Hooks>,
    source_dir: Option<PathBuf>,
    own_dir: Option<PathBuf>,
) -> MigrationApi {
    MigrationApi {
        db,
        executor,
        hooks,
        source_dir,
        own_dir,
        outcome: RefCell::new(None),
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

impl MigrationApi {
    /// What the last [`run`](Self::run) did, once it has.
    pub fn outcome(&self) -> Option<ImportOutcome> {
        self.outcome.borrow().clone()
    }

    /// Import once. Await it before `core.boot()`.
    pub fn run(self: &Rc<Self>) -> LocalBoxFuture<'static, ImportOutcome> {
        let this = self.clone();
        async move {
            let outcome = this.import().await;
            match &outcome {
                ImportOutcome::Imported(report) => {
                    log::info!("migration: imported the Tauri app's data: {:?}", report.imported);
                    if let Some(hooks) = &this.hooks {
                        hooks.emit::<MigrationImported>(report.clone());
                    }
                }
                ImportOutcome::Failed(err) => log::error!("migration: import failed: {err}"),
                _ => {}
            }
            *this.outcome.borrow_mut() = Some(outcome.clone());
            outcome
        }
        .boxed_local()
    }

    async fn import(&self) -> ImportOutcome {
        match self.db.load(MIGRATION_COLLECTION).await {
            Ok(rows) if rows.iter().any(|(k, _)| k == TAURI_IMPORT_KEY) => return ImportOutcome::AlreadyDone,
            Ok(_) => {}
            Err(err) => return ImportOutcome::Failed(format!("{err:#}")),
        }
        let Some(dir) = &self.source_dir else { return ImportOutcome::NoSource };
        let source_db = dir.join(DB_FILE_NAME);
        if !source_db.is_file() {
            return ImportOutcome::NoSource;
        }
        if let Some(own) = &self.own_dir
            && same_file(&own.join(DB_FILE_NAME), &source_db)
        {
            return ImportOutcome::NoSource;
        }

        let read = self
            .executor
            .blocking(move || read_collections(&source_db, is_imported).map_err(|e| format!("{e:#}")))
            .await;
        let collections = match read {
            Ok(c) => c,
            // A db without a registry is not the Tauri app's: nothing to import.
            Err(err) if err.contains("no such table: collection_registry") => return ImportOutcome::NoSource,
            Err(err) => return ImportOutcome::Failed(err),
        };

        let mut report = ImportReport::default();
        for collection in collections {
            if collection.rows.is_empty() {
                continue;
            }
            match self.db.load(&collection.id).await {
                Ok(existing) if !existing.is_empty() => {
                    report.skipped.push(collection.id);
                    continue;
                }
                Ok(_) => {}
                Err(err) => return ImportOutcome::Failed(format!("{err:#}")),
            }
            let count = collection.rows.len();
            for (key, value) in collection.rows {
                let value = target_value(&collection.id, value);
                if let Err(err) = self.db.put(&collection.id, &key, value).await {
                    return ImportOutcome::Failed(format!("{err:#}"));
                }
            }
            report.imported.insert(collection.id, count);
        }

        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let marker = json!({ "at": at, "imported": report.imported, "skipped": report.skipped });
        if let Err(err) = self.db.put(MIGRATION_COLLECTION, TAURI_IMPORT_KEY, marker).await {
            return ImportOutcome::Failed(format!("{err:#}"));
        }
        ImportOutcome::Imported(report)
    }
}

/// `migrationModule`.
pub struct MigrationModule;

impl Module for MigrationModule {
    const NAME: &'static str = "migration";
    type Api = MigrationApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> MigrationApi {
        let platform = ctx.service::<PlatformService>();
        create_migration(
            platform.db.clone(),
            ctx.executor(),
            Some(ctx.hooks().clone()),
            default_source_dir(),
            Some(platform.app_data_dir.clone()),
        )
    }
}

#[cfg(test)]
mod tests;
