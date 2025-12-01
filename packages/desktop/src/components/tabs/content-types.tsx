/**
 * Determines if a file type should use the rich markdown editor
 */
export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
}
