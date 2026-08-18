/**
 * Seeds the marketing workspace through the public fs surface — no adapter
 * subclass, no IndexedDB access of its own. A hidden hash file records which
 * manifest version is on disk: unchanged deploys leave visitor edits alone
 * (editing the docs IS the product demo), changed deploys overwrite.
 */
import type { IPlatformAdapter } from "@/adapters";
import {
  WORKSPACE_ROOT,
  manifestHash,
  marketingPages,
} from "./content-manifest";

const HASH_FILE = `${WORKSPACE_ROOT}/.notefig-marketing-manifest`;

export async function ensureMarketingWorkspaceSeeded(
  fs: IPlatformAdapter["fs"],
): Promise<void> {
  const existing = await fs.readFiles([HASH_FILE]);
  if (existing.succeeded[0]?.content === manifestHash) {
    return;
  }

  const files = marketingPages.map((page) => ({
    path: page.filePath,
    content: page.markdown,
  }));

  const result = await fs.writeFiles(files);
  if (result.failed.length > 0) {
    throw new Error(
      `Marketing seed failed for: ${result.failed
        .map((failure) => failure.path)
        .join(", ")}`,
    );
  }

  // Written last, so a seed interrupted mid-write re-runs next boot. If only
  // the marker fails the content is still there and the site works, so this
  // does not throw — but the next load will re-seed and overwrite whatever
  // the visitor edited, which is worth saying out loud rather than swallowing.
  const marker = await fs.writeFiles([
    { path: HASH_FILE, content: manifestHash },
  ]);
  if (marker.failed.length > 0) {
    console.warn(
      `Marketing seed marker could not be written (${marker.failed[0].message}); ` +
        "the workspace will be re-seeded on the next load and in-browser edits lost.",
    );
  }
}
