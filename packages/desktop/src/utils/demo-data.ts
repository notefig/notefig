/**
 * Demo data generator for browser mode
 * Creates a realistic workspace with markdown files and metrists.json
 */

export interface FileRowData {
  path: string;
  type: "file" | "directory";
  modified?: number;
  size?: number;
  contentHash: string;
  content: string;
  error?: string;
}

/**
 * Simple hash function for content
 * Not cryptographic - just for demo purposes
 */
function computeHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Generate demo workspace files
 * Returns a flat Record of files matching Rust backend format
 */
export function generateDemoFiles(): Record<string, FileRowData> {
  const now = Date.now();
  const files: Record<string, FileRowData> = {};

  // README.md
  const readmeContent = `# Welcome to Metrists

This is your demo workspace. Metrists is a local-first note-taking and file management application.

## Features

- 📁 Browse your files in a tree structure
- ✏️ Edit markdown files with live preview
- 💾 Local-first: all data stays on your device
- 🌙 Dark mode support
- 🌐 Works in browser and desktop

## Getting Started

1. Browse files in the sidebar
2. Click any file to open it
3. Start editing and your changes will be saved automatically

Happy note-taking!
`;

  files["README.md"] = {
    path: "README.md",
    type: "file",
    content: readmeContent,
    contentHash: computeHash(readmeContent),
    modified: now,
    size: readmeContent.length,
  };

  // metrists.json
  const metristsConfig = {
    workspace: {
      name: "Demo Workspace",
      created: new Date().toISOString(),
      version: "1.0.0",
    },
    settings: {
      theme: "system",
      fontSize: 14,
    },
  };
  const configContent = JSON.stringify(metristsConfig, null, 2);

  files["metrists.json"] = {
    path: "metrists.json",
    type: "file",
    content: configContent,
    contentHash: computeHash(configContent),
    modified: now,
    size: configContent.length,
  };

  // docs directory
  files["docs"] = {
    path: "docs",
    type: "directory",
    content: "",
    contentHash: "",
    modified: now,
  };

  // docs/getting-started.md
  const gettingStartedContent = `# Getting Started

Welcome to your new workspace! Here's how to get the most out of Metrists.

## Creating Notes

Simply click the "New File" button in the sidebar to create a new note. All notes are saved automatically as you type.

## Organizing Files

Use folders to organize your notes. You can create nested folder structures to keep everything organized.

## Markdown Support

Metrists supports full Markdown syntax:

- **Bold** and *italic* text
- Lists and checkboxes
- Code blocks
- Links and images

Start writing and see your formatted text come to life!
`;

  files["docs/getting-started.md"] = {
    path: "docs/getting-started.md",
    type: "file",
    content: gettingStartedContent,
    contentHash: computeHash(gettingStartedContent),
    modified: now,
    size: gettingStartedContent.length,
  };

  // docs/features.md
  const featuresContent = `# Features

## Core Features

### Local-First Architecture
All your data stays on your device. No cloud required, full privacy guaranteed.

### Markdown Editing
Write in plain text with Markdown formatting. Simple yet powerful.

### File Tree Navigation
Browse your notes with an intuitive folder structure.

### Dark Mode
Easy on the eyes with built-in dark mode support.

## Coming Soon

- [ ] Git integration
- [ ] Search across all notes
- [ ] Tags and metadata
- [ ] Export to PDF
- [ ] Backlinks and graph view

Stay tuned for updates!
`;

  files["docs/features.md"] = {
    path: "docs/features.md",
    type: "file",
    content: featuresContent,
    contentHash: computeHash(featuresContent),
    modified: now,
    size: featuresContent.length,
  };

  // notes directory
  files["notes"] = {
    path: "notes",
    type: "directory",
    content: "",
    contentHash: "",
    modified: now,
  };

  // notes/2026-02-01.md (daily note)
  const dailyNoteContent = `# 2026-02-01

## Tasks
- [x] Set up workspace
- [ ] Review documentation
- [ ] Create first project note

## Notes

Started using Metrists today. The interface is clean and responsive. Looking forward to organizing all my notes here.

## Ideas
- Could use this for project management
- Maybe integrate with task tracking
- Export functionality would be useful
`;

  files["notes/2026-02-01.md"] = {
    path: "notes/2026-02-01.md",
    type: "file",
    content: dailyNoteContent,
    contentHash: computeHash(dailyNoteContent),
    modified: now,
    size: dailyNoteContent.length,
  };

  // notes/meeting-notes.md
  const meetingNotesContent = `# Meeting Notes

## Team Sync - 2026-02-01

### Attendees
- Alice (Product)
- Bob (Engineering)
- Carol (Design)

### Agenda
1. Q1 Planning review
2. Feature priorities
3. Timeline discussion

### Key Decisions
- Prioritize local-first features
- Focus on stability before new features
- Weekly syncs going forward

### Action Items
- [ ] Alice: Draft Q1 roadmap
- [ ] Bob: Technical spec for search feature
- [ ] Carol: UI mockups for export flow
`;

  files["notes/meeting-notes.md"] = {
    path: "notes/meeting-notes.md",
    type: "file",
    content: meetingNotesContent,
    contentHash: computeHash(meetingNotesContent),
    modified: now,
    size: meetingNotesContent.length,
  };

  // notes/ideas.md
  const ideasContent = `# Ideas

Random thoughts and ideas worth capturing.

## App Ideas
- Mobile companion app
- Browser extension for web clipping
- API for automation

## Content Ideas
- Tutorial series on Markdown
- Blog post about local-first software
- Video demo of key features

## Feature Requests
- Vim keybindings
- Custom themes
- Plugin system
- Collaboration features (future)

Remember: not all ideas need to be implemented. Some are just fun to think about!
`;

  files["notes/ideas.md"] = {
    path: "notes/ideas.md",
    type: "file",
    content: ideasContent,
    contentHash: computeHash(ideasContent),
    modified: now,
    size: ideasContent.length,
  };

  // projects directory
  files["projects"] = {
    path: "projects",
    type: "directory",
    content: "",
    contentHash: "",
    modified: now,
  };

  // projects/project-alpha.md
  const projectContent = `# Project Alpha

Status: 🟢 Active

## Overview
A new initiative to improve the user onboarding experience.

## Goals
- Reduce time to first value
- Improve user retention
- Gather feedback early

## Timeline
- Week 1-2: Research and planning
- Week 3-4: Design and prototyping
- Week 5-6: Implementation
- Week 7-8: Testing and iteration

## Resources
- [Design Mockups](link)
- [Technical Spec](link)
- [Research Notes](link)

## Next Steps
1. Complete user research
2. Finalize designs
3. Begin implementation

---
Last updated: 2026-02-01
`;

  files["projects/project-alpha.md"] = {
    path: "projects/project-alpha.md",
    type: "file",
    content: projectContent,
    contentHash: computeHash(projectContent),
    modified: now,
    size: projectContent.length,
  };

  return files;
}
