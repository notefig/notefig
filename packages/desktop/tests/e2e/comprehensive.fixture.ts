/**
 * Test fixtures for comprehensive E2E tests
 */

export const e2eTestFixture = {
  workspacePath: "/workspace/e2e-test",

  files: [
    // Root level files
    {
      path: "/workspace/e2e-test/readme.md",
      content: "# E2E Test Workspace\n\nThis is the root readme file.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/file-to-edit.md",
      content: "# File to Edit\n\nInitial content for editing tests.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/file-to-delete.md",
      content: "# File to Delete\n\nThis file will be deleted.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/file-to-rename.md",
      content: "# File to Rename\n\nThis file will be renamed.",
      type: "file" as const,
    },

    // Nested structure
    {
      path: "/workspace/e2e-test/docs",
      content: "",
      type: "directory" as const,
    },
    {
      path: "/workspace/e2e-test/docs/guide.md",
      content: "# User Guide\n\nThis is a guide.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/docs/api.md",
      content: "# API Documentation\n\nAPI reference.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/docs/deep/nested",
      content: "",
      type: "directory" as const,
    },
    {
      path: "/workspace/e2e-test/docs/deep/nested/file.md",
      content: "# Deeply Nested\n\nThis file is deeply nested.",
      type: "file" as const,
    },

    // Multiple tabs test files
    {
      path: "/workspace/e2e-test/tab-a.md",
      content: "# Tab A\n\nContent for tab A.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/tab-b.md",
      content: "# Tab B\n\nContent for tab B.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/tab-c.md",
      content: "# Tab C\n\nContent for tab C.",
      type: "file" as const,
    },

    // Large file
    {
      path: "/workspace/e2e-test/large-file.md",
      content: generateLargeContent(2000),
      type: "file" as const,
    },

    // Drag and drop test files
    {
      path: "/workspace/e2e-test/source-file.md",
      content: "# Source File\n\nThis will be moved.",
      type: "file" as const,
    },
    {
      path: "/workspace/e2e-test/target-folder",
      content: "",
      type: "directory" as const,
    },

    // Watcher test file
    {
      path: "/workspace/e2e-test/watched-file.md",
      content: "# Watched File\n\nInitial content.",
      type: "file" as const,
    },
  ],
};

function generateLargeContent(lines: number): string {
  const content: string[] = ["# Large File Test", ""];
  for (let i = 1; i <= lines; i++) {
    if (i % 100 === 0) {
      content.push(`## Section ${i / 100}`);
    } else {
      content.push(`Line ${i}: Lorem ipsum dolor sit amet.`);
    }
  }
  return content.join("\n");
}

export const newFileContent = {
  name: "newly-created-file.md",
  content: "# New File\n\nCreated during E2E test.",
};

export const editContent = {
  original: "Initial content for editing tests.",
  edited:
    "Initial content for editing tests.\n\nThis line was added during the test.",
};
