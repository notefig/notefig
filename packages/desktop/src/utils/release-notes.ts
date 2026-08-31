/**
 * The current version's release notes. The release workflow writes one
 * markdown file per version into `release-notes/`, and Vite injects only the
 * file matching package.json's version as `__LATEST_RELEASE_NOTES__` (see
 * vite.config.ts) — older versions stay in the repo as history but never
 * reach the bundle. No network fetch, works offline.
 *
 * The file is a self-titled document: its leading `# ` heading names the
 * release (and the tab). A headingless file gets "Release Notes v<version>"
 * prepended.
 */

const raw = __LATEST_RELEASE_NOTES__.trim();
const heading = raw.match(/^#\s+(.+)$/m);

/** The release document's own title, or null with no bundled notes. */
export const latestReleaseTitle: string | null = raw
  ? heading
    ? heading[1].trim()
    : `Release Notes v${__APP_VERSION__}`
  : null;

/** The current version's notes as markdown, "" with no bundled notes. */
export const latestReleaseMarkdown: string = raw
  ? heading
    ? raw
    : `# Release Notes v${__APP_VERSION__}\n\n${raw}`
  : "";

/**
 * The notes without their own title line, for surfaces that render the
 * title themselves (the welcome rail). "" when there are no bundled notes,
 * or when the document is nothing but its heading.
 */
export const latestReleaseBody: string = latestReleaseMarkdown
  .replace(/^#\s+.+$/m, "")
  .trim();
