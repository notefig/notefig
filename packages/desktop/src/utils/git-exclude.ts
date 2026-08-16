/**
 * Managed writes to a git repo's `<gitDir>/info/exclude` — the gitdir-local,
 * never-committed cousin of `.gitignore`. Used to hide `.metrists/` (the
 * app's ephemeral-files root) from the user's own repo, and to keep the
 * history repo's worktree walk out of `.git/` and `.metrists/`. Both real
 * git and isomorphic-git honor this file.
 */
import { platformAdapter } from "@/adapters";

/**
 * Ensure every entry in `lines` is present in `<gitDir>/info/exclude`,
 * appending only the missing ones. Existing content — including
 * user-authored patterns — is never rewritten or reordered. Creates the
 * file if it doesn't exist.
 */
export async function ensureExcludeLines(
  gitDir: string,
  lines: string[],
): Promise<void> {
  const excludePath = `${gitDir}/info/exclude`;
  const existing = await platformAdapter.fs.readFiles([excludePath]);
  const current = existing.succeeded[0]?.content ?? "";

  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return;
  }

  const prefix =
    current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  const result = await platformAdapter.fs.writeFiles([
    { path: excludePath, content: `${prefix}${missing.join("\n")}\n` },
  ]);
  if (result.failed.length > 0) {
    throw new Error(
      `Failed to update '${excludePath}': ${result.failed[0]?.message ?? "Unknown error"}`,
    );
  }
}
