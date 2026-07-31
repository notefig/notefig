/**
 * Fixture data for happy-path.spec.ts
 * Contains demo workspace with multiple files and directories
 */

const WORKSPACE_PATH = "/workspace/test-happy-path";

export const happyPathFixture = {
  demoWorkspace: {
    path: WORKSPACE_PATH,
    files: [
      {
        path: `${WORKSPACE_PATH}/README.md`,
        content: `# Demo Workspace

Welcome to Metrists! This is a sample workspace to help you get started.

## Quick Start

1. Browse files in the sidebar
2. Click any file to open it
3. Start editing - changes save automatically

## Features

- **Markdown Support**: Full markdown editing with live preview
- **Multiple Files**: Open and edit multiple files simultaneously  
- **Auto-Save**: Your changes are saved automatically
- **Offline First**: Works completely offline
`,
        type: "file" as const,
      },

      {
        path: `${WORKSPACE_PATH}/docs`,
        content: "",
        type: "directory" as const,
      },
      {
        path: `${WORKSPACE_PATH}/docs/getting-started.md`,
        content: `# Getting Started

Let's learn how to use Metrists effectively.

## Opening Files

Click any file in the sidebar to open it in the editor.

## Editing

Just start typing! Your changes are automatically saved.
`,
        type: "file" as const,
      },
      {
        path: `${WORKSPACE_PATH}/docs/features.md`,
        content: `# Features

Metrists comes with powerful features:

- Real-time markdown editing
- Tab-based file management
- Keyboard shortcuts
- Local-first architecture
`,
        type: "file" as const,
      },

      {
        path: `${WORKSPACE_PATH}/notes`,
        content: "",
        type: "directory" as const,
      },
      {
        path: `${WORKSPACE_PATH}/notes/2026-02-01.md`,
        content: `# Daily Note - February 1, 2026

## Today I Learned

- How to use Metrists for note-taking
- Markdown is a great format for notes

## Ideas

- Create a knowledge base
- Organize notes by date
`,
        type: "file" as const,
      },
      {
        path: `${WORKSPACE_PATH}/notes/2026-02-15.md`,
        content: `# Daily Note - February 15, 2026

## Meeting Notes

Project planning discussion:
- Timeline review
- Resource allocation
- Next steps
`,
        type: "file" as const,
      },

      {
        path: `${WORKSPACE_PATH}/projects`,
        content: "",
        type: "directory" as const,
      },
      {
        path: `${WORKSPACE_PATH}/projects/personal-blog.md`,
        content: `# Personal Blog Project

## Goals

- Set up static site generator
- Write first 5 posts
- Deploy to hosting platform

## Progress

- [x] Choose platform
- [ ] Design theme
- [ ] Write content
`,
        type: "file" as const,
      },
    ],
  },

  emptyWorkspace: {
    path: "/workspace/empty-happy-path",
    files: [],
  },

  testEdits: {
    simpleHeading: "# Test Heading\n\nThis is a test edit.",
    complexContent: `# Updated Document

## New Section

Here's some new content with:

- List items
- **Bold text**
- *Italic text*

\`\`\`javascript
const code = "example";
\`\`\`
`,
  },
};
