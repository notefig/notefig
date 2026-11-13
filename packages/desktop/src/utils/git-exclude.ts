/**
 * Managed writes to a git repo's `<gitDir>/info/exclude` — the gitdir-local,
 * never-committed cousin of `.gitignore`. Used to hide `.notefig/` (the
 * app's ephemeral-files root) from the user's own repo, and to keep the
 * history repo's worktree walk out of `.git/` and out of everything under
 * `.notefig/` bar the scratchpads. Both real git and isomorphic-git honor
 * this file.
 */
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";

/** The file reads and writes an exclude needs. */
export type ExcludeFs = Pick<FileSystemSurface, "readFiles" | "writeFiles">;

/**
 * Read `<gitDir>/info/exclude`, treating only a verifiably-missing file as
 * empty. Any other read failure (permissions, transient I/O) throws:
 * treating it as empty would rewrite the exclude with only the app's
 * entries, destroying user-authored patterns.
 */
async function readExclude(
  fs: ExcludeFs,
  excludePath: string,
): Promise<string> {
  const existing = await fs.readFiles([excludePath]);
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
  fs: ExcludeFs,
  gitDir: string,
  lines: string[],
): Promise<void> {
  const excludePath = `${gitDir}/info/exclude`;
  const current = await readExclude(fs, excludePath);

  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return;
  }

  const prefix =
    current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  await writeExclude(fs, excludePath, `${prefix}${missing.join("\n")}\n`);
}

async function writeExclude(
  fs: ExcludeFs,
  excludePath: string,
  content: string,
): Promise<void> {
  const result = await fs.writeFiles([{ path: excludePath, content }]);
  if (result.failed.length > 0) {
    throw new Error(
      `Failed to update '${excludePath}': ${result.failed[0]?.message ?? "Unknown error"}`,
    );
  }
}

/**
 * Replace the block of lines between `# >>> <name>` and `# <<< <name>`
 * (appended when absent), leaving every other line alone but those in
 * `retired` (lines an older build wrote outside a block): for entries the
 * app derives and may change.
 */
export async function setExcludeBlock(
  fs: ExcludeFs,
  gitDir: string,
  name: string,
  lines: string[],
  retired: string[] = [],
): Promise<void> {
  const excludePath = `${gitDir}/info/exclude`;
  const existing = await readExclude(fs, excludePath);
  const current = retired.length
    ? existing.split("\n").filter((line) => !retired.includes(line.trim())).join("\n")
    : existing;
  const open = `# >>> ${name}`;
  const close = `# <<< ${name}`;
  const block = [open, ...lines, close].join("\n");
  const start = current.indexOf(open);
  const end = current.indexOf(close, start);
  const next =
    start >= 0 && end >= 0
      ? `${current.slice(0, start)}${block}${current.slice(end + close.length)}`
      : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${block}\n`;
  if (next !== existing) await writeExclude(fs, excludePath, next);
}
