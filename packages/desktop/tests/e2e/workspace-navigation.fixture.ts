/**
 * Fixture data for workspace-navigation.spec.ts
 * Contains mock files and workspaces specific to navigation testing
 */

const WORKSPACE_PATH = "/workspace/navigation-test";

export const workspaceNavigationFixture = {
  // Workspace with multiple files and a subfolder
  populatedWorkspace: {
    path: WORKSPACE_PATH,
    files: [
      {
        path: `${WORKSPACE_PATH}/README.md`,
        content: `# Demo Workspace

This is a demo workspace for testing Metrists navigation.

## Features

- File editing
- Markdown support
- Workspace navigation
`,
        type: "file" as const,
      },
      {
        path: `${WORKSPACE_PATH}/notes.md`,
        content: `# My Notes

This is a simple note file.
`,
        type: "file" as const,
      },
      {
        path: `${WORKSPACE_PATH}/subfolder`,
        content: "",
        type: "directory" as const,
      },
      {
        path: `${WORKSPACE_PATH}/subfolder/nested.md`,
        content: `# Nested File

This file is in a subdirectory.
`,
        type: "file" as const,
      },
    ],
  },

  // Empty workspace with no files
  emptyWorkspace: {
    path: "/workspace/empty-navigation-test",
    files: [],
  },
};
