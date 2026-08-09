//! SQLite storage behind the adapter's `db` surface (MET-123).
//!
//! Two contracts with the JS driver (`src/adapters/tauri-db.ts`):
//!
//!   1. Placeholders arrive as `$1, $2, …`, not `?` — the driver rewrites them.
//!      SQLite assigns those the next unused index in order of appearance, so
//!      positional binding is correct. See `numbered_placeholders_bind_in_order`.
//!   2. The driver serializes every statement through one queue, so a
//!      `BEGIN IMMEDIATE … COMMIT` spanning invokes cannot interleave. The mutex
//!      here only makes individual statements atomic.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, ErrorCode};
use serde::Serialize;
use serde_json::{Map as JsonMap, Number, Value as JsonValue};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Directory override, set by the e2e shim so its runs land in a temp dir.
const DB_DIR_ENV: &str = "NOTEFIG_DB_DIR";

const DB_FILE_NAME: &str = "notefig.db";

/// Only `Corrupt` and `NotADatabase` are destructive-recoverable; everything
/// else must propagate so a transient failure never costs the user their data.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DbErrorType {
    Corrupt,
    NotADatabase,
    Busy,
    Io,
    /// Malformed SQL, constraint violations — a bug, not a storage failure.
    Sql,
    /// A parameter or column type we deliberately refuse to guess at.
    Unsupported,
    Unknown,
}

#[derive(Serialize, Clone, Debug)]
pub struct DbError {
    #[serde(rename = "type")]
    pub error_type: DbErrorType,
    pub message: String,
}

impl DbError {
    fn new(error_type: DbErrorType, message: impl Into<String>) -> Self {
        DbError {
            error_type,
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        let error_type = match &error {
            rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
                ErrorCode::DatabaseCorrupt => DbErrorType::Corrupt,
                ErrorCode::NotADatabase => DbErrorType::NotADatabase,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => DbErrorType::Busy,
                ErrorCode::CannotOpen
                | ErrorCode::SystemIoFailure
                | ErrorCode::DiskFull
                | ErrorCode::ReadOnly
                | ErrorCode::PermissionDenied => DbErrorType::Io,
                _ => DbErrorType::Sql,
            },
            _ => DbErrorType::Sql,
        };
        DbError::new(error_type, error.to_string())
    }
}

// Connection-free core, so the tests can drive it without a Tauri app.

/// Opens (creating if absent) and configures a connection.
///
/// The pragmas run here because `Connection::open` alone succeeds on a file of
/// garbage — SQLite only reads a page when asked, so `journal_mode` doubles as
/// the integrity probe that classifies the file.
pub fn open_at(path: &Path) -> Result<Connection, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| DbError::new(DbErrorType::Io, error.to_string()))?;
    }

    let connection = Connection::open(path)?;
    // journal_mode answers with the resulting mode, so it must be queried.
    connection.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "busy_timeout", 5000)?;
    Ok(connection)
}

/// Arrays and objects are refused rather than stringified — the persistence core
/// serializes its own JSON to text, so a structured value here is a caller bug.
fn json_to_sql(value: &JsonValue) -> Result<SqlValue, DbError> {
    Ok(match value {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        JsonValue::Number(number) => match number.as_i64() {
            Some(integer) => SqlValue::Integer(integer),
            None => match number.as_f64() {
                Some(float) => SqlValue::Real(float),
                None => {
                    return Err(DbError::new(
                        DbErrorType::Unsupported,
                        format!("numeric parameter out of range: {number}"),
                    ))
                }
            },
        },
        JsonValue::String(text) => SqlValue::Text(text.clone()),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            return Err(DbError::new(
                DbErrorType::Unsupported,
                "array and object parameters are not supported — bind JSON as text",
            ))
        }
    })
}

fn sql_to_json(value: ValueRef<'_>, column: &str) -> Result<JsonValue, DbError> {
    Ok(match value {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(integer) => JsonValue::Number(Number::from(integer)),
        ValueRef::Real(float) => Number::from_f64(float).map_or(JsonValue::Null, JsonValue::Number),
        ValueRef::Text(bytes) => JsonValue::String(String::from_utf8_lossy(bytes).into_owned()),
        // Nothing in the persistence schema stores blobs; erroring keeps that
        // assumption checkable.
        ValueRef::Blob(_) => {
            return Err(DbError::new(
                DbErrorType::Unsupported,
                format!("column \"{column}\" holds a blob, which the db surface does not carry"),
            ))
        }
    })
}

fn bind_values(params: &[JsonValue]) -> Result<Vec<SqlValue>, DbError> {
    params.iter().map(json_to_sql).collect()
}

/// The shape plugin-sql's `Database.execute` resolves with — the persistence
/// package types its contract as `Pick<Database, …>`, so matching it exactly is
/// what lets our shim satisfy that without a cast.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub rows_affected: usize,
    pub last_insert_id: i64,
}

