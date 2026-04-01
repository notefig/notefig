// Shared file utilities

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot + 1).toLowerCase();
}

export function isMarkdownFile(filename: string): boolean {
  const ext = getExtension(filename);
  return ext === "md" || ext === "mdx" || ext === "markdown";
}
