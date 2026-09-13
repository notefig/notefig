// Vendor the private workspace packages into the published CLI. Neither is
// published, so the CLI can't bare-require them at runtime — but each is
// reached through a local barrel (`lib/shared.ts`, `lib/agent.ts`), so after
// `tsc` this step overwrites the barrel's compiled output with a
// self-contained bundle. The rest of the CLI stays plain tsc output
// (book-publishing code untouched).
//
// zod + tweetnacl stay external — they're already CLI dependencies, so the
// bundled code resolves them at runtime like any other dep.
import { build } from "esbuild";

const src = (path) => new URL(path, import.meta.url).pathname;

const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["zod", "tweetnacl"],
  logLevel: "info",
};

// @notefig/shared — consumed by the `agent` command and the worker.
await build({
  ...common,
  entryPoints: [src("../shared/src/index.ts")],
  outfile: "dist/lib/shared.js",
});

// @notefig/agent — the ACP session layer, consumed by the headless agent
// host. Bundling is not merely convenient here: the package depends on
// @zed-industries/agent-client-protocol, which is ESM-only ("type":
// "module", no `require` condition), so a CJS build that left it external
// would throw ERR_REQUIRE_ESM on every supported Node (engines: >=18.17).
// esbuild inlines it instead. zod-to-json-schema is likewise bundled — it is
// not a CLI dependency.
//
// zod is bundled here too, unlike in the shared entry above. zod-to-json-schema
// imports `zod/v3`, a subpath the CLI's pinned zod@3.23.0 does not export;
// the workspace root resolves zod@3.25.x, which does. Bundling takes that
// copy and leaves the CLI's own dependency untouched — the alternative,
// raising the CLI's pin, perturbs the lockfile for the whole workspace.
// Nothing hands zod objects across the two copies: the agent package uses zod
// only for MCP tool schemas, which this host does not register.
await build({
  ...common,
  entryPoints: [src("../agent/src/index.ts")],
  outfile: "dist/lib/agent.js",
  external: ["tweetnacl"],
});