pub fn execute_on(
    connection: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<QueryResult, DbError> {
    let values = bind_values(params)?;
    let rows_affected = connection.execute(sql, params_from_iter(values))?;
    Ok(QueryResult {
        rows_affected,
        last_insert_id: connection.last_insert_rowid(),
    })
}

pub fn query_on(
    connection: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<Vec<JsonMap<String, JsonValue>>, DbError> {
    let values = bind_values(params)?;
    let mut statement = connection.prepare(sql)?;
    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();

    let mut rows = statement.query(params_from_iter(values))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut record = JsonMap::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            record.insert(column.clone(), sql_to_json(row.get_ref(index)?, column)?);
        }
        out.push(record);
    }
    Ok(out)
}

/// DESTRUCTIVE: deletes the database and both WAL sidecars. Only the corruption
/// guard calls this, and only for `Corrupt` / `NotADatabase`.
pub fn delete_files_at(path: &Path) -> Result<(), DbError> {
    for candidate in sidecar_paths(path) {
        match std::fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(DbError::new(
                    DbErrorType::Io,
                    format!("could not delete {}: {error}", candidate.display()),
                ))
            }
        }
    }
    Ok(())
}

fn sidecar_paths(path: &Path) -> Vec<PathBuf> {
    let name = path.file_name().map_or_else(
        || DB_FILE_NAME.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    vec![
        path.to_path_buf(),
        parent.join(format!("{name}-wal")),
        parent.join(format!("{name}-shm")),
    ]
}

static CONNECTION: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();

fn connection_slot() -> &'static Mutex<Option<Connection>> {
    CONNECTION.get_or_init(|| Mutex::new(None))
}

fn resolve_db_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, DbError> {
    use tauri::Manager;

    let directory = match std::env::var(DB_DIR_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|error| DbError::new(DbErrorType::Io, error.to_string()))?,
    };
    Ok(directory.join(DB_FILE_NAME))
}

/// Reads one numeric value out of a persisted KV collection, for the startup
/// paths that need a setting before the webview exists (native zoom).
///
/// Deliberately NOT routed through `with_connection`: that would open the
/// shared connection at boot and create `notefig.db`, breaking the lazy-open
/// invariant for everyone who never writes a setting. This opens its own
/// read-only handle, which fails harmlessly when the file is absent, and drops
/// it immediately.
///
/// It reaches into the persistence layer's own table layout, which is the same
/// coupling the old `kv.json` read had — the table name comes from
/// `collection_registry` rather than being recomputed, since the JS side hashes
/// long collection ids.
pub fn read_persisted_number<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    collection_id: &str,
    key: &str,
) -> Option<f64> {
    read_persisted_number_at(&resolve_db_path(app).ok()?, collection_id, key)
}

fn read_persisted_number_at(path: &Path, collection_id: &str, key: &str) -> Option<f64> {
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;

    let table: String = connection
        .query_row(
            "SELECT table_name FROM collection_registry WHERE collection_id = ?1",
            [collection_id],
            |row| row.get(0),
        )
        .ok()?;

    // Keys are stored encoded so string and number keys can share one column;
    // `s:` is the string prefix.
    connection
        .query_row(
            &format!("SELECT json_extract(value, '$.value') FROM \"{table}\" WHERE key = ?1"),
            [format!("s:{key}")],
            |row| row.get::<_, f64>(0),
        )
        .ok()
}

/// Runs `operation` against the connection, opening it first if needed — the
/// lazy-open invariant: no filesystem work until a command actually arrives.
fn with_connection<R, T>(
    app: &tauri::AppHandle<R>,
    operation: impl FnOnce(&Connection) -> Result<T, DbError>,
) -> Result<T, DbError>
where
    R: tauri::Runtime,
{
    let path = resolve_db_path(app)?;
    let mut slot = connection_slot()
        .lock()
        .map_err(|_| DbError::new(DbErrorType::Unknown, "database mutex poisoned"))?;

    if slot.is_none() {
        *slot = Some(open_at(&path)?);
    }
    let connection = slot
        .as_ref()
        .ok_or_else(|| DbError::new(DbErrorType::Unknown, "database connection unavailable"))?;
    operation(connection)
}

#[tauri::command]
pub async fn db_execute<R: tauri::Runtime>(
    sql: String,
    params: Option<Vec<JsonValue>>,
    app_handle: tauri::AppHandle<R>,
) -> Result<QueryResult, DbError> {
    tauri::async_runtime::spawn_blocking(move || {
        let params = params.unwrap_or_default();
        with_connection(&app_handle, |connection| {
            execute_on(connection, &sql, &params)
        })
    })
    .await
    .map_err(|error| DbError::new(DbErrorType::Unknown, error.to_string()))?
}

