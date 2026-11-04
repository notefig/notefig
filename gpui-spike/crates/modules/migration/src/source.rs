//! Reading the Tauri app's `notefig.db` without ever writing to it.
//!
//! The TS app persisted TanStack DB collections through
//! `@tanstack/db-sqlite-persistence-core`: `collection_registry` maps each
//! collection id to a table `c_xxx(key, value, metadata, row_version)`
//! whose keys are type-prefixed (`s:<string>`, `n:<number>`) and whose
//! values are the rows as JSON text. Deleted rows live in a tombstone
//! table and are simply not read.
//!
//! The source is never opened in place: even a read-only SQLite connection
//! may write a WAL database's `-shm`. The db and its `-wal`/`-shm` are
//! copied into a fresh temp dir, the copy is opened with
//! `SQLITE_OPEN_READ_ONLY`, and the copy is deleted afterwards.

use std::path::{Path, PathBuf};

use anyhow::Context as _;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

pub const DB_FILE_NAME: &str = "notefig.db";

/// One collection as the source holds it, keys decoded.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceCollection {
    pub id: String,
    pub rows: Vec<(String, Value)>,
}

/// `decodePersistedStorageKey`: `s:<string>` → the string; `n:<number>` →
/// the number's text (the Rust db keys by string). Anything else is not a
/// key this format writes.
pub fn decode_storage_key(encoded: &str) -> Option<String> {
    if let Some(s) = encoded.strip_prefix("s:") {
        return Some(s.to_string());
    }
    if encoded == "n:-0" {
        return Some("0".into());
    }
    encoded.strip_prefix("n:").map(str::to_string)
}

/// Removes the temp copy however reading ends.
struct TempCopy(PathBuf);

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn copy_to_temp(source_db: &Path) -> anyhow::Result<(TempCopy, PathBuf)> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("notefig-tauri-import-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let guard = TempCopy(dir.clone());
    let copy = dir.join(DB_FILE_NAME);
    std::fs::copy(source_db, &copy).with_context(|| format!("copying {}", source_db.display()))?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", source_db.display()));
        if side.exists() {
            std::fs::copy(&side, dir.join(format!("{DB_FILE_NAME}{suffix}")))?;
        }
    }
    Ok((guard, copy))
}

/// Every collection `wanted` accepts, read from a copy of `source_db`.
/// Blocking: run it off the main thread.
pub fn read_collections(
    source_db: &Path,
    wanted: impl Fn(&str) -> bool,
) -> anyhow::Result<Vec<SourceCollection>> {
    let (_guard, copy) = copy_to_temp(source_db)?;
    let conn = Connection::open_with_flags(
        &copy,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("opening the copy of {}", source_db.display()))?;

    let registry: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT collection_id, table_name FROM collection_registry ORDER BY collection_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };

    let mut out = Vec::new();
    for (id, table) in registry {
        if !wanted(&id) {
            continue;
        }
        // The table name comes from the registry, not from us; quote it.
        let sql = format!("SELECT key, value FROM \"{}\" ORDER BY key", table.replace('"', "\"\""));
        let mut stmt = match conn.prepare(&sql) {
            Ok(stmt) => stmt,
            Err(err) => {
                log::warn!("migration: skipping {id} ({table}): {err}");
                continue;
            }
        };
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut decoded = Vec::new();
        for row in rows {
            let (key, value) = row?;
            let Some(key) = decode_storage_key(&key) else {
                log::warn!("migration: {id}: unreadable key {key}");
                continue;
            };
            match serde_json::from_str::<Value>(&value) {
                Ok(value) => decoded.push((key, value)),
                Err(err) => log::warn!("migration: {id}/{key}: unreadable value: {err}"),
            }
        }
        out.push(SourceCollection { id, rows: decoded });
    }
    Ok(out)
}
