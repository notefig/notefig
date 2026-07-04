/**
 * Test fixture for content loading tests
 * Covers the editor mounting lifecycle: loading placeholder, small/large
 * files, new file creation, and failed content reads.
 */

const WORKSPACE_PATH = "/workspace/test-content-loading";

export const contentLoadingFixture = {
  workspacePath: WORKSPACE_PATH,

  files: [
    {
      path: `${WORKSPACE_PATH}/small-file.md`,
      content: "# Small File\n\nA short document that loads quickly.",
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/empty-file.md`,
      content: "",
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/large-loading-file.md`,
      content: generateLargeContent(3000),
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/doomed-file.md`,
      content: "# Doomed File\n\nThis file's content read will fail.",
      type: "file" as const,
    },
  ],
};

function generateLargeContent(lineCount: number): string {
  const lines: string[] = ["# Large Loading File", ""];

  for (let i = 1; i <= lineCount; i++) {
    if (i % 100 === 0) {
      lines.push(`\n## Section ${i / 100}\n`);
    } else {
      lines.push(
        `Line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
      );
    }
  }

  lines.push("LAST_LINE_MARKER");
  return lines.join("\n");
}
