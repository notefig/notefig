// Shared core types between CLI and Desktop

export interface FileMetadata {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  modified?: Date;
  contentHash?: string;
}

export interface ProjectConfig {
  name: string;
  basePath: string;
  settings: {
    textDirection?: "ltr" | "rtl";
    language?: string;
  };
}

export interface ParsedContent {
  content: string;
  metadata: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
}
