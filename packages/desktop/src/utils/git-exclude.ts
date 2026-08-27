/**
 * Managed writes to a git repo's `<gitDir>/info/exclude` — the gitdir-local,
 * never-committed cousin of `.gitignore`. Used to hide `.metrists/` (the
 * app's ephemeral-files root) from the user's own repo, and to keep the
 * history repo's worktree walk out of `.git/` and `.metrists/`. Both real
 * git and isomorphic-git honor this file.
 */
import { platformAdapter } from "@/adapters";

/**
 * Read `<gitDir>/info/exclude`, treating only a verifiably-missing file as
 * empty. Any other read failure (permissions, transient I/O) throws:
 * treating it as empty would rewrite the exclude with only the app's
 * entries, destroying user-authored patterns.
 */
async function readExclude(excludePath: string): Promise<string> {
  const existing = await platformAdapter.fs.readFiles([excludePath]);
  const failure = existing.failed[0];
  if (failure && failure.type !== "not_found") {
    throw new Error(`Failed to read '${excludePath}': ${failure.message}`);
  }
  return existing.succeeded[0]?.content ?? "";
}

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
  const current = await readExclude(excludePath);

  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return;
  }

  const prefix =
    current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  await writeExclude(excludePath, `${prefix}${missing.join("\n")}\n`);
}

/**
 * Replace one exact line in `<gitDir>/info/exclude` with `newLines` (only
 * the ones not already present), preserving every other line. Falls back to
 * `ensureExcludeLines(gitDir, newLines)` when `oldLine` is absent, so the
 * call is idempotent. ONLY for exclude files the app itself owns (the
 * history repo's) — rewriting a user repo's exclude is never safe.
 */
export async function replaceExcludeLine(
  gitDir: string,
  oldLine: string,
  newLines: string[],
): Promise<void> {
  const excludePath = `${gitDir}/info/exclude`;
  const current = await readExclude(excludePath);
  const lines = current.length === 0 ? [] : current.split("\n");

  const oldIndex = lines.findIndex((line) => line.trim() === oldLine);
  if (oldIndex === -1) {
    return ensureExcludeLines(gitDir, newLines);
  }

  const present = new Set(lines.map((line) => line.trim()));
  const missing = newLines.filter((line) => !present.has(line));
  lines.splice(oldIndex, 1, ...missing);
  const content = lines.join("\n");
  await writeExclude(
    excludePath,
    content.length === 0 || content.endsWith("\n") ? content : `${content}\n`,
  );
}

async function writeExclude(
  excludePath: string,
  content: string,
): Promise<void> {
  const result = await platformAdapter.fs.writeFiles([
    { path: excludePath, content },
  ]);
  if (result.failed.length > 0) {
    throw new Error(
      `Failed to update '${excludePath}': ${result.failed[0]?.message ?? "Unknown error"}`,
    );
  }
}
