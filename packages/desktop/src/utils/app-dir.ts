/**
 * The app-owned directory inside a user's workspace, and the one child of
 * it that is visible.
 *
 * A deliberate leaf module: the app dir is referenced from the entity layer
 * (entities/scratchpads.ts, which owns the behavior and re-exports these),
 * from utils/history-service.ts, and from the agent — importing the entity
 * from utils would close a cycle back through entities/files.ts.
 *
 * Everything under the app dir EXCEPT the scratchpads folder is invisible:
 * hidden from the fs walkers and the watcher by position rather than by
 * name (walkdir_utils.rs, adapters/browser-fs-utils.ts), excluded from the
 * history repo's checkpoints, and excluded wholesale from the user's own
 * repo. App-internal files therefore need no dot prefix.
 */
// The values live in @notefig/shared so the CLI resolves the same app dir;
// this module stays the desktop's leaf import site for them.
export {
  APP_DIR_NAME,
  SCRATCHPADS_DIR_NAME,
  SCRATCHPADS_REL_PATH,
} from "@notefig/shared/utils";