#[tauri::command]
pub async fn db_query<R: tauri::Runtime>(
    sql: String,
    params: Option<Vec<JsonValue>>,
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<JsonMap<String, JsonValue>>, DbError> {
    tauri::async_runtime::spawn_blocking(move || {
        let params = params.unwrap_or_default();
        with_connection(&app_handle, |connection| {
            query_on(connection, &sql, &params)
        })
    })
    .await
    .map_err(|error| DbError::new(DbErrorType::Unknown, error.to_string()))?
}

#[tauri::command]
pub async fn db_close() -> Result<bool, DbError> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut slot = connection_slot()
            .lock()
            .map_err(|_| DbError::new(DbErrorType::Unknown, "database mutex poisoned"))?;
        slot.take();
        // `true` rather than `()` to satisfy plugin-sql's `close(): Promise<boolean>`.
        Ok(true)
    })
    .await
    .map_err(|error| DbError::new(DbErrorType::Unknown, error.to_string()))?
}

/// DESTRUCTIVE: closes the connection and deletes the database file. Called only
/// by the corruption guard; the next command reopens onto an empty database.
#[tauri::command]
pub async fn db_reset<R: tauri::Runtime>(app_handle: tauri::AppHandle<R>) -> Result<(), DbError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_db_path(&app_handle)?;
        let mut slot = connection_slot()
            .lock()
            .map_err(|_| DbError::new(DbErrorType::Unknown, "database mutex poisoned"))?;
        // Drop before deleting — an open handle would write into an unlinked
        // inode on unix and fail outright on Windows.
        slot.take();
        delete_files_at(&path)
    })
    .await
    .map_err(|error| DbError::new(DbErrorType::Unknown, error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn temp_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(DB_FILE_NAME);
        (dir, path)
    }

    /// If SQLite assigned `$N` indexes differently than the driver assumes,
    /// every parameterized write would silently transpose its columns.
    #[test]
    fn numbered_placeholders_bind_in_order() {
        let (_dir, path) = temp_db();
        let connection = open_at(&path).expect("open");

        execute_on(&connection, "CREATE TABLE t (a TEXT, b TEXT, c TEXT)", &[]).expect("create");
        execute_on(
            &connection,
            "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)",
            &[json!("first"), json!("second"), json!("third")],
        )
        .expect("insert");

        let rows = query_on(&connection, "SELECT a, b, c FROM t", &[]).expect("select");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["a"], json!("first"));
        assert_eq!(rows[0]["b"], json!("second"));
        assert_eq!(rows[0]["c"], json!("third"));
    }

    #[test]
    fn maps_json_parameter_types_without_collapsing_ints_to_floats() {
        let (_dir, path) = temp_db();
        let connection = open_at(&path).expect("open");

        execute_on(&connection, "CREATE TABLE t (v)", &[]).expect("create");
        for value in [json!(null), json!(true), json!(7), json!(7.5), json!("s")] {
            execute_on(&connection, "INSERT INTO t (v) VALUES ($1)", &[value]).expect("insert");
        }

        let rows = query_on(&connection, "SELECT v FROM t ORDER BY rowid", &[]).expect("select");
        let values: Vec<&JsonValue> = rows.iter().map(|row| &row["v"]).collect();
        assert_eq!(values[0], &json!(null));
        // SQLite has no boolean type; true round-trips as 1, not as 1.0.
        assert_eq!(values[1], &json!(1));
        assert_eq!(values[2], &json!(7));
        assert!(values[2].is_i64(), "integers must not become floats");
        assert_eq!(values[3], &json!(7.5));
        assert_eq!(values[4], &json!("s"));
    }

    #[test]
    fn refuses_structured_parameters_rather_than_stringifying_them() {
        let (_dir, path) = temp_db();
        let connection = open_at(&path).expect("open");
        execute_on(&connection, "CREATE TABLE t (v)", &[]).expect("create");

        let error = execute_on(
            &connection,
            "INSERT INTO t (v) VALUES ($1)",
            &[json!({ "a": 1 })],
        )
        .expect_err("structured parameter must be refused");

        assert_eq!(error.error_type, DbErrorType::Unsupported);
    }

    /// The guard is destructive, so its trigger has to be exact: garbage must
    /// classify as `not_a_database`, never as `io`.
    #[test]
    fn classifies_a_garbage_file_as_not_a_database() {
        let (_dir, path) = temp_db();
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(b"this is definitely not a sqlite database")
            .expect("write");
        file.sync_all().expect("sync");

        let error = open_at(&path).expect_err("garbage must not open cleanly");

        assert_eq!(error.error_type, DbErrorType::NotADatabase);
    }

    #[test]
    fn a_syntax_error_is_sql_not_corruption() {
        let (_dir, path) = temp_db();
        let connection = open_at(&path).expect("open");

        let error =
            execute_on(&connection, "SELECT FROM WHERE", &[]).expect_err("invalid SQL must fail");

        assert_eq!(error.error_type, DbErrorType::Sql);
    }

    #[test]
    fn deleting_the_files_clears_the_wal_sidecars_and_allows_a_clean_reopen() {
        let (_dir, path) = temp_db();
        let connection = open_at(&path).expect("open");
        execute_on(&connection, "CREATE TABLE t (v)", &[]).expect("create");
        execute_on(&connection, "INSERT INTO t (v) VALUES ($1)", &[json!("x")]).expect("insert");
        drop(connection);

        delete_files_at(&path).expect("delete");

        assert!(!path.exists());
        for suffix in ["-wal", "-shm"] {
            let sidecar = path.with_file_name(format!("{DB_FILE_NAME}{suffix}"));
            assert!(!sidecar.exists(), "{} should be gone", sidecar.display());
        }

        let reopened = open_at(&path).expect("reopen after reset");
        execute_on(&reopened, "CREATE TABLE t (v)", &[]).expect("recreate on empty database");
    }

    #[test]
    fn deleting_a_database_that_was_never_created_succeeds() {
        let (_dir, path) = temp_db();
        delete_files_at(&path).expect("absent database is already in the desired state");
    }

    /// Mirrors the layout `@tanstack/db-sqlite-persistence-core` writes: a
    /// `collection_registry` row naming the table, keys encoded with the `s:`
    /// string prefix, and the row itself stored as `{key, value}` JSON. The
    /// frontend half of this contract is pinned by `node-db.ts`'s `storedRows`.
    fn seed_persisted_kv(path: &Path, collection_id: &str, table: &str, key: &str, value: &str) {
        let connection = open_at(path).expect("open");
        connection
            .execute_batch(&format!(
                "CREATE TABLE collection_registry (
                   collection_id TEXT PRIMARY KEY,
                   table_name TEXT NOT NULL UNIQUE,
                   tombstone_table_name TEXT NOT NULL UNIQUE,
                   schema_version INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE \"{table}\" (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   metadata TEXT,
                   row_version INTEGER NOT NULL
                 );"
            ))
            .expect("schema");
        connection
            .execute(
                "INSERT INTO collection_registry VALUES (?1, ?2, ?3, 1, 0)",
                rusqlite::params![collection_id, table, format!("t_{table}")],
            )
            .expect("registry row");
        connection
            .execute(
                &format!("INSERT INTO \"{table}\" VALUES (?1, ?2, NULL, 1)"),
                rusqlite::params![format!("s:{key}"), value],
            )
            .expect("kv row");
    }

    #[test]
    fn reads_a_setting_written_by_the_persistence_layer() {
        let (_dir, path) = temp_db();
        seed_persisted_kv(
            &path,
            "kv:settings",
            "c_settings",
            "zoomLevel",
            r#"{"key":"zoomLevel","value":1.25}"#,
        );

        assert_eq!(
            read_persisted_number_at(&path, "kv:settings", "zoomLevel"),
            Some(1.25)
        );
    }

    /// A whole-number zoom is stored as a JSON integer, and reading it as a
    /// float must still succeed — otherwise 100% zoom would silently not restore.
    #[test]
    fn reads_an_integer_valued_setting_as_a_float() {
        let (_dir, path) = temp_db();
        seed_persisted_kv(
            &path,
            "kv:settings",
            "c_settings",
            "zoomLevel",
            r#"{"key":"zoomLevel","value":1}"#,
        );

        assert_eq!(
            read_persisted_number_at(&path, "kv:settings", "zoomLevel"),
            Some(1.0)
        );
    }

    #[test]
    fn a_missing_key_or_collection_reads_as_absent() {
        let (_dir, path) = temp_db();
        seed_persisted_kv(
            &path,
            "kv:settings",
            "c_settings",
            "zoomLevel",
            r#"{"key":"zoomLevel","value":1.5}"#,
        );

        assert_eq!(
            read_persisted_number_at(&path, "kv:settings", "theme"),
            None
        );
        assert_eq!(
            read_persisted_number_at(&path, "kv:other", "zoomLevel"),
            None
        );
    }

    /// The startup read must not be what creates the database — MET-123's
    /// lazy-open invariant is that a user who never writes a setting never gets
    /// a file. Opening read-only is what enforces it.
    #[test]
    fn reading_before_any_database_exists_creates_nothing() {
        let (_dir, path) = temp_db();

        assert_eq!(
            read_persisted_number_at(&path, "kv:settings", "zoomLevel"),
            None
        );
        assert!(!path.exists(), "the read created a database file");
    }
}
