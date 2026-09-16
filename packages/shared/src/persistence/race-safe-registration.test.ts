import {
  isCollectionRegistrationInsert,
  raceSafeRegistrationSql,
} from "./race-safe-registration";

const LIBRARY_STATEMENT = `INSERT INTO collection_registry (
           collection_id,
           table_name,
           tombstone_table_name,
           schema_version,
           updated_at
         )
         VALUES ($1, $2, $3, $4, CAST(strftime('%s', 'now') AS INTEGER))`;

describe("raceSafeRegistrationSql", () => {
  it("turns the library's registration insert into INSERT OR IGNORE", () => {
    expect(isCollectionRegistrationInsert(LIBRARY_STATEMENT)).toBe(true);
    expect(raceSafeRegistrationSql(LIBRARY_STATEMENT)).toMatch(
      /^INSERT OR IGNORE INTO collection_registry \(/,
    );
  });

  it("keeps leading whitespace", () => {
    expect(raceSafeRegistrationSql(`\n  ${LIBRARY_STATEMENT}`)).toMatch(
      /^\n {2}INSERT OR IGNORE INTO collection_registry \(/,
    );
  });

  it("leaves every other statement alone", () => {
    for (const sql of [
      "SELECT table_name FROM collection_registry WHERE collection_id = $1",
      "UPDATE collection_registry SET schema_version = $1",
      "INSERT INTO collection_version (collection_id, latest_row_version) VALUES ($1, 0) ON CONFLICT(collection_id) DO NOTHING",
      "INSERT INTO applied_tx (collection_id) VALUES ($1)",
    ]) {
      expect(raceSafeRegistrationSql(sql)).toBe(sql);
    }
  });
});
