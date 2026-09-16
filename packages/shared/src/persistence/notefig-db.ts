/**
 * Where the app's database lives, for every process that opens it.
 *
 * The desktop resolves the path in Rust (`resolve_db_path` in
 * `src-tauri/src/db_ops.rs`): `NOTEFIG_DB_DIR` if set, otherwise Tauri's
 * `app_data_dir()`, which is the platform data directory joined with the
 * bundle identifier. The CLI opens the same file, so it needs the same
 * answer. A desktop test checks these constants against the Rust source and
 * `tauri.conf.json`, so the two cannot drift silently.
 */

/** Tauri's bundle identifier (`tauri.conf.json`), the data directory's name. */
export const NOTEFIG_APP_IDENTIFIER = "com.notefig.app";

export const NOTEFIG_DB_FILE_NAME = "notefig.db";

/** Directory override, set by the e2e shim and by tests. */
export const NOTEFIG_DB_DIR_ENV = "NOTEFIG_DB_DIR";

export type NotefigDbLocationInput = {
  /** `process.platform`. */
  platform: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** Path join in the host's flavor. */
  join: (...parts: string[]) => string;
};

/**
 * The directory `notefig.db` lives in. Mirrors Tauri's `app_data_dir()`, which
 * is `dirs::data_dir()` joined with the identifier:
 *
 *   macOS    ~/Library/Application Support/com.notefig.app
 *   Windows  %APPDATA%\com.notefig.app            (the roaming AppData folder)
 *   Linux    $XDG_DATA_HOME/com.notefig.app, else ~/.local/share/com.notefig.app
 */
export function notefigDbDirectory(input: NotefigDbLocationInput): string {
  const override = input.env[NOTEFIG_DB_DIR_ENV];
  if (override && override.trim() !== "") return override;

  const { platform, env, homeDir, join } = input;
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", NOTEFIG_APP_IDENTIFIER);
  }
  if (platform === "win32") {
    const roaming = env.APPDATA ?? join(homeDir, "AppData", "Roaming");
    return join(roaming, NOTEFIG_APP_IDENTIFIER);
  }
  const dataHome =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== ""
      ? env.XDG_DATA_HOME
      : join(homeDir, ".local", "share");
  return join(dataHome, NOTEFIG_APP_IDENTIFIER);
}
