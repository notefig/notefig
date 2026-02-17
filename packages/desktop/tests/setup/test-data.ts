/**
 * Shared constants and utilities for test data
 *
 * NOTE: Test-specific fixtures should be defined in their corresponding
 * .fixture.ts files (e.g., workspace-navigation.fixture.ts).
 *
 * This file contains only shared constants that are used across multiple
 * test suites.
 */

/**
 * Generate large file content for performance testing
 * @param lines - Number of lines to generate
 * @returns Large markdown content string
 */
export function generateLargeFileContent(lines: number = 1000): string {
  return Array(lines)
    .fill("This is line {n} of a large test file.\n")
    .map((line, i) => line.replace("{n}", String(i + 1)))
    .join("");
}

/**
 * Common markdown snippets for reuse in fixtures
 */
export const MARKDOWN_SNIPPETS = {
  heading: (level: number, text: string) => `${"#".repeat(level)} ${text}\n\n`,
  paragraph: (text: string) => `${text}\n\n`,
  list: (items: string[]) =>
    items.map((item) => `- ${item}`).join("\n") + "\n\n",
  codeBlock: (language: string, code: string) =>
    `\`\`\`${language}\n${code}\n\`\`\`\n\n`,
};
