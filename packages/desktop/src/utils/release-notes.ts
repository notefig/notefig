/**
 * Bundled release notes. The release workflow writes one markdown file per
 * version into `release-notes/` (committed with the version bump), so the
 * built app carries its own changelog — no network fetch, works offline.
 *
 * Each file is a self-titled document: its leading `# ` heading names the
 * release (and, for the newest version, the tab). A file without a heading
 * gets one derived from its filename (`v0.0.95.md` → "Version 0.0.95").
 */

const noteModules = import.meta.glob("../../release-notes/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface ReleaseNote {
  version: string;
  title: string;
  markdown: string;
}

function versionFromPath(path: string): string {
  const match = path.match(/v([^/]+)\.md$/);
  return match ? match[1] : path;
}

function compareVersionsDesc(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const releaseNotes: ReleaseNote[] = Object.entries(noteModules)
  .map(([path, raw]) => {
    const version = versionFromPath(path);
    const markdown = raw.trim();
    const heading = markdown.match(/^#\s+(.+)$/m);
    return heading
      ? { version, title: heading[1].trim(), markdown }
      : {
          version,
          title: `Version ${version}`,
          markdown: `# Version ${version}\n\n${markdown}`,
        };
  })
  .sort((a, b) => compareVersionsDesc(a.version, b.version));

/** The newest release's own document title, or null with no bundled notes. */
export const latestReleaseTitle: string | null = releaseNotes[0]?.title ?? null;

/** All versions' notes as one markdown document, newest first. */
export const releaseNotesMarkdown: string = releaseNotes
  .map((note) => note.markdown)
  .join("\n\n");
