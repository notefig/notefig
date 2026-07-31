/**
 * Test fixture for content persistence tests
 * Contains test data for auto-save, reload recovery, and edge cases
 */

const WORKSPACE_PATH = "/workspace/test-content-persistence";

export const contentPersistenceFixture = {
  workspacePath: WORKSPACE_PATH,

  files: [
    {
      path: `${WORKSPACE_PATH}/auto-save-test.md`,
      content: "# Auto-save Test\n\nInitial content for auto-save testing.",
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/large-file.md`,
      content: generateLargeContent(2000),
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/special-chars.md`,
      content: `# Special Characters Test

## Unicode Support
- Emoji: 🚀 ✨ 💻 🎉
- Arabic: مرحبا بكم
- Chinese: 你好世界
- Japanese: こんにちは
- Hebrew: שלום
- Cyrillic: Привет мир

## Special Markdown Characters
- Backticks: \`code\`
- Asterisks: *italic* **bold** ***both***
- Underscores: _italic_ __bold__
- Brackets: [link](url)
- Angle brackets: <tag>
- Pipes: | table | cells |
- Hashes: # ## ### ####

## Edge Cases
- Ampersands: AT&T, Q&A
- Quotes: "double" 'single' "curly"
- Slashes: path/to/file, http://example.com
- Backslashes: C:\\Windows\\System32
`,
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/tab-1.md`,
      content: "# Tab 1\n\nContent for concurrent editing test - Tab 1",
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/tab-2.md`,
      content: "# Tab 2\n\nContent for concurrent editing test - Tab 2",
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/tab-3.md`,
      content: "# Tab 3\n\nContent for concurrent editing test - Tab 3",
      type: "file" as const,
    },
    {
      path: `${WORKSPACE_PATH}/recovery-test.md`,
      content: "# Recovery Test\n\nInitial content before crash simulation.",
      type: "file" as const,
    },
  ],
};

function generateLargeContent(lineCount: number): string {
  const lines: string[] = ["# Large File Test", ""];

  for (let i = 1; i <= lineCount; i++) {
    if (i % 100 === 0) {
      lines.push(`\n## Section ${i / 100}\n`);
    } else if (i % 10 === 0) {
      lines.push(`### Subsection ${Math.floor(i / 10)}\n`);
    } else {
      lines.push(
        `Line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. ${i % 5 === 0 ? "**Bold text here.**" : ""} ${i % 7 === 0 ? "_Italic text here._" : ""}`,
      );
    }
  }

  return lines.join("\n");
}

export const autoSaveTestContent = {
  initial: "# Auto-save Test\n\nInitial content for auto-save testing.",
  afterEdit:
    "# Auto-save Test\n\nInitial content for auto-save testing.\n\nThis line was added to test auto-save.",
  afterMultipleEdits:
    "# Auto-save Test\n\nThis content has been edited multiple times.\n\nLine 1 of edits.\n\nLine 2 of edits.",
};

export const LARGE_FILE_LINE_COUNT = 2000;

// Matches the app's auto-save debounce.
export const AUTO_SAVE_DEBOUNCE_MS = 500;
