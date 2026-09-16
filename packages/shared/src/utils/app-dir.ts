/**
 * The app-owned directory inside a user's workspace, and the one child of it
 * that is visible.
 *
 * Lives here because more than one host needs the same answer: the desktop,
 * and the CLI when a harness's invoke hook writes under it (Devin's MCP config
 * file). The desktop's `utils/app-dir.ts` re-exports these, so its import
 * sites and its leaf-module reasoning are unchanged.
 */
export const APP_DIR_NAME = ".notefig";
export const SCRATCHPADS_DIR_NAME = "scratchpads";
export const SCRATCHPADS_REL_PATH = `${APP_DIR_NAME}/${SCRATCHPADS_DIR_NAME}`;
