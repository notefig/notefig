// Bundle a sidecar (MET-210) into ONE CommonJS file that runs on a bare
// Node — the shared first half of both hosts' builds:
//   - desktop: packages/desktop/scripts/build-sidecars.mjs wraps the bundle
//     into a single-executable application beside the app binary;
//   - CLI: packages/cli/esbuild.config.mjs vendors it into dist/lib/sidecars/
//     and the worker spawns it with the CLI's own node.
//
// Usage as a script:  node sidecars/bundle.mjs <name> --out <file.cjs>
// Usage as a module:  import { bundleSidecar } from "./bundle.mjs"
//
// Each `sidecars/<name>/package.json` (tracked) pins the adapter as its one
// dependency. It is installed in isolation there (no lockfile, optional deps
// omitted so the SDK's ~200 MB native-CLI packages never download), never
// as a workspace dependency.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The one dependency of `sidecars/<name>/package.json`. */
function pinFor(name) {
  const manifest = join(here, name, "package.json");
  if (!existsSync(manifest)) throw new Error(`unknown sidecar: ${name}`);
  const deps = Object.entries(JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {});
  if (deps.length !== 1) throw new Error(`${manifest} must pin exactly one dependency`);
  const [pkg, version] = deps[0];
  return { package: pkg, version };
}

/** name → { package, version } for every sidecar folder. */
export const SIDECAR_PINS = Object.fromEntries(
  readdirSync(here, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(here, d.name, "package.json")))
    .map((d) => [d.name, pinFor(d.name)]),
);

/** Run a command to completion, inheriting stdio; throws on non-zero exit. */
export function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
}

/** Idempotent on the pinned version. */
export function ensureAdapterInstalled(name) {
  const pin = SIDECAR_PINS[name];
  if (!pin) throw new Error(`unknown sidecar: ${name}`);
  const dir = join(here, name);
  const manifest = join(dir, "node_modules", pin.package, "package.json");
  if (existsSync(manifest)) {
    const installed = JSON.parse(readFileSync(manifest, "utf8")).version;
    if (installed === pin.version) return dir;
    console.log(`[sidecars] ${name}: ${installed} → ${pin.version}`);
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(
    npm,
    ["install", "--omit=optional", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: dir, shell: process.platform === "win32" },
  );
  return dir;
}

/**
 * Bundle `sidecars/<name>/entry.mjs` + the pinned adapter into `outFile`
 * (CommonJS, one file, node builtins external). Returns the pin so callers
 * can stamp outputs.
 */
export async function bundleSidecar(name, outFile) {
  const dir = ensureAdapterInstalled(name);
  mkdirSync(dirname(outFile), { recursive: true });
  await build({
    entryPoints: [join(dir, "entry.mjs")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    // The adapter requires Node 22+; both hosts run it on such a Node.
    target: "node22",
    // Node's single-executable loader runs the bundle as CommonJS: turn the
    // adapter's `await import("node:…")` of builtins into require() so
    // nothing needs the ESM loader…
    supported: { "dynamic-import": false },
    // …and give `import.meta.url` (the SDK calls createRequire() on it at
    // module top level) a real URL: the executable's own, which in a SEA is
    // what __filename resolves to; under plain node it's the node binary,
    // and nothing resolved relative to it is ever used because the entry
    // sets CLAUDE_CODE_EXECUTABLE first.
    define: { "import.meta.url": "__notefigSidecarUrl" },
    banner: {
      js: 'const __notefigSidecarUrl = require("node:url").pathToFileURL(process.execPath).href;',
    },
    logLevel: "warning",
  });
  return SIDECAR_PINS[name];
}

// CLI form.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2);
  const outIndex = rest.indexOf("--out");
  if (!name || outIndex === -1 || !rest[outIndex + 1]) {
    console.error("usage: node sidecars/bundle.mjs <name> --out <file.cjs>");
    process.exit(2);
  }
  const pin = await bundleSidecar(name, resolve(rest[outIndex + 1]));
  console.log(`[sidecars] bundled ${name} ${pin.version} → ${rest[outIndex + 1]}`);
}
