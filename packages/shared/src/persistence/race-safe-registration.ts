/**
 * One statement in the persistence library is not safe with more than one
 * process: registering a collection the database has never seen.
 *
 * `ensureCollectionReady` reads `collection_registry` and, finding no row,
 * inserts one with a plain INSERT. Within a process that is fine (the adapter
 * shares the in-flight registration), but two processes opening the same new
 * collection can both find no row, and the second INSERT fails on the
 * registry's unique columns. The library logs "Failed persisted ... startup"
 * and that process's collection never hydrates: it keeps writing to disk but
 * shows only some of the rows, or none. Reproduced under load with five
 * processes opening a fresh database; in practice the likely case is the app
 * and a CLI run both using a KV namespace for the first time.
 *
 * The row both processes insert is identical — the table names are a
 * deterministic hash of the collection id — so ignoring the duplicate yields
 * exactly the mapping the winner wrote. Every other statement on that path
 * already uses IF NOT EXISTS or ON CONFLICT. This rewrites that one statement
 * and nothing else; a test asserts the library still issues it verbatim, so an
 * upgrade that changes it fails loudly instead of silently reopening the race.
 */

const REGISTRY_INSERT = /^(\s*)INSERT INTO collection_registry \(/;

export function raceSafeRegistrationSql(sql: string): string {
  return sql.replace(REGISTRY_INSERT, "$1INSERT OR IGNORE INTO collection_registry (");
}

/** Whether a statement is the registration insert this module rewrites. */
export function isCollectionRegistrationInsert(sql: string): boolean {
  return REGISTRY_INSERT.test(sql);
}
