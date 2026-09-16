/**
 * The CLI finds the app's database with constants from @notefig/shared, while
 * the app finds it in Rust (`resolve_db_path` in db_ops.rs) under Tauri's
 * bundle identifier. If they disagree, the CLI writes to a different file and
 * nothing it does ever shows up in the app, with no error anywhere. The
 * desktop owns both the Rust source and tauri.conf.json, so the check lives
 * here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  NOTEFIG_APP_IDENTIFIER,
  NOTEFIG_DB_DIR_ENV,
  NOTEFIG_DB_FILE_NAME,
} from "@notefig/shared/persistence";

const tauriDir = resolve(__dirname, "../../../src-tauri");

describe("shared database location", () => {
  it("uses tauri.conf.json's bundle identifier", () => {
    const config = JSON.parse(
      readFileSync(resolve(tauriDir, "tauri.conf.json"), "utf8"),
    );
    expect(NOTEFIG_APP_IDENTIFIER).toBe(config.identifier);
  });

  it("uses db_ops.rs's file name and directory override", () => {
    const rust = readFileSync(resolve(tauriDir, "src/db_ops.rs"), "utf8");
    expect(rust).toContain(`const DB_FILE_NAME: &str = "${NOTEFIG_DB_FILE_NAME}";`);
    expect(rust).toContain(`const DB_DIR_ENV: &str = "${NOTEFIG_DB_DIR_ENV}";`);
    // The default directory must still be Tauri's app data dir, which is what
    // notefigDbDirectory mirrors.
    expect(rust).toContain(".app_data_dir()");
  });
});
