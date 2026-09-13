/**
 * Local barrel over @notefig/agent, mirroring lib/shared.ts. The headless
 * agent host imports from here (not the bare package) so the production
 * build can vendor @notefig/agent into this module — it is private and
 * unpublished, and it depends on @zed-industries/agent-client-protocol,
 * which is ESM-only, so a CJS `require` of it can never work. esbuild
 * bundles that dependency in; see esbuild.config.mjs.
 *
 * Types come from the package's emitted dist/index.d.ts rather than its
 * source: this package compiles with `strict: false`, under which the
 * ToolResult<Out> discriminated union does not narrow.
 */
export * from "@notefig/agent";
