/**
 * Local barrel over @notefig/shared. The `agent` command and the worker
 * import from here (not the bare package) so the production build can vendor
 * @notefig/shared into this module — it is private/unpublished, so a
 * standalone `npm i metrists` can't resolve it. In dev/test this just
 * re-exports the workspace package; `esbuild.config.mjs` replaces the
 * compiled `dist/lib/shared.js` with a self-contained bundle at publish time.
 */
export * from "@notefig/shared";
