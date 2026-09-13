/**
 * Local barrel over @notefig/core, mirroring lib/shared.ts and lib/agent.ts:
 * the package is private and its exports point at ESM TypeScript source, so
 * the production build vendors it into dist/lib/core.js (see
 * esbuild.config.mjs). In dev/test this just re-exports the workspace
 * package.
 */
export * from "@notefig/core";
