// Vendor @notefig/shared into the published CLI. That package is private and
// unpublished, so the CLI can't depend on it at runtime — but only two
// first-party files use it (the `agent` command + the worker), and both
// import the local barrel `lib/shared.ts`. After `tsc`, this step overwrites
// the barrel's compiled output (dist/lib/shared.js) with a self-contained
// bundle of @notefig/shared, so nothing bare-requires it at runtime. The
// rest of the CLI stays plain tsc output (book-publishing code untouched).
//
// zod + tweetnacl stay external — they're already CLI dependencies, so the
// bundled shared code resolves them at runtime like any other dep.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleSidecar } from "../../sidecars/bundle.mjs";

const cliDir = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [new URL("../shared/src/index.ts", import.meta.url).pathname],
  outfile: "dist/lib/shared.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["zod", "tweetnacl"],
  logLevel: "info",
});

// MET-210: the Claude Code ACP adapter ships INSIDE the CLI too (same pinned
// bundle the desktop app wraps into its sidecar executable), so the
// `notefig agent` worker never reaches for npx at session start. The worker
// spawns dist/lib/sidecars/<name>.cjs with its own node (adapter needs 22+).
await bundleSidecar(
  "claude-agent-acp",
  join(cliDir, "dist", "lib", "sidecars", "claude-agent-acp.cjs"),
);
