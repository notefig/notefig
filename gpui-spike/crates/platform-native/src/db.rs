//! `DbSurface` on SQLite (`tauri-db.ts` + `db_ops.rs`): one table of JSON
//! documents, `docs(collection, key, value)`, in `<app_data_dir>/notefig.db`.

use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, ExecutorExt};
use notefig_platform::Db;
use rusqlite::{Connection, params};

pub struct SqliteDb {
    conn: Arc<Mutex<Connection>>,
    executor: Rc<dyn Executor>,
}

impl SqliteDb {
    /// Open (or create) the db file. Blocks briefly: call once at startup.
    pub fn open(path: &Path, executor: Rc<dyn Executor>) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::init(conn, executor)
    }

    /// An in-memory db (tests, or a fallback when the file cannot open).
    pub fn in_memory(executor: Rc<dyn Executor>) -> anyhow::Result<Self> {
        Self::init(Connection::open_in_memory()?, executor)
    }

    fn init(conn: Connection, executor: Rc<dyn Executor>) -> anyhow::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS docs (
               collection TEXT NOT NULL,
               key TEXT NOT NULL,
               value TEXT NOT NULL,
               PRIMARY KEY (collection, key)
             ) WITHOUT ROWID;",
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), executor })
    }

    fn with<T: Send + 'static>(
        &self,
        op: impl FnOnce(&Connection) -> anyhow::Result<T> + Send + 'static,
    ) -> LocalBoxFuture<'static, anyhow::Result<T>> {
        let conn = self.conn.clone();
        self.executor.blocking(move || op(&conn.lock().unwrap()))
    }
}

impl Db for SqliteDb {
    fn load(&self, collection: &str) -> LocalBoxFuture<'static, anyhow::Result<Vec<(String, serde_json::Value)>>> {
        let collection = collection.to_string();
        self.with(move |c| {
            let mut stmt = c.prepare_cached("SELECT key, value FROM docs WHERE collection = ?1 ORDER BY key")?;
            let rows = stmt.query_map(params![collection], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut out = Vec::new();
            for row in rows {
                let (key, value) = row?;
                match serde_json::from_str(&value) {
                    Ok(v) => out.push((key, v)),
                    Err(err) => log::warn!("db: dropping unreadable {collection}/{key}: {err}"),
                }
            }
            Ok(out)
        })
    }

    fn put(&self, collection: &str, key: &str, value: serde_json::Value) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (collection, key, value) = (collection.to_string(), key.to_string(), value.to_string());
        self.with(move |c| {
            c.prepare_cached("INSERT INTO docs (collection, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value")?
                .execute(params![collection, key, value])?;
            Ok(())
        })
    }

    fn delete(&self, collection: &str, key: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (collection, key) = (collection.to_string(), key.to_string());
        self.with(move |c| {
            c.prepare_cached("DELETE FROM docs WHERE collection = ?1 AND key = ?2")?.execute(params![collection, key])?;
            Ok(())
        })
    }

    fn clear(&self, collection: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let collection = collection.to_string();
        self.with(move |c| {
            c.prepare_cached("DELETE FROM docs WHERE collection = ?1")?.execute(params![collection])?;
            Ok(())
        })
    }

    /// The range filtered in SQL (`json_extract`), so only the range's rows
    /// cross into Rust. (Owner: git — usage's hour ranges.)
    fn load_range(
        &self,
        collection: &str,
        field: &str,
        from: f64,
        to: f64,
    ) -> LocalBoxFuture<'static, anyhow::Result<Vec<(String, serde_json::Value)>>> {
        let collection = collection.to_string();
        let path = format!("$.{field}");
        self.with(move |c| {
            let mut stmt = c.prepare_cached(
                "SELECT key, value FROM docs WHERE collection = ?1
                   AND json_extract(value, ?2) >= ?3 AND json_extract(value, ?2) < ?4
                 ORDER BY key",
            )?;
            let rows = stmt.query_map(params![collection, path, from, to], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (key, value) = row?;
                match serde_json::from_str(&value) {
                    Ok(v) => out.push((key, v)),
                    Err(err) => log::warn!("db: dropping unreadable {collection}/{key}: {err}"),
                }
            }
            Ok(out)
        })
    }
}
