/**
 * The app's database, opened from the CLI.
 *
 * Same file the desktop app writes (see notefigDbDirectory), so a headless
 * run's task shows up in the app and the app can resume it afterwards. Writes
 * are coordinated with the app and with other CLI runs through the shared
 * coordinator; nothing here assumes this process is the only writer.
 *
 * A database that cannot be opened is not a failed turn: the agent still
 * runs, it just leaves no row behind, and the caller says so.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NOTEFIG_DB_FILE_NAME,
  notefigDbDirectory,
  openSharedDb,
  type SharedDb,
} from '../shared';

export type OpenAppDbResult =
  | { ok: true; db: SharedDb; path: string }
  | { ok: false; path: string; error: string };

export function appDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const directory = notefigDbDirectory({
    platform: process.platform,
    env,
    homeDir: os.homedir(),
    join: path.join,
  });
  return path.join(directory, NOTEFIG_DB_FILE_NAME);
}

export function openAppDb(env: NodeJS.ProcessEnv = process.env): OpenAppDbResult {
  const dbPath = appDbPath(env);
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Required lazily, and an optional dependency: better-sqlite3 is a native
    // addon with prebuilt binaries for Node 20+ only, and a failed build must
    // not fail installing the CLI. Without it every command still runs; a run
    // just is not recorded in the app, and says so.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    // The same connection settings as the app (db_ops.rs): a 5s wait on the
    // write lock instead of an immediate SQLITE_BUSY when the app is
    // mid-transaction. openSharedDb puts the file in WAL mode.
    const handle = new Database(dbPath, { timeout: 5000 });
    return { ok: true, db: openSharedDb(handle), path: dbPath };
  } catch (error: any) {
    return { ok: false, path: dbPath, error: error?.message ?? String(error) };
  }
}
