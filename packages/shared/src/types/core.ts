// Shared core types between CLI and Desktop

import type { ProjectConfigV1Output } from "../config/project-config.schema";

export interface FileMetadata {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  modified?: Date;
  contentHash?: string;
}

export type ProjectConfig = ProjectConfigV1Output;

export interface ParsedContent {
  content: string;
  metadata: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
}
