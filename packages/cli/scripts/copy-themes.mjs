// Copy the book theme templates into the published CLI's dist/ so a clean
// build (CI / `npm publish`) always ships them. `metrists init` reads them
// from `dist/themes/<template>` (commands/init.command.ts). The root
// `sync-themes` rsync script does the same for local dev, but the CLI's own
// build must not depend on it — a fresh checkout has no dist/themes and
// `init` would break. Pure Node (fs.cp), no rsync dependency, honoring the
// same exclusions as .rsync-exclude.
import { cp, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const SOURCE = fileURLToPath(new URL("../../themes", import.meta.url));
const DEST = fileURLToPath(new URL("../dist/themes", import.meta.url));

// Names excluded anywhere in the tree (mirrors .rsync-exclude).
const EXCLUDE = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  ".contentlayer",
  "content",
]);

await rm(DEST, { recursive: true, force: true });
await cp(SOURCE, DEST, {
  recursive: true,
  filter: (src) =>
    !src
      .split("/")
      .some((segment) => EXCLUDE.has(segment)),
});

console.log(`copied themes → ${DEST}`);
