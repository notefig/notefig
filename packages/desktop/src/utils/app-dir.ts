/**
 * The app-owned directory inside a user's workspace, and the two children
 * of it that are visible: the scratchpads folder and the project's config.
 *
 * A deliberate leaf module: the app dir is referenced from the entity layer
 * (modules/scratchpads/scratchpads.ts, which owns the behavior and re-exports these),
 * from modules/app-dir-exclude and modules/history, and from the agent —
 * importing the entity from utils would close a cycle back through
 * modules/files/files.ts.
 *
 * Everything else under the app dir is invisible: hidden from the fs
 * walkers and the watcher by position rather than by name
 * (walkdir_utils.rs, adapters/browser-fs-utils.ts). App-internal files
 * therefore need no dot prefix. The user's own repo keeps all of it out
 * but the config, which is the project's and is committed
 * (`USER_REPO_EXCLUDE_LINES`).
 */
export const APP_DIR_NAME = ".notefig";
export const SCRATCHPADS_DIR_NAME = "scratchpads";
export const SCRATCHPADS_REL_PATH = `${APP_DIR_NAME}/${SCRATCHPADS_DIR_NAME}`;
/** The project's settings (`modules/project-settings`), committed with it. */
export const PROJECT_CONFIG_NAME = "config.json";
export const PROJECT_CONFIG_REL_PATH = `${APP_DIR_NAME}/${PROJECT_CONFIG_NAME}`;
/** The user repo's `info/exclude` lines: the app dir, bar the config. The
 *  `dir/*` + `!dir/child` shape is the one git idiom that re-includes
 *  inside an excluded directory; `.notefig/` would make it unreachable. */
export const USER_REPO_EXCLUDE_LINES = [`${APP_DIR_NAME}/*`, `!${PROJECT_CONFIG_REL_PATH}`];
