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
